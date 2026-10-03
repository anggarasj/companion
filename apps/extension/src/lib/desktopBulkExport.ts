interface TransferMessage {
  type: 'bridge-deliver-meeting'
  meetingId: string
}

interface TransferResponse {
  ok?: boolean
}

type SendMessage = (message: TransferMessage) => Promise<TransferResponse | null | undefined>

export async function deliverMeetingsToDesktop(
  meetingIds: string[],
  sendMessage: SendMessage,
): Promise<string[]> {
  const failedIds: string[] = []
  for (const meetingId of meetingIds) {
    try {
      const response = await sendMessage({ type: 'bridge-deliver-meeting', meetingId })
      if (!response?.ok) failedIds.push(meetingId)
    } catch {
      failedIds.push(meetingId)
    }
  }
  return failedIds
}
