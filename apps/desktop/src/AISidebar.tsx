// The AI panel on the right: ask in words, and the answer is written into the
// open document — not printed as a chat reply to copy over by hand.
//
// Each edit lands as one transaction and leaves a card with the model's own
// summary, "Show changes" (a line diff of the markdown) and Undo. Undo puts
// back the document exactly as it was, and only while nothing has been typed
// since; after that it would throw away the user's edits too.
import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { listModels, PROVIDER_PRESETS, resolveConfig, supportsEffort } from '@meetcc/ai'
import type { Settings } from '@meetcc/shared/types'
import { t, type MessageKey } from '@meetcc/shared/i18n'
import { ArrowUp, Check, CircleAlert, Eye, EyeOff, Sparkles, Square, Undo2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/Tip'
import { configuredClient, loadAiSettings, loadSessionAI, saveSessionAI, type EffortPref, type SessionAI } from './aiSettings'
import { isAbort, runEditorAI, type EditOp } from './editor/editorAI'
import { applyEdit, contextOf } from './editor/editorOps'
import { lineDiff } from './editor/diff'
import { Select } from './Select'

type Message =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; summary: string; before: string; after: string; undone: boolean; diff: boolean; stale: boolean }
  | { id: number; role: 'error'; text: string }

const DEFAULT_SUMMARY: Record<EditOp['op'], MessageKey> = {
  replace: 'desktop.aiPanel.applied.replace',
  insert: 'desktop.aiPanel.applied.insert',
  append: 'desktop.aiPanel.applied.append',
  replaceDocument: 'desktop.aiPanel.applied.document',
}

const EFFORTS: { value: EffortPref; label: MessageKey }[] = [
  { value: 'auto', label: 'desktop.aiPanel.effort.auto' },
  { value: 'low', label: 'desktop.aiPanel.effort.low' },
  { value: 'medium', label: 'desktop.aiPanel.effort.medium' },
  { value: 'high', label: 'desktop.aiPanel.effort.high' },
]

let nextId = 0

/** "ag/gemini-3.8-flash" → "gemini-3.8-flash": the gateway prefix is noise in a picker label. */
const shortModel = (m: string): string => m.split('/').pop() || '—'

export function AISidebar({
  editor,
  docTitle,
  onClose,
  onWriteWithAI,
}: {
  editor: Editor | null
  docTitle: string
  onClose: () => void
  onWriteWithAI: () => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
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
    }
  }, [])

  // Another note is another conversation; a request still running belongs to
  // the document that was left.
  useEffect(() => {
    abortRef.current?.abort()
    setMessages([])
    setBusy(false)
  }, [editor])

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, busy])

  const update = (patch: Partial<SessionAI>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    saveSessionAI(next)
  }
  const patchMessage = (id: number, patch: Partial<Extract<Message, { role: 'ai' }>>) =>
    setMessages((all) => all.map((m) => (m.id === id && m.role === 'ai' ? { ...m, ...patch } : m)))

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || !editor || busy) return
    if (!editor.isEditable) {
      setMessages((all) => [...all, { id: ++nextId, role: 'error', text: t('desktop.aiPanel.inlineOpen') }])
      return
    }
    const { from, to } = editor.state.selection
    setMessages((all) => [...all, { id: ++nextId, role: 'user', text }])
    setInput('')
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    // Read-only while the model works, so the range it was asked about is
    // still the range its answer goes into.
    editor.setEditable(false, false)
    try {
      const client = await configuredClient()
      const op = await runEditorAI(client, { kind: 'custom', instruction: text, ctx: contextOf(editor, from, to) }, ctrl.signal)
      if (ctrl.signal.aborted || editor.isDestroyed) return
      editor.setEditable(true, false)
      const before = editor.getMarkdown()
      applyEdit(editor, op, from, to)
      const after = editor.getMarkdown()
      setMessages((all) => [
        ...all,
        {
          id: ++nextId,
          role: 'ai',
          summary: op.summary ?? t(DEFAULT_SUMMARY[op.op]),
          before,
          after,
          undone: false,
          diff: false,
          stale: false,
        },
      ])
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) return
      setMessages((all) => [...all, { id: ++nextId, role: 'error', text: (e as Error).message }])
    } finally {
      if (!editor.isDestroyed) editor.setEditable(true, false)
      if (abortRef.current === ctrl) setBusy(false)
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    if (editor && !editor.isDestroyed) editor.setEditable(true, false)
    setBusy(false)
  }

  const undo = (m: Extract<Message, { role: 'ai' }>) => {
    if (!editor || editor.isDestroyed) return
    if (editor.getMarkdown() !== m.after) return patchMessage(m.id, { stale: true })
    editor.commands.setContent(m.before, { contentType: 'markdown', emitUpdate: true })
    patchMessage(m.id, { undone: true })
  }

  const model = prefs.model || saved?.model || ''
  const effortOk = saved ? supportsEffort(resolveConfig({ ...saved, model: prefs.model || saved.model })) : false
  const modelOptions = [
    { value: '', label: t('desktop.aiPanel.modelDefault', { model: saved ? shortModel(resolveConfig(saved).model) : '—' }) },
    ...[...new Set([...(prefs.model ? [prefs.model] : []), ...models])].map((m) => ({ value: m, label: m })),
  ]

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
            <p className="m-0">{t(editor ? 'desktop.aiPanel.intro' : 'desktop.aiPanel.noDocument')}</p>
            {!editor && (
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
              <p className="m-0">{m.summary}</p>
              <div className="flex flex-col gap-2 rounded-lg border px-2.5 py-[9px]">
                <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                  {m.undone ? <Undo2 className="size-3.5" aria-hidden="true" /> : <Check className="size-3.5 text-primary" aria-hidden="true" />}
                  <span>{t(m.undone ? 'desktop.aiPanel.undone' : 'desktop.aiPanel.changed')}</span>
                </div>
                <div className="flex gap-1.5">
                  <Button type="button" variant="secondary" size="xs" onClick={() => patchMessage(m.id, { diff: !m.diff })}>
                    {m.diff ? <EyeOff /> : <Eye />}
                    {t(m.diff ? 'desktop.aiPanel.hideChanges' : 'desktop.aiPanel.showChanges')}
                  </Button>
                  {!m.undone && (
                    <Button type="button" variant="secondary" size="xs" onClick={() => undo(m)}>
                      <Undo2 /> {t('desktop.aiPanel.undo')}
                    </Button>
                  )}
                </div>
                {m.stale && !m.undone && <p className="m-0 text-xs text-muted-foreground">{t('desktop.aiPanel.editedSince')}</p>}
                {m.diff && <DiffView before={m.before} after={m.after} />}
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Sparkles className="size-3.5 animate-pulse text-primary motion-reduce:animate-none" aria-hidden="true" /> {t('desktop.ai.writing')}
          </div>
        )}
      </div>

      <form
        className="flex flex-none flex-col gap-1.5 border-t px-3 pb-2 pt-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <Textarea
          className="min-h-0 resize-none bg-sunken text-[13px] select-text"
          rows={2}
          value={input}
          disabled={!editor}
          placeholder={t('desktop.aiPanel.placeholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
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
              <Button type="submit" size="icon-sm" aria-label={t('desktop.aiPanel.send')} disabled={!editor || !input.trim()}>
                <ArrowUp />
              </Button>
            </Tip>
          )}
        </div>
        <p className="m-0 min-h-[1em] truncate text-[11.5px] text-muted-foreground">
          {editor ? t('desktop.aiPanel.scope', { title: docTitle || t('desktop.composer.untitled') }) : ''}
        </p>
      </form>
    </aside>
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
