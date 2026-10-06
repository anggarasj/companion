// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { t } from '@meetcc/shared/i18n'
import type { AIClient } from '@meetcc/ai'

const complete = vi.fn<AIClient['complete']>()
vi.mock('./aiSettings', () => ({
  configuredClient: async () => ({ provider: 'custom', complete }),
}))

const { NoteEditor } = await import('./NoteEditor')

// ProseMirror measures layout jsdom does not have.
beforeEach(() => {
  complete.mockReset()
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  document.elementFromPoint = () => null
})
afterEach(cleanup)

function mount(value: string) {
  const onChange = vi.fn<(md: string) => void>()
  const onWriteWithAI = vi.fn()
  const view = render(<NoteEditor value={value} onChange={onChange} onWriteWithAI={onWriteWithAI} />)
  const dom = view.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }
  return { editor: dom.editor, onChange, onWriteWithAI, dom }
}

/** Select the first occurrence of `text` in the document. */
function select(editor: Editor, text: string) {
  let from = -1
  editor.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text)
  })
  act(() => {
    editor.commands.setTextSelection({ from, to: from + text.length })
  })
}

describe('NoteEditor', () => {
  it('opens an existing markdown note without marking it changed', () => {
    const { dom, onChange } = mount('# Rapat\n\n- [ ] Budi: kirim draft')
    expect(dom.querySelector('h1')?.textContent).toBe('Rapat')
    expect(dom.querySelector('ul[data-type="taskList"]')).not.toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('emits markdown, not HTML or JSON, on every edit', () => {
    const { editor, onChange } = mount('Hello')
    act(() => {
      editor.chain().focus('end').insertContent(' **world**', { contentType: 'markdown' }).run()
    })
    const md = onChange.mock.calls.at(-1)![0]
    expect(md).toContain('**world**')
    expect(md).not.toContain('<')
  })

  it('slash command turns the block into a heading', async () => {
    const { editor, onChange } = mount('')
    act(() => {
      editor.chain().focus().insertContent('/head').run()
    })
    const item = await screen.findByRole('option', { name: t('desktop.slash.h2') })
    fireEvent.mouseDown(item)
    expect(editor.isActive('heading', { level: 2 })).toBe(true)
    act(() => {
      editor.commands.insertContent('Risks')
    })
    expect(onChange.mock.calls.at(-1)![0]).toBe('## Risks')
  })

  it('rewrites a selection only after Accept', async () => {
    complete.mockResolvedValue('Short.')
    const { editor, onChange } = mount('A very long winded sentence.\n\nKeep me.')
    select(editor, 'A very long winded sentence.')
    act(() => {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }))
    })
    fireEvent.click(await screen.findByRole('option', { name: t('desktop.ai.action.shorter') }))
    await screen.findByText('Short.')
    // Proposed, not applied: the document and the vault have not changed.
    expect(editor.isEditable).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('desktop.ai.replace') }))
    expect(editor.getMarkdown()).toBe('Short.\n\nKeep me.')
    expect(onChange.mock.calls.at(-1)![0]).toBe('Short.\n\nKeep me.')
    expect(editor.isEditable).toBe(true)
  })

  it('reject leaves the document untouched', async () => {
    complete.mockResolvedValue('Something else')
    const { editor, onChange } = mount('Original text.')
    select(editor, 'Original')
    act(() => {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }))
    })
    fireEvent.click(await screen.findByRole('option', { name: t('desktop.ai.action.improve') }))
    await screen.findByText('Something else')
    fireEvent.click(screen.getByRole('button', { name: t('desktop.ai.reject') }))
    expect(editor.getMarkdown()).toBe('Original text.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('continue writing inserts at the cursor', async () => {
    complete.mockResolvedValue('Second paragraph.')
    const { editor } = mount('First paragraph.')
    act(() => {
      editor.chain().focus('end').splitBlock().insertContent('/continue').run()
    })
    fireEvent.mouseDown(await screen.findByRole('option', { name: t('desktop.slash.continue') }))
    fireEvent.click(await screen.findByRole('button', { name: t('desktop.ai.insert') }))
    expect(editor.getMarkdown()).toContain('First paragraph.')
    expect(editor.getMarkdown()).toContain('Second paragraph.')
  })

  it('stop cancels a generation and keeps writing possible', async () => {
    complete.mockImplementation(() => new Promise(() => {}))
    const { editor, onChange } = mount('Draft.')
    select(editor, 'Draft.')
    act(() => {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }))
    })
    fireEvent.click(await screen.findByRole('option', { name: t('desktop.ai.action.longer') }))
    fireEvent.click(await screen.findByRole('button', { name: t('desktop.ai.stop') }))
    expect(editor.isEditable).toBe(true)
    expect(screen.queryByText(t('desktop.ai.writing'))).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a provider error is shown and the editor stays usable', async () => {
    complete.mockRejectedValue(new Error('HTTP 401: invalid key'))
    const { editor } = mount('Text.')
    select(editor, 'Text.')
    act(() => {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }))
    })
    fireEvent.click(await screen.findByRole('option', { name: t('desktop.ai.action.grammar') }))
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 401')
    fireEvent.click(screen.getByRole('button', { name: t('desktop.ai.close') }))
    await waitFor(() => expect(editor.isEditable).toBe(true))
  })

  it('an empty document offers Write with AI', () => {
    const { onWriteWithAI } = mount('')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('desktop.ai.writeWithAI')) }))
    expect(onWriteWithAI).toHaveBeenCalled()
  })
})
