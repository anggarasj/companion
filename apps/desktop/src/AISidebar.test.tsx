// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@meetcc/shared/i18n'
import { DEFAULT_SETTINGS } from '@meetcc/shared/types'
import type { AIClient } from '@meetcc/ai'
import type { ChangeTarget, Workspace } from './agent/types'

const complete = vi.fn<AIClient['complete']>()
let savedModel = { provider: 'openai', model: 'gpt-4o-mini' }
vi.mock('./aiSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiSettings')>()),
  loadAiSettings: async () => ({ ...DEFAULT_SETTINGS, apiKey: 'k', baseUrl: 'https://gw.example/v1', ...savedModel }),
  configuredClient: async () => ({ provider: 'openai', complete }),
}))
vi.mock('@meetcc/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@meetcc/ai')>()),
  listModels: async () => ['gpt-4o-mini', 'gpt-5-mini'],
}))
const { AISidebar } = await import('./AISidebar')

/** An in-memory vault: path → { title, body }. */
let files: Record<string, { title: string; body: string }>
function memoryWorkspace(): Workspace & ChangeTarget {
  return {
    current: null,
    paths: () => Object.keys(files),
    files: () => [],
    readFile: async () => null,
    search: (q) =>
      Object.entries(files)
        .filter(([, n]) => n.body.toLowerCase().includes(q.toLowerCase()))
        .map(([path, n]) => ({ path, title: n.title, updatedAt: '' })),
    read: async (p) => files[p] ?? null,
    readBody: async (p) => files[p]?.body ?? null,
    writeBody: async (p, body) => {
      files[p] = { ...files[p], body }
      return body
    },
    create: async (p, title, body) => {
      files[p] = { title, body }
      return body
    },
    remove: async (p) => {
      delete files[p]
    },
  }
}

const reply = (v: object) => JSON.stringify(v)
const read = (path: string) => reply({ type: 'tool_calls', calls: [{ tool: 'read_note', args: { path } }] })

let onOpen: ReturnType<typeof vi.fn<(path: string) => void>>
let onChanged: ReturnType<typeof vi.fn<(removed: string[]) => void>>
beforeEach(() => {
  complete.mockReset()
  localStorage.clear()
  savedModel = { provider: 'openai', model: 'gpt-4o-mini' }
  files = {
    'arch/auth.md': { title: 'Auth', body: 'We use JWT-only authentication.' },
    'prd/login.md': { title: 'Login PRD', body: 'Login with JWT-only.' },
  }
  onOpen = vi.fn<(path: string) => void>()
  onChanged = vi.fn<(removed: string[]) => void>()
})
afterEach(cleanup)

function mount() {
  render(
    <AISidebar
      hasDocument={false}
      folder=""
      workspace={memoryWorkspace}
      onOpen={onOpen}
      onChanged={onChanged}
      onClose={() => {}}
      onWriteWithAI={() => {}}
    />,
  )
}

function ask(text: string) {
  fireEvent.change(screen.getByPlaceholderText(t('desktop.aiPanel.placeholder')), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: t('desktop.aiPanel.send') }))
}

