// The bounded agent loop, on nothing but AIClient.complete — so it works the
// same on every provider, function calling or not.
//
//   prompt → model → tool calls → results into the log → prompt → … → final
//
// At most MAX_AGENT_STEPS model calls (a re-prompt for broken JSON counts as
// one), at most MAX_CALLS_PER_STEP tools per step, and a call already made in
// this run is not made again. The final answer is checked against what was
// actually read: sources the agent never read are dropped, changes go through
// changes.ts and come back staged, never applied.
import { AIError, type AIClient } from '@meetcc/ai'
import { t } from '@meetcc/shared/i18n'
import { abortable } from '../editor/editorAI'
import { stageChanges } from './changes'
import type { BoardInsert } from '../board'
import { budgetLog, inScope, MAX_AGENT_STEPS, MAX_CALLS_PER_STEP, type LogEntry } from './context'
import { parseStep } from './parser'
import { AGENT_SYSTEM, block, buildTurn } from './prompt'
import { callKey, runTool, type ToolState } from './tools'
import type { AgentResult, AgentScope, AgentStep, AgentToolCall, AgentTurn, ReviewFinding, SourceRef, Workspace } from './types'

export interface Activity {
  /** The model's own one-line status, or what a tool just did. */
  status?: string
  tool?: string
  detail?: string
}

/** The line shown while the agent works. */
export function describeActivity(a: Activity): string {
  if (a.status) return a.status
  if (a.tool === 'search_vault') return t('desktop.aiPanel.activity.search', { detail: a.detail ?? '' })
  if (a.tool === 'read_note') return t('desktop.aiPanel.activity.read', { detail: a.detail ?? '' })
  if (a.tool === 'list_folder') return t('desktop.aiPanel.activity.list', { detail: a.detail ?? '' })
  if (a.tool === 'get_current_document') return t('desktop.aiPanel.activity.current')
  return t('desktop.aiPanel.working')
}

export interface RunOptions {
  client: AIClient
  request: string
  workspace: Workspace
  scope: AgentScope
  history?: AgentTurn[]
  signal?: AbortSignal
  onActivity?: (a: Activity) => void
  maxSteps?: number
}

const SEVERITIES = new Set<unknown>(['info', 'warning', 'critical'])
const EXCERPT_CHARS = 300

function entry(n: number, tool: string, result: Record<string, unknown>): LogEntry {
  const attrs = ` n="${n}" tool="${tool}"`
  const compact =
    tool === 'read_note' || tool === 'get_current_document'
      ? { path: result.path, title: result.title, note: 'content elided to save context; read it again if needed' }
      : result
  return { text: block('tool_result', result, attrs), compact: block('tool_result', compact, attrs) }
}

