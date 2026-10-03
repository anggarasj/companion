import { useCallback, useMemo, useState } from 'react'
import type { Meeting, TimelineItem } from '@meetcc/shared'
import type { TimelineEntryMapping } from './timelineEntries'
import { useTimelineScope } from './timelineScope'
import { timelineEntryMapping } from './timelineEntries'

const EMPTY_EXCLUSIONS = new Set<number>()

export function useGenerationScope(meeting: Meeting | null, timeline: TimelineItem[]) {
  const { selectedTimeline: requestedTimeline, toggleTimeline: toggleRequestedTimeline } =
    useTimelineScope(meeting?.id ?? '', timeline)
  const [excludedByMeeting, setExcludedByMeeting] = useState<Record<string, Set<number>>>({})
  const excludedEntries = meeting ? excludedByMeeting[meeting.id] ?? EMPTY_EXCLUSIONS : EMPTY_EXCLUSIONS
  const mapping = useMemo<TimelineEntryMapping>(
    () =>
      meeting
        ? timelineEntryMapping(meeting, timeline)
        : { topicByEntry: [], entriesByTopic: timeline.map(() => []) },
    [meeting, timeline],
  )
  const selectedEntries = useMemo(
    () =>
      new Set(
        meeting
          ? meeting.entries.flatMap((_, index) => (excludedEntries.has(index) ? [] : [index]))
          : [],
      ),
    [meeting, excludedEntries],
  )
  const { selectedTimeline, indeterminateTimeline } = useMemo(() => {
    const selected = new Set(requestedTimeline)
    const indeterminate = new Set<number>()
    const includedByTopic = new Array(mapping.entriesByTopic.length).fill(0) as number[]
    for (let index = 0; index < mapping.topicByEntry.length; index++) {
      const topic = mapping.topicByEntry[index]!
      if (topic >= 0 && !excludedEntries.has(index)) includedByTopic[topic]++
    }
    for (let topic = 0; topic < mapping.entriesByTopic.length; topic++) {
      const total = mapping.entriesByTopic[topic]!.length
      if (!total) continue
      const included = includedByTopic[topic]!
      if (!included) selected.delete(topic)
      else {
        selected.add(topic)
        if (included < total) indeterminate.add(topic)
      }
    }
    return { selectedTimeline: selected, indeterminateTimeline: indeterminate }
  }, [requestedTimeline, mapping, excludedEntries])

  const setEntryExclusions = useCallback(
    (indices: number[], exclude: boolean): void => {
      if (!meeting || !indices.length) return
      setExcludedByMeeting((current) => {
        const nextExcluded = new Set(current[meeting.id] ?? [])
        for (const index of indices) {
          if (exclude) nextExcluded.add(index)
          else nextExcluded.delete(index)
        }
        const next = { ...current }
        if (nextExcluded.size) next[meeting.id] = nextExcluded
        else delete next[meeting.id]
        return next
      })
    },
    [meeting],
  )

  const toggleEntry = useCallback(
    (index: number, included: boolean): void => {
      if (!meeting || index < 0 || index >= meeting.entries.length) return
      setEntryExclusions([index], !included)
    },
    [meeting, setEntryExclusions],
  )

  const toggleTimeline = useCallback(
    (index: number, checked: boolean): void => {
      if (!checked && selectedTimeline.size === 1 && selectedTimeline.has(index)) return
      toggleRequestedTimeline(index, checked)
      setEntryExclusions(mapping.entriesByTopic[index] ?? [], !checked)
    },
    [mapping, selectedTimeline, setEntryExclusions, toggleRequestedTimeline],
  )

  return {
    excludedEntries,
    selectedEntries,
    selectedTimeline,
    indeterminateTimeline,
    toggleEntry,
    toggleTimeline,
  }
}
