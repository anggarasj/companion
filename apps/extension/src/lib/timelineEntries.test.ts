import { describe, expect, it } from 'vitest'
import type { Meeting, TimelineItem } from '@meetcc/shared'
import { timelineEntryIndices } from './timelineEntries'

const startAt = '2026-10-03T15:00:00.000Z'
const startMs = Date.parse(startAt)
const entryAt = (minutes: number) => new Date(startMs + minutes * 60_000).toISOString()
const clockAt = (minutes: number) => {
  const time = new Date(startMs + minutes * 60_000)
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
}

const meeting: Meeting = {
  id: 'timeline-entry-test',
  meta: { id: 'timeline-entry-test', startedAt: startAt, lastSeenAt: entryAt(20) },
  entries: [0, 3, 8, 12, 17].map((minute, index) => ({
    speaker: `Speaker ${index}`,
    text: `Message ${index}`,
    time: entryAt(minute),
  })),
}

const timeline: TimelineItem[] = [
  { time: clockAt(0), topic: 'Opening' },
  { time: clockAt(7), topic: 'Decision' },
  { time: clockAt(15), topic: 'Follow-up' },
]

describe('timelineEntryIndices', () => {
  it('assigns messages to the time range beginning at each selected topic', () => {
    expect(timelineEntryIndices(meeting, timeline)).toEqual([[0, 1], [2, 3], [4]])
  })

  it('falls back to chronological ranges when timeline timestamps do not match the meeting', () => {
    expect(
      timelineEntryIndices(meeting, [
        { time: 'unknown', topic: 'First' },
        { time: 'unknown', topic: 'Second' },
      ]),
    ).toEqual([[0, 1, 2], [3, 4]])
  })
})
