// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@meetcc/shared/i18n'
import type { VaultNote } from '@meetcc/vault'
import { ExportModal } from './ExportModal'
import * as exportModule from './exportNote'

const sampleNote: VaultNote = {
  id: 'note-1',
  sessionKey: 'session-1',
  title: 'Interview',
  body: 'Hello world',
  updatedAt: '2026-10-05T00:00:00Z',
  platform: 'manual',
}

describe('ExportModal', () => {
  it('renders nothing when closed or note is null', () => {
    const { container: c1 } = render(
      <ExportModal open={false} onClose={vi.fn()} note={sampleNote} editor={null} />,
    )
    expect(c1.innerHTML).toBe('')

    const { container: c2 } = render(
      <ExportModal open={true} onClose={vi.fn()} note={null} editor={null} />,
    )
    expect(c2.innerHTML).toBe('')
  })

  it('renders modal with Notion-like format and option controls and exports', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const exportSpy = vi.spyOn(exportModule, 'exportNote').mockResolvedValue('/Users/a/Desktop/Interview.md')

    render(<ExportModal open={true} onClose={onClose} note={sampleNote} editor={null} />)

    expect(screen.getByRole('heading', { name: t('desktop.export.title') })).toBeTruthy()
    expect(screen.getByText(t('desktop.export.format'))).toBeTruthy()
    expect(screen.getByText(t('desktop.export.includeProperties'))).toBeTruthy()
    expect(screen.getByText(t('desktop.export.includeTitle'))).toBeTruthy()

    const exportBtn = screen.getByRole('button', { name: t('desktop.export.action') })
    await user.click(exportBtn)

    expect(exportSpy).toHaveBeenCalledWith(
      sampleNote,
      expect.any(String),
      expect.objectContaining({
        format: 'markdown',
        includeMetadata: true,
        includeTitle: true,
      }),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open when the save dialog is cancelled', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    vi.spyOn(exportModule, 'exportNote').mockResolvedValue(null)

    render(<ExportModal open={true} onClose={onClose} note={sampleNote} editor={null} />)
    await user.click(screen.getByRole('button', { name: t('desktop.export.action') }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('allows cancelling the modal', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(<ExportModal open={true} onClose={onClose} note={sampleNote} editor={null} />)

    const cancelBtn = screen.getByRole('button', { name: t('desktop.export.cancel') })
    await user.click(cancelBtn)

    expect(onClose).toHaveBeenCalled()
  })
})
