// The AI panel on the right: a conversation with the Vault Agent.
//
// A question gets an answer with the notes it came from; a review gets
// findings; a request for changes gets a staged change set — a diff per note,
// written only when the user applies it, checked against what the agent read
// so it never lands on newer edits, and undoable as a set on the same terms.
// The loop, the tools and the safety checks live in ./agent; this file only
// renders them.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { listModels, PROVIDER_PRESETS, resolveConfig, supportsEffort } from '@meetcc/ai'
import type { Settings } from '@meetcc/shared/types'
import { t, type MessageKey } from '@meetcc/shared/i18n'
import { ArrowUp, Check, CircleAlert, Eye, EyeOff, FileText, Sparkles, Square, Undo2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/Tip'
import { configuredClient, loadAiSettings, loadSessionAI, saveSessionAI, type EffortPref, type SessionAI } from './aiSettings'
import { Editor } from '@tiptap/core'
import { isAbort } from './editor/editorAI'
import { markdownToHTML } from './editor/editorOps'
import { baseExtensions } from './editor/extensions'
import { PREVIEW } from './editor/prose'
import { lineDiff } from './editor/diff'
import { applyChange, undoApplied } from './agent/changes'
import { describeActivity, runAgent } from './agent/runner'
import type { AgentResult, AgentScope, AgentTurn, AppliedChange, ChangeTarget, ReviewFinding, SourceRef, StagedChange, Workspace } from './agent/types'
import { Select } from './Select'

type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'stale' | 'missing' | 'exists' | 'failed'

interface AIMessage {
  id: number
  role: 'ai'
  result: AgentResult
  status: Record<string, ChangeStatus>
  diffs: Record<string, boolean>
  picked: number[]
  applied: AppliedChange[]
  undone: boolean
  undoConflicts: string[]
}

type AIPatch = Partial<AIMessage>

type Message = { id: number; role: 'user'; text: string } | AIMessage | { id: number; role: 'error'; text: string }

type ScopeChoice = 'vault' | 'folder' | 'document'

const EFFORTS: { value: EffortPref; label: MessageKey }[] = [
  { value: 'auto', label: 'desktop.aiPanel.effort.auto' },
  { value: 'low', label: 'desktop.aiPanel.effort.low' },
  { value: 'medium', label: 'desktop.aiPanel.effort.medium' },
  { value: 'high', label: 'desktop.aiPanel.effort.high' },
]

const CHANGE_LABEL: Record<StagedChange['type'], MessageKey> = {
  create_note: 'desktop.aiPanel.change.create',
  replace_text: 'desktop.aiPanel.change.replace',
  append_section: 'desktop.aiPanel.change.append',
  replace_body: 'desktop.aiPanel.change.body',
  create_board: 'desktop.aiPanel.change.createBoard',
  edit_board: 'desktop.aiPanel.change.editBoard',
}

const STATUS_LABEL: Record<Exclude<ChangeStatus, 'pending'>, MessageKey> = {
  applied: 'desktop.aiPanel.status.applied',
  rejected: 'desktop.aiPanel.status.rejected',
  stale: 'desktop.aiPanel.status.stale',
  missing: 'desktop.aiPanel.status.missing',
  exists: 'desktop.aiPanel.status.exists',
  failed: 'desktop.aiPanel.status.failed',
}

const SEVERITY: Record<ReviewFinding['severity'], { label: MessageKey; className: string }> = {
  info: { label: 'desktop.aiPanel.severity.info', className: 'text-muted-foreground' },
  warning: { label: 'desktop.aiPanel.severity.warning', className: 'text-warning' },
  critical: { label: 'desktop.aiPanel.severity.critical', className: 'text-destructive' },
}

let nextId = 0

// One headless editor renders every answer, through the same schema the notes
// use: raw HTML in an answer stays text (the vault parser keeps it literal),
// and headings, lists, tables and code look the way they do in a note.
let renderer: Editor | null = null
function answerHTML(markdown: string): string {
  renderer ??= new Editor({ extensions: baseExtensions() })
  return markdownToHTML(renderer, markdown)
}

/** Markdown from the model, rendered. Chat-sized: no frame, tighter than a note. */
const ANSWER = cn(
  PREVIEW,
  'rounded-none p-0 text-[13px]',
  '[&_:is(h1,h2,h3)]:mt-[0.9em] [&_li+li]:mt-[0.2em]',
  '[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-sunken [&_pre]:p-2.5 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:border-l-[3px] [&_blockquote]:pl-2.5 [&_blockquote]:text-muted-foreground [&_hr]:border-border [&_table]:w-full',
)

/** "ag/gemini-3.8-flash" → "gemini-3.8-flash": the gateway prefix is noise in a picker label. */
const shortModel = (m: string): string => m.split('/').pop() || '—'

/** What the next prompt remembers of a result: short, plus the documents shown, numbered. */
function turnOf(request: string, r: AgentResult): AgentTurn {
  const parts = [r.answer ?? '']
  if (r.findings.length) parts.push(`Findings: ${r.findings.map((f) => f.title).join('; ')}`)
  if (r.changeSet) parts.push(`Proposed changes (${r.changeSet.summary}): ${[...new Set(r.changeSet.changes.map((c) => c.path))].join(', ')}`)
  return { request, reply: parts.filter(Boolean).join('\n'), refs: refsOf(r) }
}

/** The documents a result shows, in display order — what "the second one" counts through. */
function refsOf(r: AgentResult): SourceRef[] {
  if (r.sources.length) return r.sources
  const refs = new Map<string, SourceRef>()
  for (const s of r.findings.flatMap((f) => f.sources)) refs.set(s.path, refs.get(s.path) ?? { path: s.path, title: s.path })
  return [...refs.values()]
}

export function AISidebar({
  hasDocument,
  folder,
  workspace,
  onOpen,
  onChanged,
  onClose,
  onWriteWithAI,
}: {
  /** A note is open in the editor. */
  hasDocument: boolean
  /** The open note's folder ('' at the vault root). */
  folder: string
  /** The vault as it is right now — called per request and per Apply. */
  workspace: () => Workspace & ChangeTarget
  onOpen: (path: string) => void
  /** Notes were written; `removed` lists ones an undo took away. */
  onChanged: (removed: string[]) => void
  onClose: () => void
  onWriteWithAI: () => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [turns, setTurns] = useState<AgentTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState('')
  const [scope, setScope] = useState<ScopeChoice>('vault')
  const [prefs, setPrefs] = useState<SessionAI>(loadSessionAI)
  const [saved, setSaved] = useState<Settings | null>(null)
  const [models, setModels] = useState<string[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void loadAiSettings().then((s) => {
      if (!alive) return
      setSaved(s)
      // A provider that cannot list its models still has the preset's list.
      listModels(s)
        .catch(() => PROVIDER_PRESETS[s.provider]?.models ?? [])
        .then((list) => alive && setModels(list))
    })
    return () => {
      alive = false
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, busy])

  const update = (patch: Partial<SessionAI>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    saveSessionAI(next)
  }
  const patchAI = (id: number, patch: (m: AIMessage) => AIPatch) =>
    setMessages((all) => all.map((m) => (m.id === id && m.role === 'ai' ? { ...m, ...patch(m) } : m)))

  // A choice the open note no longer supports falls back to the whole vault.
  const scopeChoice: ScopeChoice = (scope === 'document' && !hasDocument) || (scope === 'folder' && !folder) ? 'vault' : scope
  const agentScope = (): AgentScope =>
    scopeChoice === 'document' ? { kind: 'document' } : scopeChoice === 'folder' ? { kind: 'folder', folder } : { kind: 'vault' }

  async function send(request: string, display = request): Promise<void> {
    if (!request.trim() || busy) return
    setMessages((all) => [...all, { id: ++nextId, role: 'user', text: display }])
    setInput('')
    setBusy(true)
    setActivity(t('desktop.aiPanel.working'))
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const client = await configuredClient()
      const result = await runAgent({
        client,
        request,
        workspace: workspace(),
        scope: agentScope(),
        history: turns,
        signal: ctrl.signal,
        onActivity: (a) => !ctrl.signal.aborted && setActivity(describeActivity(a)),
      })
      if (ctrl.signal.aborted) return
      setMessages((all) => [
        ...all,
        {
          id: ++nextId,
          role: 'ai',
          result,
          status: Object.fromEntries((result.changeSet?.changes ?? []).map((c) => [c.id, 'pending' as const])),
          diffs: {},
          picked: [],
          applied: [],
          undone: false,
          undoConflicts: [],
        },
      ])
      setTurns((all) => [...all, turnOf(display, result)])
      if (result.open) onOpen(result.open)
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) return
      setMessages((all) => [...all, { id: ++nextId, role: 'error', text: (e as Error).message }])
    } finally {
      if (abortRef.current === ctrl) setBusy(false)
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    setBusy(false)
  }

  async function apply(m: AIMessage, ids: string[]): Promise<void> {
    const target = workspace()
    const status: Record<string, ChangeStatus> = {}
    const applied: AppliedChange[] = []
    const wanted = new Set(ids)
    for (const c of m.result.changeSet?.changes ?? []) {
      if (!wanted.has(c.id) || m.status[c.id] !== 'pending') continue
      try {
        const r = await applyChange(c, target)
        status[c.id] = r.ok ? 'applied' : r.reason
        if (r.ok) applied.push(r.applied)
      } catch (e) {
        console.warn('[Companion] applying an AI change failed:', e)
        status[c.id] = 'failed'
      }
    }
    patchAI(m.id, (cur) => ({ status: { ...cur.status, ...status }, applied: [...cur.applied, ...applied] }))
    if (applied.length) onChanged([])
  }

  const reject = (m: AIMessage, id: string) => patchAI(m.id, (cur) => ({ status: { ...cur.status, [id]: 'rejected' } }))

  async function undo(m: AIMessage): Promise<void> {
    const r = await undoApplied(m.applied, workspace())
    if (!r.ok) return patchAI(m.id, () => ({ undoConflicts: r.conflicts }))
    patchAI(m.id, () => ({ undone: true, undoConflicts: [] }))
    // A change that created a note or board took it away again.
    onChanged(m.applied.flatMap((a) => (a.before === null ? [a.path] : [])))
  }

  function fix(m: AIMessage): void {
    const picked = new Set(m.picked)
    const chosen = m.result.findings.filter((_, i) => picked.has(i))
    if (!chosen.length) return
    // The request is for the model; the bubble says it in the user's language.
    void send(
      `Propose changes that fix these review findings. Read each affected note first.\n${JSON.stringify(chosen)}`,
      t('desktop.aiPanel.fixRequest', { count: chosen.length }),
    )
  }

  const model = prefs.model || saved?.model || ''
  const effortOk = saved ? supportsEffort(resolveConfig({ ...saved, model: prefs.model || saved.model })) : false
  const modelOptions = [
    { value: '', label: t('desktop.aiPanel.modelDefault', { model: saved ? shortModel(resolveConfig(saved).model) : '—' }) },
    ...[...new Set([...(prefs.model ? [prefs.model] : []), ...models])].map((m) => ({ value: m, label: m })),
  ]
  const scopeOptions = [
    { value: 'vault', label: t('desktop.aiPanel.scope.vault') },
    ...(hasDocument && folder ? [{ value: 'folder', label: t('desktop.aiPanel.scope.folder', { folder }) }] : []),
    ...(hasDocument ? [{ value: 'document', label: t('desktop.aiPanel.scope.document') }] : []),
  ]

  const chip = (s: SourceRef) => (
    <Tip key={s.path} label={s.path} side="top">
      <button
        type="button"
        className="flex max-w-full items-center gap-1 rounded-md border bg-sunken px-1.5 py-0.5 text-xs hover:border-primary"
        onClick={() => onOpen(s.path)}
      >
        <FileText className="size-3 flex-none text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{s.title}</span>
      </button>
    </Tip>
  )

  return (
    <aside className="flex min-h-0 w-[360px] flex-none flex-col border-l bg-card" aria-label={t('desktop.aiPanel.title')}>
      <header className="flex h-[38px] flex-none items-center gap-[7px] border-b px-3">
        <Sparkles className="size-4 text-primary" aria-hidden="true" />
        <span className="flex-1 text-[13px] font-semibold">{t('desktop.aiPanel.title')}</span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t('desktop.aiPanel.close')} onClick={onClose}>
          <X />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 select-text flex-col gap-3 overflow-y-auto px-3 py-3.5" ref={listRef}>
        {messages.length === 0 && (
          <div className="flex flex-col items-start gap-2.5 text-[13px] leading-relaxed text-muted-foreground">
            <p className="m-0">{t('desktop.aiPanel.intro')}</p>
            {!hasDocument && (
              <Button type="button" variant="outline" size="sm" onClick={onWriteWithAI}>
                <Sparkles className="text-primary" /> {t('desktop.ai.writeWithAI')}
              </Button>
            )}
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="max-w-[85%] self-end whitespace-pre-wrap rounded-xl bg-muted px-[11px] py-[7px] text-[13px]">
              {m.text}
            </div>
          ) : m.role === 'error' ? (
            <div key={m.id} className="flex items-start gap-1.5 text-[12.5px] text-destructive" role="alert">
              <CircleAlert className="mt-0.5 size-3.5 flex-none" aria-hidden="true" />
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="flex flex-col gap-2 text-[13px] leading-relaxed">
              {m.result.answer && <div className={ANSWER} dangerouslySetInnerHTML={{ __html: answerHTML(m.result.answer) }} />}
              {m.result.sources.length > 0 && <Sources sources={m.result.sources} chip={chip} />}
              {m.result.findings.length > 0 && <Findings m={m} chip={chip} onPick={(picked) => patchAI(m.id, () => ({ picked }))} onFix={() => fix(m)} busy={busy} />}
              {m.result.changeSet && (
                <ChangeSetView
                  m={m}
                  onApply={(ids) => void apply(m, ids)}
                  onReject={(id) => reject(m, id)}
                  onUndo={() => void undo(m)}
                  onToggleDiff={(id) => patchAI(m.id, (cur) => ({ diffs: { ...cur.diffs, [id]: !cur.diffs[id] } }))}
                />
              )}
              {m.result.rejected.length > 0 && <Refused items={m.result.rejected} />}
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground" aria-live="polite">
            <Sparkles className="size-3.5 flex-none animate-pulse text-primary motion-reduce:animate-none" aria-hidden="true" />
            <span className="truncate">{activity}</span>
          </div>
        )}
      </div>

      <form
        className="flex flex-none flex-col gap-1.5 border-t px-3 pb-2 pt-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input.trim())
        }}
      >
        <Textarea
          className="min-h-0 resize-none bg-sunken text-[13px] select-text"
          rows={2}
          value={input}
          placeholder={t('desktop.aiPanel.placeholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send(input.trim())
            }
          }}
        />
        <div className="flex min-w-0 items-center gap-1.5">
          <Tip label={model} side="top">
            <div className="min-w-0 flex-[0_1_170px]">
              <Select compact label={t('desktop.aiPanel.model')} value={prefs.model} options={modelOptions} onChange={(v) => update({ model: v })} />
            </div>
          </Tip>
          {effortOk ? (
            <Tip label={t('desktop.aiPanel.effort')} side="top">
              <div className="w-[104px] flex-none">
                <Select
                  compact
                  label={t('desktop.aiPanel.effort')}
                  value={prefs.effort}
                  options={EFFORTS.map((e) => ({ value: e.value, label: t(e.label) }))}
                  onChange={(v) => update({ effort: v as EffortPref })}
                />
              </div>
            </Tip>
          ) : (
            // Not a control that ignores clicks: this model takes no effort
            // setting, and the chip says so instead of pretending to change.
            <Tip label={t('desktop.aiPanel.effortUnsupported', { model })} side="top">
              <span className="flex h-7 cursor-help items-center whitespace-nowrap rounded-md border border-dashed px-2 text-xs text-muted-foreground">
                {t('desktop.aiPanel.effortNone')}
              </span>
            </Tip>
          )}
          <span className="flex-1" />
          {busy ? (
            <Tip label={t('desktop.ai.stop')} side="top">
              <Button type="button" variant="outline" size="icon-sm" aria-label={t('desktop.ai.stop')} onClick={stop}>
                <Square className="fill-current" />
              </Button>
            </Tip>
          ) : (
            <Tip label={t('desktop.aiPanel.send')} side="top">
              <Button type="submit" size="icon-sm" aria-label={t('desktop.aiPanel.send')} disabled={!input.trim()}>
                <ArrowUp />
              </Button>
            </Tip>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="flex-none">{t('desktop.aiPanel.scopeLabel')}</span>
          <div className="min-w-0 flex-1">
            <Select compact label={t('desktop.aiPanel.scopeLabel')} value={scopeChoice} options={scopeOptions} onChange={(v) => setScope(v as ScopeChoice)} />
          </div>
        </div>
      </form>
    </aside>
  )
}

