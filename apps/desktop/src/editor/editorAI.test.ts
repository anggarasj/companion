import { describe, expect, it } from 'vitest'
import { AIError, type AIClient, type CompletionRequest } from '@meetcc/ai'
import { buildPrompt, parseOp, runEditorAI, splitTitle, writeDocument, type EditorContext } from './editorAI'

const ctx = (over: Partial<EditorContext> = {}): EditorContext => ({
  selection: '',
  before: '',
  after: '',
  document: '',
  ...over,
})

function fake(answer: string | Error | (() => Promise<string>)) {
  const calls: CompletionRequest[] = []
  const client: AIClient = {
    provider: 'custom',
    complete: async (req) => {
      calls.push(req)
      if (answer instanceof Error) throw answer
      return typeof answer === 'function' ? answer() : answer
    },
  }
  return { client, calls }
}

describe('editor AI context', () => {
  it('a selection rewrite sends the selection and its neighbourhood, not the document', () => {
    const doc = `${'x'.repeat(5000)} SECRET-START ${'y'.repeat(5000)}`
    const p = buildPrompt({
      kind: 'action',
      action: 'shorter',
      ctx: ctx({ selection: 'long paragraph', before: doc, after: 'tail', document: doc }),
    })
    expect(p.user).toContain('<selection>\nlong paragraph\n</selection>')
    expect(p.user).not.toContain('SECRET-START')
    expect(p.user.length).toBeLessThan(4000)
  })

  it('continue writing sends what precedes the cursor', () => {
    const p = buildPrompt({ kind: 'action', action: 'continue', ctx: ctx({ before: 'Intro paragraph.' }) })
    expect(p.user).toContain('<before>\nIntro paragraph.\n</before>')
    expect(p.json).toBe(false)
  })

  it('summarize sends the document', () => {
    const p = buildPrompt({ kind: 'action', action: 'summarize', ctx: ctx({ document: '# PRD\n\nBody' }) })
    expect(p.user).toContain('<document>\n# PRD\n\nBody\n</document>')
  })

  it('a custom instruction without a selection asks for a structured edit', () => {
    const p = buildPrompt({ kind: 'custom', instruction: 'Tambahkan section Security', ctx: ctx({ document: 'doc' }) })
    expect(p.json).toBe(true)
    expect(p.system).toContain('"op"')
  })
})

describe('editor AI results', () => {
  it('rewrite selection proposes a replacement, unfenced', async () => {
    const { client } = fake('```markdown\nShort.\n```')
    const op = await runEditorAI(client, { kind: 'action', action: 'shorter', ctx: ctx({ selection: 'Long.' }) })
    expect(op).toEqual({ op: 'replace', markdown: 'Short.' })
  })

  it('continue writing proposes an insert at the cursor', async () => {
    const { client } = fake('More text.')
    expect(await runEditorAI(client, { kind: 'action', action: 'continue', ctx: ctx() })).toEqual({
      op: 'insert',
      markdown: 'More text.',
    })
  })

  it('a whole-document rewrite is proposed as replaceDocument, for review', async () => {
    const { client } = fake('# New')
    const op = await runEditorAI(client, { kind: 'action', action: 'rewrite', ctx: ctx({ document: '# Old' }) })
    expect(op.op).toBe('replaceDocument')
  })

  it('parses a structured append', async () => {
    const { client } = fake('```json\n{"op":"append","markdown":"## Security Considerations\\n\\n- TLS","summary":"Menambahkan bagian Security."}\n```')
    const op = await runEditorAI(client, { kind: 'custom', instruction: 'add security', ctx: ctx() })
    expect(op).toEqual({ op: 'append', markdown: '## Security Considerations\n\n- TLS', summary: 'Menambahkan bagian Security.' })
  })

  it('rejects an invalid structured answer instead of guessing', () => {
    expect(() => parseOp('{"op":"delete-everything"}')).toThrow(AIError)
    expect(() => parseOp('{not json')).toThrow(AIError)
  })

  it('an empty answer is an error, not an empty edit', async () => {
    const { client } = fake('   ')
    await expect(runEditorAI(client, { kind: 'action', action: 'improve', ctx: ctx({ selection: 'a' }) })).rejects.toThrow(AIError)
  })

  it('surfaces a provider error unchanged', async () => {
    const { client } = fake(new AIError('HTTP 401: invalid key', false))
    await expect(runEditorAI(client, { kind: 'action', action: 'improve', ctx: ctx({ selection: 'a' }) })).rejects.toThrow('HTTP 401')
  })

  it('cancelling rejects with AbortError and discards the late answer', async () => {
    let release!: (s: string) => void
    const { client } = fake(() => new Promise<string>((r) => (release = r)))
    const ctrl = new AbortController()
    const run = runEditorAI(client, { kind: 'action', action: 'continue', ctx: ctx() }, ctrl.signal)
    ctrl.abort()
    release('late')
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('new documents', () => {
  it('grounds a document in the given sources only', async () => {
    const { client, calls } = fake('# RFC Auth\n\nBody')
    const md = await writeDocument(client, 'Buat RFC', [{ title: 'research', body: 'passkeys' }])
    expect(md).toBe('# RFC Auth\n\nBody')
    expect(calls[0].user).toContain('<source>\n# research\n\npasskeys\n</source>')
  })

  it('stops sending sources once the context budget is spent', async () => {
    const { client, calls } = fake('# Doc')
    const big = 'x'.repeat(30_000)
    await writeDocument(client, 'p', [{ title: 'a', body: big }, { title: 'b', body: 'small' }])
    expect(calls[0].user.match(/<source>/g)).toHaveLength(1)
    expect(calls[0].user).not.toContain('# b')
  })

  it('splits the generated title from the body', () => {
    expect(splitTitle('# PRD Passkey\n\n## Problem', 'Untitled')).toEqual({ title: 'PRD Passkey', body: '## Problem' })
    expect(splitTitle('No heading', 'Untitled')).toEqual({ title: 'Untitled', body: 'No heading' })
  })
})
