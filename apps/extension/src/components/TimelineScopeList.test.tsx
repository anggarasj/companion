// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { useTimelineScope } from '../lib/timelineScope'
import { TimelineScopeList } from './TimelineScopeList'

const timeline = [
  { time: '00:02', topic: 'Anggaran' },
  { time: '00:05', topic: 'Vendor' },
]

function SharedScope() {
  const { selectedTimeline, toggleTimeline } = useTimelineScope('meeting-1', timeline)
  return (
    <>
      <TimelineScopeList
        timeline={timeline}
        selected={selectedTimeline}
        disabled={false}
        onToggle={toggleTimeline}
      />
      <TimelineScopeList
        timeline={timeline}
        selected={selectedTimeline}
        disabled={false}
        onToggle={toggleTimeline}
      />
    </>
  )
}

afterEach(cleanup)

describe('shared timeline scope', () => {
  it('keeps transcript and document range checkboxes synchronized', async () => {
    const user = userEvent.setup()
    render(<SharedScope />)

    const vendor = screen.getAllByRole('checkbox', { name: /00:05 Vendor/ })
    expect((vendor[0] as HTMLInputElement).checked).toBe(true)
    expect((vendor[1] as HTMLInputElement).checked).toBe(true)

    await user.click(vendor[0]!)

    expect((vendor[0] as HTMLInputElement).checked).toBe(false)
    expect((vendor[1] as HTMLInputElement).checked).toBe(false)
  })
})