function Sources({ sources, chip }: { sources: SourceRef[]; chip: (s: SourceRef) => ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('desktop.aiPanel.sources')}</span>
      <div className="flex flex-wrap gap-1">{sources.map(chip)}</div>
    </div>
  )
}

function Refused({ items }: { items: { path: string; reason: string }[] }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <span>{t('desktop.aiPanel.refused', { count: items.length })}</span>
      {items.map((r, i) => (
        <span key={i} className="font-mono">
          {r.path || '—'}: {r.reason}
        </span>
      ))}
    </div>
  )
}

function Findings({
  m,
  chip,
  onPick,
  onFix,
  busy,
}: {
  m: AIMessage
  chip: (s: SourceRef) => ReactNode
  onPick: (picked: number[]) => void
  onFix: () => void
  busy: boolean
}) {
  const picked = new Set(m.picked)
  const toggle = (i: number, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(i)
    else next.delete(i)
    onPick([...next])
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t('desktop.aiPanel.findings', { count: m.result.findings.length })}
      </span>
      {m.result.findings.map((f, i) => (
        <FindingCard key={i} finding={f} checked={picked.has(i)} onToggle={(on) => toggle(i, on)} chip={chip} />
      ))}
      <Button type="button" variant="secondary" size="xs" className="self-start" disabled={busy || !m.picked.length} onClick={onFix}>
        <Sparkles /> {t('desktop.aiPanel.fixSelected')}
      </Button>
    </div>
  )
}