export async function runAgent(o: RunOptions): Promise<AgentResult> {
  const max = o.maxSteps ?? MAX_AGENT_STEPS
  const state: ToolState = { reads: new Map() }
  const log: LogEntry[] = []
  const seen = new Map<string, number>()
  let correction: string | undefined
  let retried = false

  for (let step = 1; step <= max; step++) {
    if (o.signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError')
    const user = buildTurn({
      request: o.request,
      scope: o.scope,
      current: o.workspace.current,
      openFile: o.workspace.openFile,
      history: o.history ?? [],
      log: budgetLog(log),
      step,
      maxSteps: max,
      correction,
    })
    const raw = await abortable(o.client.complete({ system: AGENT_SYSTEM, user, json: true }), o.signal)
    const parsed = parseStep(raw)
    if (!parsed.ok) {
      if (!retried && step < max) {
        retried = true
        correction = `Your previous reply was rejected (${parsed.kind === 'invalid' ? parsed.error : 'prose instead of JSON'}). Reply again with exactly one JSON object as specified, nothing else.`
        continue
      }
      // Prose is still an answer worth showing; a broken JSON reply is not —
      // it may have been carrying changes, and those are never guessed at.
      if (parsed.kind === 'prose') return finish(o, state, { type: 'final', answer: parsed.text }, step)
      throw new AIError(t('desktop.ai.invalidResponse'), false)
    }
    correction = undefined
    const s = parsed.step
    if (s.type === 'final') return finish(o, state, s, step)
    if (step === max) break
    if (s.status) o.onActivity?.({ status: s.status })
    await runCalls(o, s.calls, state, log, seen)
  }
  throw new AIError(t('desktop.agent.stepLimit', { count: max }), false)
}

/** Convert the Mermaid in proposed board changes, before they are validated. */
async function convertMermaid(o: RunOptions, changes: unknown[]): Promise<Map<unknown, BoardInsert | string>> {
  const out = new Map<unknown, BoardInsert | string>()
  if (!o.workspace.mermaid) return out
  for (const raw of changes) {
    const c = raw as Record<string, unknown>
    const add = c.add && typeof c.add === 'object' ? (c.add as Record<string, unknown>) : undefined
    const def = c.type === 'create_board' ? c.mermaid : c.type === 'edit_board' ? add?.mermaid : undefined
    if (typeof def !== 'string' || !def.trim()) continue
    try {
      out.set(raw, await o.workspace.mermaid(def))
    } catch (e) {
      out.set(raw, (e as Error).message || String(e))
    }
  }
  return out
}

/** One step's tool calls, in order, into the log; a call already made in this run is not made again. */
async function runCalls(o: RunOptions, calls: AgentToolCall[], state: ToolState, log: LogEntry[], seen: Map<string, number>): Promise<void> {
  for (const call of calls.slice(0, MAX_CALLS_PER_STEP)) {
    if (o.signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError')
    const key = callKey(call)
    const earlier = seen.get(key)
    if (earlier !== undefined) {
      log.push(entry(log.length + 1, 'duplicate', { note: `same call as result #${earlier}; not repeated — use that result` }))
      continue
    }
    const out = await runTool(call, o.workspace, o.scope, state)
    seen.set(key, log.length + 1)
    log.push(entry(log.length + 1, out.activity.tool, out.result))
    o.onActivity?.({ tool: out.activity.tool, detail: out.activity.detail })
  }
  if (calls.length > MAX_CALLS_PER_STEP) {
    log.push(entry(log.length + 1, 'limit', { note: `only the first ${MAX_CALLS_PER_STEP} calls of a step run` }))
  }
}

/** A finding from the model, kept only in a usable shape and citing only what was read. */
function toFinding(raw: unknown, reads: ToolState['reads']): ReviewFinding | null {
  const f = raw as Record<string, unknown>
  if (typeof f !== 'object' || !f || typeof f.title !== 'string' || !f.title.trim() || typeof f.explanation !== 'string') return null
  return {
    severity: SEVERITIES.has(f.severity) ? (f.severity as ReviewFinding['severity']) : 'info',
    title: f.title.trim(),
    explanation: f.explanation.trim(),
    sources: citations(f.sources, reads),
    ...(typeof f.suggestedFix === 'string' && f.suggestedFix.trim() ? { suggestedFix: f.suggestedFix.trim() } : {}),
  }
}

function citations(raw: unknown, reads: ToolState['reads']): ReviewFinding['sources'] {
  const out: ReviewFinding['sources'] = []
  for (const c of Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []) {
    if (!c || typeof c.path !== 'string' || !reads.has(c.path)) continue
    out.push({ path: c.path, ...(typeof c.excerpt === 'string' && c.excerpt ? { excerpt: c.excerpt.slice(0, EXCERPT_CHARS) } : {}) })
  }
  return out
}

async function finish(o: RunOptions, state: ToolState, final: Extract<AgentStep, { type: 'final' }>, steps: number): Promise<AgentResult> {
  const reads = state.reads
  const ref = (path: string): SourceRef => ({ path, title: reads.get(path)?.title || path })
  // Only what was read can be cited.
  const sources: SourceRef[] = []
  for (const p of new Set(final.sources ?? [])) if (reads.has(p)) sources.push(ref(p))
  const findings = (final.findings ?? []).flatMap((raw) => toFinding(raw, reads) ?? [])

  const lower = new Set([...o.workspace.paths(), ...o.workspace.files()].map((p) => p.toLowerCase()))
  const { staged, rejected } = stageChanges(final.changes ?? [], {
    reads,
    exists: (p) => lower.has(p.toLowerCase()),
    currentPath: o.workspace.current?.path,
    converted: await convertMermaid(o, final.changes ?? []),
  })

  const openable = final.open && inScope(final.open, o.scope, o.workspace.current?.path) && (lower.has(final.open.toLowerCase()) || final.open === o.workspace.current?.path)
  const result: AgentResult = {
    ...(final.answer ? { answer: final.answer } : {}),
    sources,
    findings,
    ...(staged.length ? { changeSet: { id: `set-${Date.now().toString(36)}`, summary: final.summary ?? '', changes: staged } } : {}),
    rejected,
    ...(openable ? { open: final.open } : {}),
    reads,
    steps,
  }
  if (!result.answer && !findings.length && !result.changeSet && !rejected.length && !result.open) {
    throw new AIError(t('desktop.ai.emptyResponse'), true)
  }
  return result
}

/**
 * Retrieval only, for writing a document: let the agent search and read, then
 * hand back the notes it chose — with their full bodies. Nothing is proposed.
 */
export async function gatherSources(
  o: Omit<RunOptions, 'request' | 'history'> & { brief: string },
): Promise<{ path: string; title: string; body: string }[]> {
  const request = `Find and read the notes needed to write this document: ${o.brief}\nDo not write the document and propose no changes. When you have read enough, reply {"type": "final", "sources": [paths of the notes worth using], "answer": "<one sentence on what you found>"}. If nothing relevant exists, say so in "answer" with empty sources.`
  const result = await runAgent({ ...o, request })
  const chosen = result.sources.length ? result.sources.map((s) => s.path) : [...result.reads.keys()]
  return chosen.map((path) => ({ path, title: result.reads.get(path)?.title || path, body: result.reads.get(path)?.body ?? '' }))
}
