import type { Meeting, TimelineItem } from '@meetcc/shared'

export interface TimelineEntryMapping {
  topicByEntry: number[]
  entriesByTopic: number[][]
}

function clockMinutes(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3] ?? 0)
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  return hours * 60 + minutes + seconds / 60
}

function fallbackTopicByEntry(entryCount: number, topicCount: number): number[] {
  if (!topicCount) return new Array(entryCount).fill(-1)
  return Array.from({ length: entryCount }, (_, index) =>
    Math.min(topicCount - 1, Math.floor((index * topicCount) / entryCount)),
  )
}

function mappingFromTopicIndices(topicByEntry: number[], topicCount: number): TimelineEntryMapping {
  const entriesByTopic = Array.from({ length: topicCount }, () => [] as number[])
  for (let index = 0; index < topicByEntry.length; index++) {
    const topicIndex = topicByEntry[index]!
    if (topicIndex >= 0) entriesByTopic[topicIndex]!.push(index)
  }
  return { topicByEntry, entriesByTopic }
}

function nearestTopic(offsets: number[], elapsed: number): number {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle]! <= elapsed) low = middle + 1
    else high = middle
  }
  return Math.max(0, low - 1)
}

/** Maps each transcript line to the timeline topic whose time range contains it. */
export function timelineEntryMapping(meeting: Meeting, timeline: TimelineItem[]): TimelineEntryMapping {
  const entryCount = meeting.entries.length
  const topicCount = timeline.length
  if (!topicCount || !entryCount) {
    return mappingFromTopicIndices(fallbackTopicByEntry(entryCount, topicCount), topicCount)
  }

  const startAt = Date.parse(meeting.meta?.startedAt ?? meeting.entries[0]!.time)
  const lastEntryAt = Date.parse(meeting.entries[entryCount - 1]!.time)
  if (!Number.isFinite(startAt) || !Number.isFinite(lastEntryAt) || lastEntryAt < startAt) {
    return mappingFromTopicIndices(fallbackTopicByEntry(entryCount, topicCount), topicCount)
  }

  const start = new Date(startAt)
  const startClock = start.getHours() * 60 + start.getMinutes()
  const duration = (lastEntryAt - startAt) / 60_000
  const offsets: number[] = []
  let previous = Number.NEGATIVE_INFINITY
  for (const item of timeline) {
    const clock = clockMinutes(item.time)
    if (clock === null) {
      return mappingFromTopicIndices(fallbackTopicByEntry(entryCount, topicCount), topicCount)
    }
    let offset = clock - startClock
    if (offset < -720) offset += 1440
    if (Number.isFinite(previous) && offset < previous - 720) offset += 1440
    if (offset < previous - 5 || offset < -5 || offset > duration + 5) {
      return mappingFromTopicIndices(fallbackTopicByEntry(entryCount, topicCount), topicCount)
    }
    offsets.push(offset)
    previous = offset
  }

  const topicByEntry: number[] = []
  for (let index = 0; index < entryCount; index++) {
    const entryAt = Date.parse(meeting.entries[index]!.time)
    if (!Number.isFinite(entryAt)) {
      return mappingFromTopicIndices(fallbackTopicByEntry(entryCount, topicCount), topicCount)
    }
    topicByEntry.push(nearestTopic(offsets, (entryAt - startAt) / 60_000))
  }
  return mappingFromTopicIndices(topicByEntry, topicCount)
}

export function timelineEntryIndices(meeting: Meeting, timeline: TimelineItem[]): number[][] {
  return timelineEntryMapping(meeting, timeline).entriesByTopic
}