function FindingCard({
  finding: f,
  checked,
  onToggle,
  chip,
}: {
  finding: ReviewFinding
  checked: boolean
  onToggle: (on: boolean) => void
  chip: (s: SourceRef) => ReactNode
}) {
  const cited = f.sources.map((s) => ({ path: s.path, title: s.path.split('/').pop() ?? s.path }))
  return (
    <label className="flex gap-2 rounded-lg border px-2.5 py-2 [&>input]:accent-primary">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[12.5px] font-semibold">
          <span className={cn('mr-1.5 text-[11px] uppercase', SEVERITY[f.severity].className)}>{t(SEVERITY[f.severity].label)}</span>
          {f.title}
        </span>
        <span className={cn(ANSWER, 'text-[12.5px]')} dangerouslySetInnerHTML={{ __html: answerHTML(f.explanation) }} />
        {f.suggestedFix && <span className="text-xs text-muted-foreground">{t('desktop.aiPanel.suggestedFix', { fix: f.suggestedFix })}</span>}
        {cited.length > 0 && <span className="flex flex-wrap gap-1">{cited.map(chip)}</span>}
      </span>
    </label>
  )
}

function ChangeSetView({
  m,
  onApply,
  onReject,
  onUndo,
  onToggleDiff,
}: {
  m: AIMessage
  onApply: (ids: string[]) => void
  onReject: (id: string) => void
  onUndo: () => void
  onToggleDiff: (id: string) => void
}) {
  const set = m.result.changeSet!
  const pending: string[] = []
  const byFile = new Map<string, StagedChange[]>()
  for (const c of set.changes) {
    if (m.status[c.id] === 'pending') pending.push(c.id)
    byFile.set(c.path, [...(byFile.get(c.path) ?? []), c])
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border px-2.5 py-[9px]">
      <div className="text-[12.5px] font-semibold">{t('desktop.aiPanel.proposes', { count: set.changes.length, files: byFile.size })}</div>
      {set.summary && <p className="m-0 text-[12.5px]">{set.summary}</p>}
      {[...byFile].map(([path, changes]) => (
        <FileChanges key={path} path={path} changes={changes} m={m} onApply={onApply} onReject={onReject} onToggleDiff={onToggleDiff} />
      ))}
      <div className="flex flex-wrap gap-1.5">
        {pending.length > 0 && (
          <Button type="button" size="xs" onClick={() => onApply(pending)}>
            <Check /> {t('desktop.aiPanel.applyAll', { count: pending.length })}
          </Button>
        )}
        {m.applied.length > 0 && !m.undone && (
          <Button type="button" variant="secondary" size="xs" onClick={onUndo}>
            <Undo2 /> {t('desktop.aiPanel.undo')}
          </Button>
        )}
      </div>
      {m.undoConflicts.length > 0 && !m.undone && (
        <p className="m-0 text-xs text-muted-foreground">{t('desktop.aiPanel.undoConflict', { paths: m.undoConflicts.join(', ') })}</p>
      )}
    </div>
  )
}

