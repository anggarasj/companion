// The one extension list the editor runs with, shared by the React editor and
// the round-trip tests so the tests exercise exactly what ships.
//
// Every node here has a markdown parse + serialize pair in @tiptap/markdown;
// that is the admission rule. A node the serializer cannot write back would be
// silently dropped from the .md file on the next save.
import type { AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { CodeBlock } from '@tiptap/extension-code-block'

const WORD = /[\p{L}\p{N}]/u

/**
 * Escape only what would change meaning when the file is parsed again.
 *
 * The stock serializer escapes every `[ ] _ * ~` and entity-encodes `< > &`.
 * That round-trips, but it rewrites a meeting's `[12:04]` citations into
 * `\[12:04\]` and `a -> b` into `a -&gt; b` on the first save — valid markdown
 * nobody wants to read in another editor. Here: emphasis delimiters always,
 * `_` only where it could open or close emphasis (GFM ignores intraword `_`),
 * `]` only where it would close a link, `&` only where it would start an entity.
 */
export function escapeText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1] ?? ''
    if (c === '\\' && /[!-/:-@[-`{-~]/.test(next)) out += '\\\\'
    else if (c === '*' || c === '`' || c === '~') out += `\\${c}`
    else if (c === '_' && !(WORD.test(text[i - 1] ?? '') && WORD.test(next))) out += '\\_'
    else if (c === ']' && /[([:]/.test(next)) out += '\\]'
    else if (c === '&' && /^&#?\w+;/.test(text.slice(i))) out += '&amp;'
    else out += c
  }
  return out
}

/** The MarkdownManager internals overridden below (private in its typings). */
interface Manager {
  codeTypes: Set<string>
  htmlAsLiteralText(html: string, block: boolean): unknown
  parseHTMLToken(token: { text?: string; raw?: string; block?: boolean }): unknown
  encodeTextForMarkdown(text: string, node: { marks?: unknown[] }, parent?: { type?: string }): string
  serialize(doc: unknown): string
}

function patchManager(m: Manager): void {
  // Raw HTML in a note stays as the literal text it was typed as. Converting it
  // into editor nodes keeps only what the schema knows — `<div>x</div>` came
  // back as `x` — and that loss would be written to disk on the next autosave.
  m.parseHTMLToken = (token) => {
    const html = token.text || token.raw || ''
    return html.trim() ? m.htmlAsLiteralText(html, Boolean(token.block)) : null
  }
  m.encodeTextForMarkdown = (text, node, parent) => {
    const marks = (node.marks ?? []) as Array<string | { type: string }>
    const inCode =
      (parent?.type != null && m.codeTypes.has(parent.type)) ||
      marks.some((mk) => m.codeTypes.has(typeof mk === 'string' ? mk : mk.type))
    // A soft break keeps whatever indentation marked left after it; leading
    // spaces on a paragraph's continuation line mean nothing in markdown, but
    // writing them out made the second save differ from the first.
    return inCode ? text : escapeText(text).replace(/\n[ \t]+/g, '\n')
  }
  // An empty list item comes out as "- " — and marked reads "- " followed by
  // a blank line back as a paragraph holding the text "- ", turning the
  // bullet into literal text. Bare "-" parses back as the empty item it was.
  const serialize = m.serialize.bind(m)
  m.serialize = (doc) => serialize(doc).replace(/^([ \t]*(?:[-*+]|\d+[.)]))[ \t]+$/gm, '$1')
}

/**
 * Ordered lists, with one upstream off-by-one corrected.
 *
 * Tiptap's ordered-list tokenizer strips `marker digits + 1` columns from an
 * item's continuation lines — 2 for "1." where CommonMark says 3 — and then
 * trims the item. Paragraphs do not care, but a fenced code block inside "1."
 * came out one space deeper on every save. Every continuation line indented
 * past the item carries exactly that one extra space, so it is removed before
 * the item content is lexed. Drop this once @tiptap/extension-list fixes it;
 * the round-trip test in markdown.test.ts says when.
 */
const tiptapOrdered = OrderedList.config.markdownTokenizer
const VaultOrderedList = tiptapOrdered
  ? OrderedList.extend({
      markdownTokenizer: {
        ...tiptapOrdered,
        tokenize: (src, tokens, lexer) =>
          tiptapOrdered.tokenize(
            src,
            tokens,
            new Proxy(lexer, {
              get(target, key) {
                const value = Reflect.get(target, key)
                if (key === 'blockTokens') {
                  return (text: string, ...rest: unknown[]) => value.call(target, text.replace(/\n /g, '\n'), ...rest)
                }
                return typeof value === 'function' ? value.bind(target) : value
              },
            }),
          ),
      },
    })
  : OrderedList

/** @tiptap/markdown, with the vault's escaping and HTML rules. */
const VaultMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    // The parent parses initial markdown content before returning, so keep the
    // raw string, patch, then parse it again with the patched manager.
    const raw = this.editor.options.content
    this.parent?.(event)
    if (!this.editor.markdown) return
    patchManager(this.editor.markdown as unknown as Manager)
    if (this.editor.options.contentType === 'markdown' && typeof raw === 'string') {
      const json = this.editor.markdown.parse(raw)
      this.editor.options.content = json.content?.length ? json : raw
    }
  },
})

/**
 * `codeBlock` and `image` are swappable so the React editor can give them a
 * view (mermaid diagrams, media players) while the round-trip tests run the
 * same nodes headless —
 * the node and its markdown are identical either way.
 */
export function baseExtensions({
  codeBlock = CodeBlock as AnyExtension,
  image = Image as AnyExtension,
}: { codeBlock?: AnyExtension; image?: AnyExtension } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      // Tiptap would open a clicked link with window.open, which in the Tauri
      // window goes nowhere; NoteEditor opens it in the system browser instead.
      link: { openOnClick: false, autolink: true },
      // Markdown has no underline; a mark the file cannot carry would vanish
      // on reopen, so it is not offered at all.
      underline: false,
      orderedList: false,
      codeBlock: false,
    }),
    codeBlock,
    VaultOrderedList,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    image,
    VaultMarkdown,
  ]
}
