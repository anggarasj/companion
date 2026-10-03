import { useCallback, useMemo, useState } from 'react'
import type { TimelineItem } from '@meetcc/shared'

interface TimelineSelection {
  meetingId: string
  selected: Set<string>
  seen: Set<string>
}

export function useTimelineScope(meetingId: string, timeline: TimelineItem[]) {
  const timelineIds = useMemo(() => {
    const occurrences = new Map<string, number>()
    return timeline.map((item) => {
      const identity = item.time ? `time:${item.time}` : `topic:${item.topic}`
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      return `${identity}\u0000${occurrence}`
    })
  }, [timeline])

  const [selection, setSelection] = useState<TimelineSelection>(() => ({
    meetingId,
    selected: new Set(timelineIds),
    seen: new Set(timelineIds),
  }))
  const sameMeeting = selection.meetingId === meetingId
  const selectedTimeline = useMemo(
    () =>
      new Set(
        timelineIds.flatMap((id, index) =>
          !sameMeeting || !selection.seen.has(id) || selection.selected.has(id) ? [index] : [],
        ),
      ),
    [sameMeeting, timelineIds, selection],
  )

  const toggleTimeline = useCallback(
    (index: number, checked: boolean): void => {
      setSelection((current) => {
        const selected = current.meetingId === meetingId ? new Set(current.selected) : new Set(timelineIds)
        const seen = current.meetingId === meetingId ? new Set(current.seen) : new Set(timelineIds)
        for (const id of timelineIds) {
          if (!seen.has(id)) selected.add(id)
          seen.add(id)
        }
        const id = timelineIds[index]
        if (id === undefined) return current
        if (checked) selected.add(id)
        else selected.delete(id)
        if (timeline.length && !timelineIds.some((currentId) => selected.has(currentId))) return current
        return { meetingId, selected, seen }
      })
    },
    [meetingId, timeline.length, timelineIds],
  )

  return { selectedTimeline, toggleTimeline }
}
