// The Tiptap side of editor AI: reading context out of a live editor and
// applying a proposed edit as one transaction. Shared by the inline menu and
// the AI side panel so both put text into the document the same way.
import { getHTMLFromFragment, type Editor, type JSONContent } from '@tiptap/core'
import { Node as PMNode } from '@tiptap/pm/model'
import type { EditOp, EditorContext } from './editorAI'

export function contextOf(editor: Editor, from: number, to: number): EditorContext {
  const doc = editor.state.doc
  const md = (json: JSONContent) => editor.markdown?.serialize(json) ?? ''
  return {
    selection: from === to ? '' : md(doc.cut(from, to).toJSON()),
    before: md(doc.cut(0, from).toJSON()),
    after: md(doc.cut(to).toJSON()),
    document: editor.getMarkdown(),
  }
}

/** Markdown as editor content; one paragraph goes in as inline text, so a
 *  rewrite of half a sentence does not split it into two paragraphs. */
function contentOf(editor: Editor, markdown: string): JSONContent[] {
  const parsed = editor.markdown?.parse(markdown).content ?? []
  if (parsed.length === 1 && parsed[0].type === 'paragraph') return parsed[0].content ?? []
  return parsed
}

/**
 * Put `op` into the document at the range it was asked about. `below` turns a
 * replacement into an insertion under the block the range ends in.
 */
export function applyEdit(editor: Editor, op: EditOp, from: number, to: number, below = false): void {
  const chain = editor.chain().focus()
  if (op.op === 'replaceDocument') {
    editor.commands.setContent(op.markdown, { contentType: 'markdown', emitUpdate: true })
    return
  }
  if (op.op === 'append') {
    chain.insertContentAt(editor.state.doc.content.size, editor.markdown?.parse(op.markdown).content ?? []).run()
    return
  }
  if (op.op === 'replace' && !below) {
    chain.insertContentAt({ from, to }, contentOf(editor, op.markdown)).run()
    return
  }
  const $to = editor.state.doc.resolve(to)
  const at = below || from !== to ? ($to.depth >= 1 ? $to.after(1) : to) : to
  const content = at === to ? contentOf(editor, op.markdown) : (editor.markdown?.parse(op.markdown).content ?? [])
  chain.insertContentAt(at, content).run()
}

/**
 * Markdown rendered the way the editor would render it, for previews. The
 * HTML comes from the schema's own serializer, so raw HTML in the markdown is
 * text here (the vault parser keeps it literal), never markup.
 */
export function markdownToHTML(editor: Editor, markdown: string): string {
  const json = editor.markdown?.parse(markdown) ?? { type: 'doc', content: [] }
  return getHTMLFromFragment(PMNode.fromJSON(editor.schema, json).content, editor.schema)
}
