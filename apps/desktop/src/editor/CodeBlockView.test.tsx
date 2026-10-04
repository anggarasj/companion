// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { t } from '@meetcc/shared/i18n'

// jsdom cannot lay out SVG text, so mermaid itself is stubbed; what is under
// test is the editor wiring: which blocks render, and that the file is untouched.
const renderMermaid = vi.fn(async (def: string) => `<svg data-testid="diagram"><text>${def.length}</text></svg>`)
vi.mock('./mermaid', () => ({ renderMermaid: (d: string) => renderMermaid(d) }))
const { NoteEditor } = await import('../NoteEditor')

beforeEach(() => {
  renderMermaid.mockClear()
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  document.elementFromPoint = () => null
})
afterEach(cleanup)

const DOC = [
  '# Use case',
  '',
  '```mermaid',
  'flowchart LR',
  '    A((Operator Kapal /<br/>Agen Kapal))',
  '    A --- U1[Mengajukan Pemesanan]',
  '```',
  '',
  '```ts',
  'const a = 1',
  '```',
].join('\n')

function mount() {
  const onChange = vi.fn()
  const view = render(<NoteEditor value={DOC} onChange={onChange} onWriteWithAI={() => {}} />)
  const editor = (view.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
  return { view, editor, onChange }
}

describe('code blocks', () => {
  it('a mermaid fence shows its diagram; other code stays code', async () => {
    const { view } = mount()
    expect(await screen.findByTestId('diagram')).toBeTruthy()
    expect(renderMermaid).toHaveBeenCalledWith(expect.stringContaining('A((Operator Kapal /<br/>Agen Kapal))'))
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('pre code.language-ts')?.textContent).toBe('const a = 1')
    expect((view.container.querySelector('[data-mermaid-source]') as HTMLElement).hidden).toBe(true)
  })

  it('the source opens for editing and the file is unchanged by viewing it', async () => {
    const { view, editor, onChange } = mount()
    await screen.findByTestId('diagram')
    fireEvent.click(screen.getByRole('button', { name: t('desktop.mermaid.edit') }))
    expect((view.container.querySelector('[data-mermaid-source]') as HTMLElement).hidden).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(editor.getMarkdown()).toContain('```mermaid\nflowchart LR\n    A((Operator Kapal /<br/>Agen Kapal))')
  })

  it('a syntax error is shown with the source, not a blank block', async () => {
    renderMermaid.mockRejectedValueOnce(new Error('Parse error on line 2'))
    const { view } = mount()
    expect((await screen.findByRole('status')).textContent).toContain('Parse error on line 2')
    expect((view.container.querySelector('[data-mermaid-source]') as HTMLElement).hidden).toBe(false)
  })

  it('editing the source re-renders the diagram', async () => {
    const { editor } = mount()
    await screen.findByTestId('diagram')
    let end = 0
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'codeBlock' && n.attrs.language === 'mermaid') end = pos + n.nodeSize - 1
    })
    act(() => {
      editor.commands.insertContentAt(end, '\n    U1 --- U2[Validasi]')
    })
    await waitFor(() => expect(renderMermaid).toHaveBeenLastCalledWith(expect.stringContaining('U2[Validasi]')), { timeout: 2000 })
  })
})
