// Reading a model turn. Tolerant of what local models wrap around JSON (a
// fence, a sentence before it), strict about shape: a reply that carries
// changes in any malformed form is invalid as a whole, never half-used.
import type { AgentStep, AgentToolCall } from './types'

export type Parsed =
  | { ok: true; step: AgentStep }
  /** No JSON at all: the model answered in prose. */
  | { ok: false; kind: 'prose'; text: string }
  /** JSON-looking, but broken or the wrong shape. */
  | { ok: false; kind: 'invalid'; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optString = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string'

function extractJSON(raw: string): unknown {
  const text = raw.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text)
  const body = fenced ? fenced[1].trim() : text
  try {
    return JSON.parse(body)
  } catch {
    // Prose around one object: take the outermost braces.
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('no JSON object')
    return JSON.parse(body.slice(start, end + 1))
  }
}

export function parseStep(raw: string): Parsed {
  const text = raw.trim()
  if (!text) return { ok: false, kind: 'invalid', error: 'empty reply' }
  let value: unknown
  try {
    value = extractJSON(text)
  } catch {
    return text.includes('{') ? { ok: false, kind: 'invalid', error: 'not valid JSON' } : { ok: false, kind: 'prose', text }
  }
  if (!isObject(value)) return { ok: false, kind: 'invalid', error: 'not a JSON object' }

  if (value.type === 'tool_calls') {
    if (!Array.isArray(value.calls) || !value.calls.length) return { ok: false, kind: 'invalid', error: 'tool_calls without calls' }
    const calls: AgentToolCall[] = []
    for (const c of value.calls) {
      if (!isObject(c) || typeof c.tool !== 'string') return { ok: false, kind: 'invalid', error: 'malformed tool call' }
      if (c.args !== undefined && !isObject(c.args)) return { ok: false, kind: 'invalid', error: 'tool args must be an object' }
      calls.push({ tool: c.tool, args: (c.args as Record<string, unknown>) ?? {} })
    }
    return { ok: true, step: { type: 'tool_calls', calls, ...(typeof value.status === 'string' ? { status: value.status } : {}) } }
  }

  if (value.type === 'final') {
    const { answer, summary, sources, findings, changes, open } = value
    if (!optString(answer) || !optString(summary) || !optString(open)) return { ok: false, kind: 'invalid', error: 'final fields must be strings' }
    if (sources !== undefined && !(Array.isArray(sources) && sources.every((s) => typeof s === 'string'))) {
      return { ok: false, kind: 'invalid', error: 'sources must be a list of paths' }
    }
    if (findings !== undefined && !Array.isArray(findings)) return { ok: false, kind: 'invalid', error: 'findings must be a list' }
    // A write instruction that is not even a list is not salvaged.
    if (changes !== undefined && !(Array.isArray(changes) && changes.every(isObject))) {
      return { ok: false, kind: 'invalid', error: 'changes must be a list of objects' }
    }
    return {
      ok: true,
      step: {
        type: 'final',
        ...(answer?.trim() ? { answer: answer.trim() } : {}),
        ...(summary?.trim() ? { summary: summary.trim() } : {}),
        ...(sources ? { sources: sources as string[] } : {}),
        ...(findings ? { findings: findings as unknown[] } : {}),
        ...(changes ? { changes: changes as unknown[] } : {}),
        ...(open?.trim() ? { open: open.trim() } : {}),
      },
    }
  }
  return { ok: false, kind: 'invalid', error: 'unknown reply type' }
}