/** One note's proposed changes, each with its own diff, Apply and Reject. */
function FileChanges({
  path,
  changes,
  m,
  onApply,
  onReject,
  onToggleDiff,
}: {
  path: string
  changes: StagedChange[]
  m: AIMessage
  onApply: (ids: string[]) => void
  onReject: (id: string) => void
  onToggleDiff: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="truncate font-mono text-xs">{path}</span>
      {changes.map((c) => (
        <ChangeRow key={c.id} change={c} status={m.status[c.id]} undone={m.undone} diff={Boolean(m.diffs[c.id])} onApply={onApply} onReject={onReject} onToggleDiff={onToggleDiff} />
      ))}
    </div>
  )
}

function ChangeRow({
  change: c,
  status: s,
  undone,
  diff,
  onApply,
  onReject,
  onToggleDiff,
}: {
  change: StagedChange
  status: ChangeStatus
  undone: boolean
  diff: boolean
  onApply: (ids: string[]) => void
  onReject: (id: string) => void
  onToggleDiff: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5 border-l-2 pl-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium">{t(CHANGE_LABEL[c.type])}</span>
        {s !== 'pending' && (
          <span className={cn('text-muted-foreground', s === 'applied' && 'text-primary')}>
            {s === 'applied' && undone ? t('desktop.aiPanel.undone') : t(STATUS_LABEL[s])}
          </span>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="xs" onClick={() => onToggleDiff(c.id)}>
          {diff ? <EyeOff /> : <Eye />}
          {t(diff ? 'desktop.aiPanel.hideChanges' : 'desktop.aiPanel.showChanges')}
        </Button>
        {s === 'pending' && (
          <>
            <Button type="button" variant="secondary" size="xs" onClick={() => onApply([c.id])}>
              <Check /> {t('desktop.aiPanel.apply')}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => onReject(c.id)}>
              <X /> {t('desktop.aiPanel.reject')}
            </Button>
          </>
        )}
      </div>
      {diff && <DiffView before={c.view?.before ?? c.base ?? ''} after={c.view?.after ?? c.preview} />}
    </div>
  )
}

/** Changed lines with a little context; long unchanged stretches fold away. */
function DiffView({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after)
  const keep = lines.map((l, i) => l.kind !== 'same' || [-1, 1].some((d) => lines[i + d] && lines[i + d].kind !== 'same'))
  return (
    <div className="max-h-[280px] overflow-auto rounded-[5px] bg-sunken font-mono text-xs leading-normal">
      {lines.map((l, i) =>
        keep[i] ? (
          <div
            key={i}
            data-kind={l.kind}
            className={cn(
              'whitespace-pre-wrap break-words px-2',
              l.kind === 'add' && 'bg-primary/14',
              l.kind === 'del' && 'bg-destructive/14 text-muted-foreground line-through',
            )}
          >
            <span className={cn('select-none', l.kind === 'add' && 'text-primary')} aria-hidden="true">
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
            </span>
            {l.text || ' '}
          </div>
        ) : keep[i - 1] ? (
          <div key={i} className="px-2 text-muted-foreground">
            ⋯
          </div>
        ) : null,
      )}
    </div>
  )
}
