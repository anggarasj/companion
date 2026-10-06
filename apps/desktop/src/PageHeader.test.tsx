// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@meetcc/shared/i18n'
import type { VaultNote } from '@meetcc/vault'

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => new ArrayBuffer(0))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: async () => '/Users/a/Pictures/space.JPG' }))
const { PageHeader } = await import('./PageHeader')

afterEach(() => {
  cleanup()
  invoke.mockClear()
})

const NOTE: VaultNote = { id: 'n', sessionKey: 'nota/x', platform: 'manual', updatedAt: '', title: 'halo', body: '' }

describe('PageHeader', () => {
  it('picks an emoji icon', () => {
    const onChange = vi.fn()
    render(<PageHeader note={NOTE} onChange={onChange} onError={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('desktop.page.addIcon')) }))
    fireEvent.click(screen.getByRole('button', { name: '🚀' }))
    expect(onChange).toHaveBeenCalledWith({ icon: '🚀' })
  })

  it('copies an uploaded cover into .assets and points the note at it', async () => {
    const onChange = vi.fn()
    render(<PageHeader note={NOTE} onChange={onChange} onError={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('desktop.page.addCover')) }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const rel = (onChange.mock.calls[0][0] as { cover: string }).cover
    expect(rel).toMatch(/^\.assets\/cover-[a-z0-9]+\.jpg$/)
    expect(invoke).toHaveBeenCalledWith('import_vault_asset', { src: '/Users/a/Pictures/space.JPG', rel })
  })

  it('a failed import is reported, the note unchanged', async () => {
    invoke.mockRejectedValueOnce('only images can be imported')
    const onChange = vi.fn()
    const onError = vi.fn()
    render(<PageHeader note={NOTE} onChange={onChange} onError={onError} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('desktop.page.addCover')) }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('only images can be imported'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes an existing cover and icon', () => {
    const onChange = vi.fn()
    render(<PageHeader note={{ ...NOTE, icon: '📄', cover: '.assets/c.png' }} onChange={onChange} onError={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: t('desktop.page.removeCover') }))
    expect(onChange).toHaveBeenCalledWith({ cover: undefined })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.page.changeIcon') }))
    fireEvent.click(screen.getByRole('button', { name: t('desktop.page.removeIcon') }))
    expect(onChange).toHaveBeenCalledWith({ icon: undefined })
  })
})
