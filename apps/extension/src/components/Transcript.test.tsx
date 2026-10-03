// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Shared from '@meetcc/shared'
import type { Meeting } from '@meetcc/shared'
import { t } from '@meetcc/shared/i18n'
import { ToastProvider } from '@meetcc/ui'
import { Transcript } from './Transcript'

vi.mock('@meetcc/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>()
  return {
    ...actual,
    effectiveClean: (entries: Meeting['entries']) => entries,
    loadClean: vi.fn(async () => null),
    saveClean: vi.fn(async () => undefined),
    watchStorage: vi.fn(() => () => undefined),
  }
})
vi.mock('@meetcc/meeting', () => ({ liveActions: () => [], speakerStats: () => [] }))
vi.mock('../lib/db', () => ({ db: vi.fn(async () => ({ moved: 0 })), listHighlights: vi.fn(async () => []) }))

const meeting: Meeting = {
  id: 'transcript-scope-test',
  meta: { id: 'transcript-scope-test', startedAt: '2026-10-03T09:00:00Z', lastSeenAt: '2026-10-03T09:30:00Z' },
  entries: [
    { speaker: 'Ayu', text: 'Tetap sertakan pembahasan ini.', time: '2026-10-03T09:01:00Z' },
    { speaker: 'Budi', text: 'Jangan masukkan kalimat ini.', time: '2026-10-03T09:02:00Z' },
  ],
}

function TranscriptScope() {
  const [selectedEntries, setSelectedEntries] = useState(() => new Set([0, 1]))
  const toggleEntry = (index: number, included: boolean) => {
    setSelectedEntries((current) => {
      const next = new Set(current)
      if (included) next.add(index)
      else next.delete(index)
      return next
    })
  }
  return (
    <ToastProvider>
      <Transcript
        meeting={meeting}
        live={false}
        onClear={() => undefined}
        selectedEntries={selectedEntries}
        onToggleEntry={toggleEntry}
      />
    </ToastProvider>
  )
}

afterEach(cleanup)

describe('transcript message inclusion', () => {
  it('unchecks only the selected message and updates the included count', async () => {
    const user = userEvent.setup()
    render(<TranscriptScope />)
    const ayu = screen.getByRole('checkbox', { name: /Ayu/ })
    const budi = screen.getByRole('checkbox', { name: /Budi/ })
    expect(screen.queryByRole('button', { name: 'Ayu' })).toBeNull()

    expect((ayu as HTMLInputElement).checked).toBe(true)
    expect((budi as HTMLInputElement).checked).toBe(true)
    await user.click(budi)

    expect((ayu as HTMLInputElement).checked).toBe(true)
    expect((budi as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText(t('ext.transcript.selectedEntryCount', { count: 1, total: 2 }))).toBeTruthy()
  })
})