describe('AISidebar', () => {
  it('answers a question with clickable sources and changes nothing', async () => {
    complete
      .mockResolvedValueOnce(read('arch/auth.md'))
      .mockResolvedValueOnce(reply({ type: 'final', answer: 'Auth is JWT-only today.', sources: ['arch/auth.md'] }))
    mount()
    ask('Apa yang kita putuskan soal authentication?')
    await screen.findByText('Auth is JWT-only today.')
    fireEvent.click(screen.getByRole('button', { name: 'Auth' }))
    expect(onOpen).toHaveBeenCalledWith('arch/auth.md')
    expect(files['arch/auth.md'].body).toBe('We use JWT-only authentication.')
    expect(screen.queryByRole('button', { name: new RegExp(t('desktop.aiPanel.apply')) })).toBeNull()
  })

  it('renders the answer as markdown, with raw HTML kept as text', async () => {
    complete.mockResolvedValueOnce(
      reply({ type: 'final', answer: '### Status\n\n- **GAP 2**: blocker\n- `Helper_Engine` B8\n\n<img src=x onerror=alert(1)>' }),
    )
    mount()
    ask('review folder kalkulator')
    const heading = await screen.findByRole('heading', { name: 'Status' })
    const answer = heading.parentElement!
    expect(answer.querySelectorAll('li')).toHaveLength(2)
    expect(answer.querySelector('strong')?.textContent).toBe('GAP 2')
    expect(answer.querySelector('code')?.textContent).toBe('Helper_Engine')
    expect(answer.textContent).not.toContain('**')
    expect(answer.querySelector('img')).toBeNull()
    expect(answer.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('stages a multi-file change: nothing is written before Apply, Apply all writes, Undo restores', async () => {
    complete
      .mockResolvedValueOnce(reply({ type: 'tool_calls', calls: [{ tool: 'read_note', args: { path: 'arch/auth.md' } }, { tool: 'read_note', args: { path: 'prd/login.md' } }] }))
      .mockResolvedValueOnce(
        reply({
          type: 'final',
          summary: 'Mention OIDC.',
          changes: [
            { type: 'replace_text', path: 'arch/auth.md', oldText: 'JWT-only authentication', newText: 'OIDC authentication' },
            { type: 'replace_text', path: 'prd/login.md', oldText: 'JWT-only', newText: 'OIDC' },
          ],
        }),
      )
    mount()
    ask('Update semua dokumen yang masih JWT-only')
    await screen.findByText('Mention OIDC.')
    expect(screen.getByText(t('desktop.aiPanel.proposes', { count: 2, files: 2 }))).toBeTruthy()
    expect(files['arch/auth.md'].body).toBe('We use JWT-only authentication.')

    fireEvent.click(screen.getAllByRole('button', { name: t('desktop.aiPanel.showChanges') })[0])
    expect(document.querySelector('[data-kind="add"]')?.textContent).toContain('OIDC authentication')

    fireEvent.click(screen.getByRole('button', { name: t('desktop.aiPanel.applyAll', { count: 2 }) }))
    await waitFor(() => expect(files['prd/login.md'].body).toBe('Login with OIDC.'))
    expect(files['arch/auth.md'].body).toBe('We use OIDC authentication.')
    expect(onChanged).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('desktop.aiPanel.undo')) }))
    await waitFor(() => expect(files['arch/auth.md'].body).toBe('We use JWT-only authentication.'))
    expect(files['prd/login.md'].body).toBe('Login with JWT-only.')
  })

  it('a rejected change writes nothing; an accepted one beside it still applies', async () => {
    complete
      .mockResolvedValueOnce(reply({ type: 'tool_calls', calls: [{ tool: 'read_note', args: { path: 'arch/auth.md' } }, { tool: 'read_note', args: { path: 'prd/login.md' } }] }))
      .mockResolvedValueOnce(
        reply({
          type: 'final',
          changes: [
            { type: 'replace_text', path: 'arch/auth.md', oldText: 'JWT-only', newText: 'OIDC' },
            { type: 'replace_text', path: 'prd/login.md', oldText: 'JWT-only', newText: 'OIDC' },
          ],
        }),
      )
    mount()
    ask('update')
    await screen.findByText(t('desktop.aiPanel.proposes', { count: 2, files: 2 }))
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(t('desktop.aiPanel.reject')) })[0])
    fireEvent.click(screen.getByRole('button', { name: t('desktop.aiPanel.apply') }))
    await waitFor(() => expect(files['prd/login.md'].body).toBe('Login with OIDC.'))
    expect(files['arch/auth.md'].body).toBe('We use JWT-only authentication.')
    expect(screen.getByText(t('desktop.aiPanel.status.rejected'))).toBeTruthy()
  })

  it('a note edited after the AI read it is not overwritten', async () => {
    complete
      .mockResolvedValueOnce(read('arch/auth.md'))
      .mockResolvedValueOnce(reply({ type: 'final', changes: [{ type: 'replace_body', path: 'arch/auth.md', body: 'All new.' }] }))
    mount()
    ask('rewrite auth')
    await screen.findByText(t('desktop.aiPanel.proposes', { count: 1, files: 1 }))
    files['arch/auth.md'].body = 'Typed by hand meanwhile.'
    fireEvent.click(screen.getByRole('button', { name: t('desktop.aiPanel.apply') }))
    await screen.findByText(t('desktop.aiPanel.status.stale'))
    expect(files['arch/auth.md'].body).toBe('Typed by hand meanwhile.')
  })

  it('review findings are shown, and "Fix selected" asks for changes to the chosen ones', async () => {
    complete
      .mockResolvedValueOnce(read('prd/login.md'))
      .mockResolvedValueOnce(
        reply({
          type: 'final',
          answer: 'One issue.',
          findings: [{ severity: 'warning', title: 'No acceptance criteria', explanation: 'Login has none.', sources: [{ path: 'prd/login.md' }] }],
        }),
      )
      .mockResolvedValueOnce(reply({ type: 'final', answer: 'Nothing to fix after all.' }))
    mount()
    ask('Review PRD ini')
    await screen.findByText('No acceptance criteria')
    expect(files['prd/login.md'].body).toBe('Login with JWT-only.')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('desktop.aiPanel.fixSelected')) }))
    await screen.findByText('Nothing to fix after all.')
    expect(screen.getByText(t('desktop.aiPanel.fixRequest', { count: 1 }))).toBeTruthy()
    expect(complete.mock.calls[2][0].user).toContain('No acceptance criteria')
  })

  it('remembers earlier turns for a follow-up', async () => {
    complete
      .mockResolvedValueOnce(read('arch/auth.md'))
      .mockResolvedValueOnce(reply({ type: 'final', answer: 'Found it.', sources: ['arch/auth.md'] }))
      .mockResolvedValueOnce(reply({ type: 'final', answer: 'Opening.', open: 'arch/auth.md' }))
    mount()
    ask('Cari pembahasan auth')
    await screen.findByText('Found it.')
    ask('Yang pertama buka')
    await screen.findByText('Opening.')
    expect(complete.mock.calls[2][0].user).toContain('"n":1,"path":"arch/auth.md"')
    expect(onOpen).toHaveBeenCalledWith('arch/auth.md')
  })

  it('a provider error is shown and nothing is written', async () => {
    complete.mockRejectedValue(new Error('HTTP 401: invalid key'))
    mount()
    ask('anything')
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 401')
    expect(files['arch/auth.md'].body).toBe('We use JWT-only authentication.')
  })

  it('stop ends the run', async () => {
    complete.mockImplementation(() => new Promise(() => {}))
    mount()
    ask('long job')
    fireEvent.click(await screen.findByRole('button', { name: t('desktop.ai.stop') }))
    expect(screen.getByRole('button', { name: t('desktop.aiPanel.send') })).toBeTruthy()
  })

  it('effort can be picked for a reasoning model behind a gateway, and it sticks', async () => {
    savedModel = { provider: 'custom', model: 'ag/gemini-3.8-flash' }
    mount()
    const effort = await screen.findByRole('button', { name: t('desktop.aiPanel.effort') })
    expect(effort.textContent).toContain(t('desktop.aiPanel.effort.auto'))
    fireEvent.click(effort)
    fireEvent.mouseDown(await screen.findByRole('option', { name: t('desktop.aiPanel.effort.high') }))
    expect(screen.getByRole('button', { name: t('desktop.aiPanel.effort') }).textContent).toContain(t('desktop.aiPanel.effort.high'))
    expect(JSON.parse(localStorage.getItem('companion:aiSession')!).effort).toBe('high')
  })

  it('a model without an effort setting shows that instead of a dead control', async () => {
    mount()
    expect(await screen.findByText(t('desktop.aiPanel.effortNone'))).toBeTruthy()
  })
})
