// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { Meeting, TimelineItem } from '@meetcc/shared'
import { useGenerationScope } from './generationScope'
import { TimelineScopeList } from '../components/TimelineScopeList'

const startedAt = '2026-10-03T15:00:00.000Z'
const startMs = Date.parse(startedAt)
const atMinute = (minute: number) => new Date(startMs + minute * 60_000).toISOString()
const clockAt = (minute: number) => {
  const time = new Date(startMs + minute * 60_000)
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
}

const meeting: Meeting = {
  id: 'scope-sync-test',
  meta: { id: 'scope-sync-test', startedAt, lastSeenAt: atMinute(15) },
  entries: [0, 3, 8, 12].map((minute, index) => ({
    speaker: `Speaker ${index}`,
    text: `Message ${index}`,
    time: atMinute(minute),
  })),
}
const timeline: TimelineItem[] = [
  { time: clockAt(0), topic: 'Pembukaan' },
  { time: clockAt(7), topic: 'Keputusan' },
]

function ScopeControls() {
  const scope = useGenerationScope(meeting, timeline)
  return (
    <>
      <TimelineScopeList
        timeline={timeline}
        selected={scope.selectedTimeline}
        indeterminate={scope.indeterminateTimeline}
        disabled={false}
        onToggle={scope.toggleTimeline}
      />
      {meeting.entries.map((entry, index) => (
        <label key={entry.id ?? index}>
          <input
            type="checkbox"
            aria-label={`Include ${entry.speaker}`}
            checked={scope.selectedEntries.has(index)}
            onChange={(event) => scope.toggleEntry(index, event.target.checked)}
          />
          {entry.text}
        </label>
      ))}
    </>
  )
}

afterEach(cleanup)

describe('meeting generation scope', () => {
  it('unchecking a topic excludes its transcript range and rechecking restores it', async () => {
    const user = userEvent.setup()
    render(<ScopeControls />)

    const opening = screen.getByRole('checkbox', { name: /Pembukaan/ }) as HTMLInputElement
    const first = screen.getByRole('checkbox', { name: 'Include Speaker 0' }) as HTMLInputElement
    const second = screen.getByRole('checkbox', { name: 'Include Speaker 1' }) as HTMLInputElement
    const decision = screen.getByRole('checkbox', { name: 'Include Speaker 2' }) as HTMLInputElement

    await user.click(opening)
    expect(opening.checked).toBe(false)
    expect(first.checked).toBe(false)
    expect(second.checked).toBe(false)
    expect(decision.checked).toBe(true)

    await user.click(opening)
    expect(opening.checked).toBe(true)
    expect(first.checked).toBe(true)
    expect(second.checked).toBe(true)
  })

  it('marks a topic as partial when individual transcript messages are excluded', async () => {
    const user = userEvent.setup()
    render(<ScopeControls />)
    const opening = screen.getByRole('checkbox', { name: /Pembukaan/ }) as HTMLInputElement

    await user.click(screen.getByRole('checkbox', { name: 'Include Speaker 0' }))
    expect(opening.checked).toBe(true)
    expect(opening.indeterminate).toBe(true)

    await user.click(screen.getByRole('checkbox', { name: 'Include Speaker 1' }))
    expect(opening.checked).toBe(false)
    expect(opening.indeterminate).toBe(false)
  })
})
