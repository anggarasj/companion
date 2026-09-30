// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Vault, VaultNote } from '@meetcc/vault'
import { ToastProvider } from '@meetcc/ui'
import { t } from '@meetcc/shared/i18n'
import { MeetingMeta } from './MeetingMeta'
import { loadAiSettings } from './aiSettings'
import type { AskResult } from '@meetcc/shared/types'
import { askMeeting } from '@meetcc/ai'

vi.mock('./aiSettings', () => ({ loadAiSettings: vi.fn(async () => ({ provider: 'openai' })) }))
vi.mock('@meetcc/ai', () => ({
  MAX_HISTORY_TURNS: 8,
  askMeeting: vi.fn(async () => ({
    answer: 'Diputuskan untuk melanjutkan.',
    answerability: 'explicit',
    intent: 'recall',
    confidence: 0.9,
    evidence: [{ entryIds: ['E1'], startTime: '2026-09-28T10:02:00Z', endTime: '2026-09-28T10:02:00Z', speakers: ['Rani'], preview: 'Kita lanjut minggu depan.' }],
    missing: [],
    followUps: [],
  })),
  createClient: vi.fn(() => ({ provider: 'openai', complete: vi.fn() })),
  resolveConfig: vi.fn((settings) => settings),
  validateSettings: vi.fn(() => null),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const lines = [
  { speaker: 'Rani', text: 'Kita lanjut minggu depan.', time: '2026-09-28T10:02:00Z' },
]
const note = {
  id: 'note-id',
  sessionKey: 'meeting#2026-09-28T10:00',
  platform: 'google-meet',
  startedAt: '2026-09-28T10:00:00Z',
  participants: ['Rani'],
  transcript: '.transcript/note-id.jsonl',
} as VaultNote
const vault = {
  io: {
    root: '/vault',
    join: (...parts: string[]) => parts.join('/'),
    readFile: vi.fn(async () => JSON.stringify(lines[0])),
  },
} as unknown as Vault

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('desktop meeting AI', () => {
  it('answers from the loaded transcript and shows verified source evidence', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <MeetingMeta note={note} vault={vault} />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('button', { name: t('desktop.meeting.showTranscript') }))
    await user.type(await screen.findByRole('textbox', { name: t('desktop.meeting.askQuestion') }), 'Apa keputusan rapat?')
    await user.click(screen.getByRole('button', { name: t('desktop.meeting.ask') }))

    expect(await screen.findByText('Diputuskan untuk melanjutkan.')).toBeTruthy()
    expect(screen.getByText(/10:02 · Rani — Kita lanjut minggu depan/)).toBeTruthy()
    expect(loadAiSettings).toHaveBeenCalledOnce()
    expect(askMeeting).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entries: lines }),
      null,
      [],
      'Apa keputusan rapat?',
    )
  })

  it('ignores a transcript read that finishes after switching meetings', async () => {
    const user = userEvent.setup()
    const pendingRead = deferred<string>()
    vi.mocked(vault.io.readFile).mockReturnValueOnce(pendingRead.promise)
    const { rerender } = render(
      <ToastProvider>
        <MeetingMeta note={note} vault={vault} />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('button', { name: t('desktop.meeting.showTranscript') }))
    rerender(
      <ToastProvider>
        <MeetingMeta note={{ ...note, id: 'note-b', sessionKey: 'other#2026-09-28T10:00' }} vault={vault} />
      </ToastProvider>,
    )
    await act(async () => pendingRead.resolve(JSON.stringify({ ...lines[0], text: 'A-only transcript' })))

    expect(screen.queryByText('A-only transcript')).toBeNull()
    expect(screen.queryByText('Kita lanjut minggu depan.')).toBeNull()
  })

  it('ignores an AI answer that finishes after switching meetings', async () => {
    const user = userEvent.setup()
    const pendingAnswer = deferred<AskResult>()
    vi.mocked(askMeeting).mockReturnValueOnce(pendingAnswer.promise)
    const { rerender } = render(
      <ToastProvider>
        <MeetingMeta note={note} vault={vault} />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('button', { name: t('desktop.meeting.showTranscript') }))
    await user.type(await screen.findByRole('textbox', { name: t('desktop.meeting.askQuestion') }), 'Question for A')
    await user.click(screen.getByRole('button', { name: t('desktop.meeting.ask') }))
    rerender(
      <ToastProvider>
        <MeetingMeta note={{ ...note, id: 'note-b', sessionKey: 'other#2026-09-28T10:00' }} vault={vault} />
      </ToastProvider>,
    )
    await act(async () => pendingAnswer.resolve({
      answer: 'A-only answer',
      answerability: 'explicit',
      intent: 'recall',
      confidence: 0.9,
      evidence: [],
      missing: [],
      followUps: [],
    }))

    expect(screen.queryByText('A-only answer')).toBeNull()
    expect(screen.queryByText('Question for A')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
