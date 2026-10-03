import { describe, expect, it, vi } from 'vitest'
import { deliverMeetingsToDesktop } from './desktopBulkExport'

describe('deliverMeetingsToDesktop', () => {
  it('continues in selection order and returns only meetings the desktop did not accept', async () => {
    const order: string[] = []
    const sendMessage = vi.fn(async ({ meetingId }: { meetingId: string }) => {
      order.push(meetingId)
      if (meetingId === 'meeting-2') throw new Error('native host unavailable')
      return { ok: meetingId !== 'meeting-3' }
    })

    const failed = await deliverMeetingsToDesktop(
      ['meeting-1', 'meeting-2', 'meeting-3', 'meeting-4'],
      sendMessage,
    )

    expect(order).toEqual(['meeting-1', 'meeting-2', 'meeting-3', 'meeting-4'])
    expect(failed).toEqual(['meeting-2', 'meeting-3'])
  })
})
