// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@meetcc/shared/i18n'

const invoke = vi.fn(async (..._a: unknown[]): Promise<unknown> => new ArrayBuffer(4))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
const { FileView } = await import('./FileView')

beforeEach(() => {
  invoke.mockClear()
  URL.createObjectURL = vi.fn(() => 'blob:pdf')
  URL.revokeObjectURL = vi.fn()
})
afterEach(cleanup)

describe('FileView', () => {
  it('shows a PDF from the vault in a frame', async () => {
    const { container } = render(<FileView rel="docs/BRD.pdf" onError={() => {}} />)
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBe('blob:pdf'))
    expect(invoke).toHaveBeenCalledWith('read_vault_bytes', { rel: 'docs/BRD.pdf' })
  })

  it('says a format is unsupported instead of trying to read it', () => {
    render(<FileView rel="docs/budget.xlsx" onError={() => {}} />)
    expect(screen.getByText(t('desktop.file.unsupported', { ext: 'XLSX' }))).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reveals the file in Finder, never opens it', () => {
    render(<FileView rel="docs/budget.xlsx" onError={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: t('desktop.file.reveal') }))
    expect(invoke).toHaveBeenCalledWith('reveal_vault_file', { rel: 'docs/budget.xlsx' })
  })
})
