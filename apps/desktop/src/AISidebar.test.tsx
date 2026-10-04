// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { t } from '@meetcc/shared/i18n'
import { DEFAULT_SETTINGS } from '@meetcc/shared/types'
import type { AIClient } from '@meetcc/ai'
import { baseExtensions } from './editor/extensions'

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

let editor: Editor
beforeEach(() => {
  complete.mockReset()
  localStorage.clear()
  savedModel = { provider: 'openai', model: 'gpt-4o-mini' }
  editor = new Editor({ extensions: baseExtensions(), content: '# PRD\n\nIntro.', contentType: 'markdown' })
})
afterEach(() => {
  cleanup()
  editor.destroy()
})

function ask(text: string) {
  render(<AISidebar editor={editor} docTitle="PRD" onClose={() => {}} onWriteWithAI={() => {}} />)
  fireEvent.change(screen.getByPlaceholderText(t('desktop.aiPanel.placeholder')), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: t('desktop.aiPanel.send') }))
}

describe('AISidebar', () => {
  it('writes the answer into the document and reports what changed', async () => {
    complete.mockResolvedValue('{"op":"append","markdown":"## Security\\n\\n- TLS","summary":"Added a Security section."}')
    ask('Tambahkan section Security')
    await screen.findByText('Added a Security section.')
    expect(editor.getMarkdown()).toContain('## Security')
    fireEvent.click(screen.getByRole('button', { name: t('desktop.aiPanel.showChanges') }))
    expect(document.querySelector('[data-kind="add"]')?.textContent).toBeTruthy()
  })

  it('undo restores the document exactly', async () => {
    complete.mockResolvedValue('{"op":"replaceDocument","markdown":"# Other"}')
    ask('rewrite')
    await screen.findByText(t('desktop.aiPanel.applied.document'))
    expect(editor.getMarkdown().trim()).toBe('# Other')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('desktop.aiPanel.undo')) }))
    expect(editor.getMarkdown()).toBe('# PRD\n\nIntro.')
    expect(screen.getByText(t('desktop.aiPanel.undone'))).toBeTruthy()
  })

  it('will not undo over edits made afterwards', async () => {
    complete.mockResolvedValue('{"op":"append","markdown":"Added."}')
    ask('add')
    await screen.findByText(t('desktop.aiPanel.applied.append'))
    editor.commands.insertContentAt(editor.state.doc.content.size, 'typed by hand')
    const typed = editor.getMarkdown()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('desktop.aiPanel.undo')) }))
    expect(editor.getMarkdown()).toBe(typed)
    expect(screen.getByText(t('desktop.aiPanel.editedSince'))).toBeTruthy()
  })

  it('a provider error is shown and the document is untouched', async () => {
    complete.mockRejectedValue(new Error('HTTP 401: invalid key'))
    ask('anything')
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 401')
    expect(editor.getMarkdown()).toBe('# PRD\n\nIntro.')
    expect(editor.isEditable).toBe(true)
  })

  it('stop leaves the document as it was', async () => {
    complete.mockImplementation(() => new Promise(() => {}))
    ask('long job')
    fireEvent.click(await screen.findByRole('button', { name: t('desktop.ai.stop') }))
    expect(editor.isEditable).toBe(true)
    expect(editor.getMarkdown()).toBe('# PRD\n\nIntro.')
  })

  it('effort can be picked for a reasoning model behind a gateway, and it sticks', async () => {
    savedModel = { provider: 'custom', model: 'ag/gemini-3.8-flash' }
    render(<AISidebar editor={editor} docTitle="PRD" onClose={() => {}} onWriteWithAI={() => {}} />)
    const effort = await screen.findByRole('button', { name: t('desktop.aiPanel.effort') })
    expect(effort.textContent).toContain(t('desktop.aiPanel.effort.auto'))
    fireEvent.click(effort)
    fireEvent.mouseDown(await screen.findByRole('option', { name: t('desktop.aiPanel.effort.high') }))
    expect(screen.getByRole('button', { name: t('desktop.aiPanel.effort') }).textContent).toContain(t('desktop.aiPanel.effort.high'))
    expect(JSON.parse(localStorage.getItem('companion:aiSession')!).effort).toBe('high')
  })

  it('a model without an effort setting shows that instead of a dead control', async () => {
    render(<AISidebar editor={editor} docTitle="PRD" onClose={() => {}} onWriteWithAI={() => {}} />)
    expect(await screen.findByText(t('desktop.aiPanel.effortNone'))).toBeTruthy()
  })
})
