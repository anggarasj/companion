// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@meetcc/shared/i18n'
import type { AIClient } from '@meetcc/ai'
import type { Vault, VaultNote } from '@meetcc/vault'
import type { Workspace } from './agent/types'
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

/** Notes the agent can find: two in Product, one elsewhere. */
const notes: Record<string, { title: string; body: string }> = {
  'Product/auth.md': { title: 'Auth architecture', body: 'OIDC via a managed provider.' },
  'Product/roadmap.md': { title: 'Roadmap', body: 'Q4 items.' },
  'Other/auth-old.md': { title: 'Old auth', body: 'JWT-only, superseded.' },
}
const workspace = (): Workspace => ({
  current: null,
  paths: () => Object.keys(notes),
  files: () => [],
  readFile: async () => null,
  search: (q) => Object.entries(notes).filter(([, n]) => `${n.title} ${n.body}`.toLowerCase().includes(q.toLowerCase())).map(([path, n]) => ({ path, title: n.title, updatedAt: '' })),
  read: async (p) => notes[p] ?? null,
})

function mount(props: Partial<Parameters<typeof AIComposer>[0]> & { vault: Vault }) {
  const onCreate = vi.fn(async () => {})
  render(
    <AIComposer
      folders={['Product', 'Projects/Phoenix']}
      folder="Product"
      current={null}
      notePaths={Object.keys(notes)}
      workspace={workspace}
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
    fireEvent.click(screen.getByRole('checkbox', { name: t('desktop.composer.autoFind') }))
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
    fireEvent.click(screen.getByRole('checkbox', { name: t('desktop.composer.autoFind') }))
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

describe('AIComposer auto context', () => {
  const call = (tool: string, args: object) => JSON.stringify({ type: 'tool_calls', calls: [{ tool, args }] })

  it('finds relevant notes in the target folder, grounds the document in them, and shows them before saving', async () => {
    complete
      .mockResolvedValueOnce(call('search_vault', { query: 'auth' }))
      .mockResolvedValueOnce(call('read_note', { path: 'Product/auth.md' }))
      .mockResolvedValueOnce(JSON.stringify({ type: 'final', answer: 'Found one.', sources: ['Product/auth.md'] }))
      .mockResolvedValueOnce('# Auth SDD\n\n## Overview\n\nOIDC.') // draft
      .mockResolvedValueOnce('NO ISSUES') // critique
    const { onCreate } = mount({ vault: fakeVault({}) })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'SDD authentication' } })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.generate') }))
    await screen.findByText(t('desktop.composer.sourcesUsed', { count: 1 }))
    expect(screen.getByText('Product/auth.md')).toBeTruthy()
    expect(onCreate).not.toHaveBeenCalled()
    // The search stayed inside the target folder.
    expect(complete.mock.calls[1][0].user).not.toContain('Other/auth-old.md')
    // The draft was written from the note the agent read.
    expect(complete.mock.calls[3][0].user).toContain('OIDC via a managed provider.')
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.create') }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    const [title, body, folder] = onCreate.mock.calls[0] as unknown as [string, string, string]
    expect(title).toBe('Auth SDD')
    expect(body).toContain('- `Product/auth.md`')
    expect(folder).toBe('Product')
  })

  it('picked files are used exactly, with no search', async () => {
    complete.mockResolvedValueOnce('# Doc\n\nBody').mockResolvedValueOnce('NO ISSUES')
    const vault = fakeVault({}, { 'Other/auth-old.md': { ...meeting, platform: 'manual', title: 'Old auth', body: 'JWT-only, superseded.' } })
    mount({ vault })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.scope') }))
    fireEvent.mouseDown(await screen.findByRole('option', { name: t('desktop.composer.scope.files') }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other/auth-old.md' }))
    fireEvent.change(screen.getByPlaceholderText(t('desktop.composer.promptPlaceholder')), { target: { value: 'compare' } })
    fireEvent.click(screen.getByRole('button', { name: t('desktop.composer.generate') }))
    await screen.findByText(t('desktop.composer.sourcesUsed', { count: 1 }))
    expect(complete.mock.calls[0][0].user).toContain('JWT-only, superseded.')
    expect(complete.mock.calls[0][0].json).toBeUndefined() // no agent step ran
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
