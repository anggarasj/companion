// @vitest-environment jsdom
// Markdown → Tiptap → Markdown. The .md file is the canonical document; the
// editor is only a view of it, so anything lost on this trip is lost from the
// user's vault on the next autosave.
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { baseExtensions } from './extensions'

function roundTrip(md: string): string {
  const editor = new Editor({ extensions: baseExtensions(), content: md, contentType: 'markdown' })
  const out = editor.getMarkdown()
  editor.destroy()
  return out
}

/** Second trip must be a fixed point: the first save may normalise, later ones must not drift. */
function stable(md: string): string {
  const once = roundTrip(md)
  expect(roundTrip(once)).toBe(once)
  return once
}

describe('markdown round-trip', () => {
  const cases: Array<[string, string, string[]]> = [
    ['headings', '# One\n\n## Two\n\n### Three', ['# One', '## Two', '### Three']],
    ['paragraphs', 'First paragraph.\n\nSecond paragraph.', ['First paragraph.', 'Second paragraph.']],
    ['bold', 'a **bold** word', ['**bold**']],
    ['italic', 'an *italic* word', ['*italic*']],
    ['strike', 'a ~~gone~~ word', ['~~gone~~']],
    ['inline code', 'run `make ci` now', ['`make ci`']],
    ['links', 'see [docs](https://tiptap.dev/docs)', ['[docs](https://tiptap.dev/docs)']],
    ['blockquote', '> quoted line', ['> quoted line']],
    ['bullet list', '- one\n- two', ['- one', '- two']],
    ['numbered list', '1. one\n2. two', ['1. one', '2. two']],
    ['nested list', '- parent\n  - child', ['- parent', '  - child']],
    ['task list', '- [ ] open\n- [x] done', ['- [ ] open', '- [x] done']],
    ['code block', '```ts\nconst a = 1\n```', ['```ts', 'const a = 1', '```']],
    ['table', '| A | B |\n| --- | --- |\n| 1 | 2 |', ['| A', '| B', '| 1', '| 2']],
    ['image', '![logo](assets/logo.png)', ['![logo](assets/logo.png)']],
    ['horizontal rule', 'above\n\n---\n\nbelow', ['above', '---', 'below']],
    ['unicode', 'Emoji 🚀 — “quotes” and 日本語', ['🚀', '“quotes”', '日本語']],
    ['bahasa indonesia', 'Keputusan rapat: **tunda rilis** ke sprint depan.', ['**tunda rilis**', 'sprint depan']],
    ['mixed id + en', '## Action Items\n\n- [ ] Budi: update API spec sebelum Jumat', ['## Action Items', '- [ ] Budi: update API spec sebelum Jumat']],
  ]

  for (const [name, md, expected] of cases) {
    it(name, () => {
      const out = stable(md)
      for (const piece of expected) expect(out).toContain(piece)
    })
  }

  // Characters the stock serializer would escape or entity-encode. Each must
  // come back verbatim: these are the edits a user would see as corruption.
  const verbatim = [
    'Rollout ditunda [12:04] karena API belum siap.',
    'a < b && c > d -> e',
    'snake_case_name tetap utuh',
    'Tom & Jerry',
  ]
  for (const md of verbatim) {
    it(`verbatim: ${md}`, () => {
      expect(stable(md).trim()).toBe(md)
    })
  }

  it('literal markdown characters stay literal', () => {
    const text = '2*3*4 and [x](y) and &amp; and _x_'
    const editor = new Editor({ extensions: baseExtensions() })
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    })
    const md = editor.getMarkdown()
    editor.destroy()
    const back = new Editor({ extensions: baseExtensions(), content: md, contentType: 'markdown' })
    expect(back.getText()).toBe(text)
    back.destroy()
  })

  it('raw HTML is kept as written, not reduced to its text', () => {
    expect(stable('<div>raw</div>')).toContain('<div>raw</div>')
    expect(stable('a <kbd>Cmd</kbd> key')).toContain('<kbd>Cmd</kbd>')
  })

  // Found by round-tripping this repo's own 42 .md files: each of these was
  // stable in a toy case and wrong in a real document.
  it('a code block inside a numbered item does not drift on every save', () => {
    let md = '1. Copy the env file:\n\n   ```bash\n   cp .env.example .env\n   ```'
    for (let i = 0; i < 3; i++) md = roundTrip(md)
    expect(md).toContain('\n   cp .env.example .env\n')
    const editor = new Editor({ extensions: baseExtensions(), content: md, contentType: 'markdown' })
    let code = ''
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'codeBlock') code = n.textContent
    })
    editor.destroy()
    expect(code).toBe('cp .env.example .env')
  })

  it('an empty bullet stays a bullet, not the text "- "', () => {
    const out = stable('## Summary\n\n-\n\n## Changes')
    const editor = new Editor({ extensions: baseExtensions(), content: out, contentType: 'markdown' })
    expect(editor.getText()).not.toContain('-')
    editor.destroy()
  })

  it('wrapped lines inside a numbered item are stable', () => {
    stable('1. **First** item that wraps\n   onto a second line.\n2. Second.')
  })

  it('empty document stays empty', () => {
    expect(roundTrip('').trim()).toBe('')
  })

  it('a delivered meeting body survives unchanged in meaning', () => {
    const meeting = [
      '## Ringkasan',
      '',
      'Tim sepakat **menunda** rollout [12:04].',
      '',
      '## Action Items',
      '',
      '| Tugas | PIC | Tenggat |',
      '| --- | --- | --- |',
      '| Update API | Budi | _[belum dibahas]_ |',
    ].join('\n')
    const out = stable(meeting)
    for (const piece of ['## Ringkasan', '**menunda**', '[12:04]', '| Update API', 'Budi', '[belum dibahas]']) {
      expect(out).toContain(piece)
    }
  })
})
