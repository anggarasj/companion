// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@meetcc/shared/i18n'
import type { AIClient } from '@meetcc/ai'
import type { Vault, VaultNote } from '@meetcc/vault'
import { paletteResults } from './CommandPalette'

const complete = vi.fn<AIClient['complete']>()
vi.mock('./aiSettings', () => ({
  configuredClient: async () => ({ provider: 'custom', complete }),
}))
const { AIComposer } = await import('./AIComposer')

beforeEach(() => {
  complete.mockReset()
})
afterEach(cleanup)

const meeting: VaultNote = {
  id: 'm1',
  sessionKey: 'abc-defg-hij#2026-07-13T01:00',
  platform: 'google-meet',
  updatedAt: '2026-07-13T02:00:00Z',
  startedAt: '2026-07-13T01:00:00Z',
  title: 'Project Phoenix Weekly',
  body: '',
  transcript: '.transcript/m1.jsonl',
}

function fakeVault(files: Record<string, string>, notes: Record<string, VaultNote> = {}): Vault {
  return {
    io: {
      root: '/v',
      join: (...p: string[]) => p.join('/'),
      readFile: async (abs: string) => files[abs] ?? '',
    },
    readNote: async (rel: string) => notes[rel],
  } as unknown as Vault
}

function mount(props: Partial<Parameters<typeof AIComposer>[0]> & { vault: Vault }) {
  const onCreate = vi.fn(async () => {})
  render(
    <AIComposer
      folders={['Product', 'Projects/Phoenix']}
      folder="Product"
      current={null}
      notePaths={[]}
      onCreate={onCreate}
      onClose={() => {}}
      {...props}
    />,
  )
  return { onCreate }
}

describe('AIComposer', () => {
  it('writes a document from a prompt into the chosen folder', async () => {
    complete.mockResolvedValue('# PRD Passkey\n\n## Problem\n\nLogin lambat.')
    const { onCreate } = mount({ vault: fakeVault({}) })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Buat PRD passkey' } })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.generate') }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate).toHaveBeenCalledWith('PRD Passkey', '## Problem\n\nLogin lambat.', 'Product')
    // Nothing but the prompt left the machine: no scope was ticked.
    expect(complete.mock.calls[0][0].user).not.toContain('<source>')
  })

  it('generates a PRD from the open meeting through the grounded pipeline', async () => {
    complete
      .mockResolvedValueOnce('# PRD Phoenix\n\n## Problem Statement\n\nRollout [00:01]') // draft
      .mockResolvedValueOnce('TIDAK ADA MASALAH BERARTI') // critique
    const transcript = JSON.stringify({ speaker: 'Ana', text: 'Rollout ditunda', time: '2026-07-13T01:00:05Z' })
    const { onCreate } = mount({
      vault: fakeVault({ '/v/.transcript/m1.jsonl': transcript }),
      current: meeting,
      kind: 'prd',
      folder: 'Projects/Phoenix',
    })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.generate') }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    const [title, body, folder] = onCreate.mock.calls[0] as unknown as [string, string, string]
    expect(title).toBe('PRD Phoenix')
    expect(body).toContain('## Problem Statement')
    expect(folder).toBe('Projects/Phoenix')
    expect(complete.mock.calls[0][0].user).toContain('Rollout ditunda')
  })

  it('shows a provider error and creates nothing', async () => {
    complete.mockRejectedValue(new Error('Koneksi ke local LLM gagal'))
    const { onCreate } = mount({ vault: fakeVault({}) })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'RFC' } })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.generate') }))
    expect((await screen.findByRole('alert')).textContent).toContain('local LLM')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('a vault write failure is reported, not swallowed', async () => {
    complete.mockResolvedValue('# Doc\n\nBody')
    const onCreate = vi.fn(async () => {
      throw new Error('write_vault_file: permission denied')
    })
    mount({ vault: fakeVault({}), onCreate })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.generate') }))
    expect((await screen.findByRole('alert')).textContent).toContain('permission denied')
  })

  it('stop cancels and creates nothing', async () => {
    complete.mockImplementation(() => new Promise(() => {}))
    const { onCreate } = mount({ vault: fakeVault({}) })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.generate') }))
    fireEvent.click(await screen.findByRole('button', { name: t('desktop.ai.stop') }))
    expect(screen.getByRole('button', { name: t('desktop.composer.generate') })).toBeTruthy()
    expect(onCreate).not.toHaveBeenCalled()
  })
})

describe('paletteResults', () => {
  const notes = [
    { rel: 'Product/PRD.md', title: 'PRD Auth' },
    { rel: 'Rapat/2026-07-13/x.md', title: 'Weekly' },
  ]
  const commands = [{ id: 'new', label: 'New note', run: () => {} }]

  it('matches commands, titles, paths and body hits once each', () => {
    expect(paletteResults('prd', commands, notes).map((r) => r.kind)).toEqual(['note'])
    expect(paletteResults('new', commands, notes)[0].kind).toBe('command')
    const body = paletteResults('passkey', commands, notes, ['Rapat/2026-07-13/x.md', 'Rapat/2026-07-13/x.md'])
    expect(body).toHaveLength(1)
  })
})
