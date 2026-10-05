// "Write with AI": a new document, written by the configured provider and
// saved as a real .md file in the vault — not a chat answer.
//
// Meeting documents go through @meetcc/ai's existing docgen pipeline (context
// → draft → critique → revise, grounded in the transcript); a custom brief
// runs through that same pipeline. Without a meeting, the document is written
// from the prompt plus the context ticked below and nothing else: the open
// note, and either the notes the Vault Agent finds relevant inside the chosen
// scope or exactly the files picked by hand. Grounded documents are drafted,
// checked against their sources and revised, and the sources are shown before
// anything is saved.
import { useEffect, useRef, useState } from 'react'
import { generateDoc, DOC_META, type CustomDoc } from '@meetcc/ai'
import type { DocType } from '@meetcc/shared/types'
import type { Vault, VaultNote } from '@meetcc/vault'
import { t, type MessageKey } from '@meetcc/shared/i18n'
import { FileText, FolderInput, Sparkles, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { configuredClient } from './aiSettings'
import { describeActivity, gatherSources } from './agent/runner'
import type { Workspace } from './agent/types'
import { abortable, isAbort, splitTitle, writeDocument } from './editor/editorAI'
import { meetingOf, readTranscript } from './MeetingMeta'
import { Select } from './Select'

type Kind = 'custom' | DocType

const KINDS: { value: Kind; label: MessageKey }[] = [
  { value: 'custom', label: 'desktop.composer.kind.custom' },
  { value: 'prd', label: 'desktop.composer.kind.prd' },
  { value: 'brd', label: 'desktop.composer.kind.brd' },
  { value: 'recap', label: 'desktop.composer.kind.recap' },
  { value: 'notulen', label: 'desktop.composer.kind.notulen' },
]

type Scope = 'folder' | 'vault' | 'files'

const SCOPES: { value: Scope; label: MessageKey }[] = [
  { value: 'folder', label: 'desktop.composer.scope.folder' },
  { value: 'vault', label: 'desktop.composer.scope.vault' },
  { value: 'files', label: 'desktop.composer.scope.files' },
]

/** A path under a dot folder, which the tree hides. */
const HIDDEN = /(^|\/)\./

/** Rows the file picker renders at once; the filter narrows the rest. */
const PICKER_ROWS = 200

interface Ready {
  title: string
  body: string
  sources: { path: string; title: string }[]
}

export interface ComposerProps {
  vault: Vault
  folders: string[]
  /** Folder the new file lands in by default ('' is the vault root). */
  folder: string
  /** The note on screen, offered as context. */
  current: VaultNote | null
  /** Vault paths, for the file picker. */
  notePaths: string[]
  /** The vault as the agent reads it, for finding relevant notes. */
  workspace: () => Workspace
  /** Pre-select a document type (from "Generate document" on a meeting). */
  kind?: Kind
  onCreate: (title: string, body: string, folder: string) => Promise<void>
  onClose: () => void
}

export function AIComposer(props: ComposerProps) {
  const { vault, current } = props
  const isMeeting = Boolean(current && current.platform && current.platform !== 'manual')
  const [kind, setKind] = useState<Kind>(props.kind ?? 'custom')
  const [prompt, setPrompt] = useState('')
  const [folder, setFolder] = useState(props.folder)
  const [useMeeting, setUseMeeting] = useState(isMeeting)
  const [useDoc, setUseDoc] = useState(false)
  const [useNotes, setUseNotes] = useState(true)
  const [scope, setScope] = useState<Scope>('folder')
  const [picked, setPicked] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [ready, setReady] = useState<Ready | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  // A custom document is its prompt; a built-in type needs a prompt or a meeting.
  const hasPrompt = prompt.trim().length > 0
  const canRun = !busy && (kind === 'custom' ? hasPrompt : hasPrompt || (isMeeting && useMeeting))

  async function generate(): Promise<void> {
    if (!canRun) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setBusy(t('desktop.ai.writing'))
    setError(null)
    try {
      const client = await configuredClient()
      let markdown: string
      const fallbackTitle = kind === 'custom' ? t('desktop.composer.untitled') : DOC_META[kind].label
      if (useMeeting && current && isMeeting) {
        const lines = await readTranscript(current, vault)
        if (!lines.length) throw new Error(t('desktop.composer.noTranscript'))
        const type: DocType | CustomDoc = kind === 'custom' ? { label: t('desktop.composer.kind.custom'), instruction: prompt.trim() } : kind
        // A brief on a built-in type is steering, not a source of facts —
        // docgen's template block says exactly that to the model.
        const template = kind !== 'custom' && prompt.trim() ? { name: 'brief', instructions: prompt.trim() } : undefined
        markdown = await abortable(
          generateDoc(client, meetingOf(current, lines), null, type, (step, total, label) => {
            if (!ctrl.signal.aborted) setBusy(`${label} · ${Math.round((step / Math.max(total, 1)) * 100)}%`)
          }, template),
          ctrl.signal,
        )
        markdown = markdown.startsWith('# ') ? markdown : `# ${fallbackTitle} — ${current.title}\n\n${markdown}`
      } else {
        const brief = kind === 'custom' ? prompt.trim() : `${DOC_META[kind].label}. ${prompt.trim()}`
        const sources: { title: string; body: string }[] = []
        if (useDoc && current) sources.push({ title: current.title, body: current.body })
        let found: { path: string; title: string; body: string }[] = []
        if (useNotes && scope === 'files') {
          // Picked by hand is a hard override: exactly these, nothing searched.
          // One at a time: each read is a round trip through Rust, and a long pick list should not flood it.
          for (const path of picked) {
            const n = await vault.readNote(path)
            found.push({ path, title: n.title || path, body: n.body })
          }
        } else if (useNotes) {
          setBusy(t('desktop.composer.finding'))
          found = await gatherSources({
            client,
            brief,
            workspace: props.workspace(),
            scope: scope === 'folder' ? { kind: 'folder', folder } : { kind: 'vault' },
            signal: ctrl.signal,
            onActivity: (a) => !ctrl.signal.aborted && setBusy(describeActivity(a)),
          })
        }
        // The open note is already in, when ticked; reading it twice wastes budget.
        found = found.filter((s) => !(useDoc && current && s.title === current.title && s.body === current.body))
        sources.push(...found)
        markdown = await writeDocument(client, brief, sources, ctrl.signal, (stage) => {
          if (!ctrl.signal.aborted) setBusy(t(stage === 'draft' ? 'desktop.ai.writing' : stage === 'review' ? 'desktop.composer.stage.review' : 'desktop.composer.stage.revise'))
        })
        if (useNotes) {
          if (ctrl.signal.aborted) return
          const { title, body } = splitTitle(markdown, fallbackTitle)
          const cited = found.length ? `${body.trimEnd()}\n\n## ${t('desktop.composer.sourcesHeading')}\n\n${found.map((s) => `- \`${s.path}\``).join('\n')}\n` : body
          // Shown before saving: which notes the document stands on, and where it goes.
          setReady({ title, body: cited, sources: found.map(({ path, title }) => ({ path, title })) })
          return
        }
      }
      if (ctrl.signal.aborted) return
      const { title, body } = splitTitle(markdown, fallbackTitle)
      setBusy(t('desktop.composer.saving'))
      await props.onCreate(title, body, folder)
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) return
      setError((e as Error).message)
    } finally {
      if (abortRef.current === ctrl) setBusy(null)
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    setBusy(null)
  }

  async function create(r: Ready): Promise<void> {
    setBusy(t('desktop.composer.saving'))
    setError(null)
    try {
      await props.onCreate(r.title, r.body, folder)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Dot folders are hidden from the tree, so from the picker too; the filter matches anywhere in the path.
  const match = new RegExp(filter.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const pickable = props.notePaths.filter((p) => !HIDDEN.test(p) && match.test(p))
  const pickedSet = new Set(picked)
  const togglePick = (p: string, on: boolean) => setPicked(on ? [...picked, p] : picked.filter((x) => x !== p))

  const hint = 'm-0 text-muted-foreground'
  const check = 'flex items-center gap-[7px] [&>input]:accent-primary'

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-[12vh] w-[min(560px,92vw)] max-w-none translate-y-0 gap-3 rounded-lg bg-popover px-[18px] py-4 sm:max-w-none"
        // While a request runs, Escape stops it and a click outside does nothing.
        onEscapeKeyDown={(e) => {
          if (!busy) return
          e.preventDefault()
          stop()
        }}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        {ready ? (
          <div className="flex flex-col gap-3">
            <DialogTitle className="m-0 flex items-center gap-1.5 text-[15px] font-semibold">
              <Sparkles className="size-4 text-primary" aria-hidden="true" /> {ready.title}
            </DialogTitle>
            <div className="flex flex-col gap-1.5 text-[12.5px]">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('desktop.composer.sourcesUsed', { count: ready.sources.length })}
              </span>
              {ready.sources.length ? (
                <ul className="m-0 flex max-h-[180px] list-none flex-col gap-1 overflow-y-auto p-0">
                  {ready.sources.map((s) => (
                    <li key={s.path} className="flex min-w-0 items-center gap-1.5">
                      <FileText className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">{s.title}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{s.path}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={hint}>{t('desktop.composer.noSources')}</p>
              )}
              <p className={hint}>{t('desktop.composer.destination', { path: folder || t('desktop.vault.rootFolder') })}</p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => setReady(null)}>
                {t('desktop.composer.back')}
              </Button>
              <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => void create(ready)}>
                <Sparkles />
                {t('desktop.composer.create')}
              </Button>
            </div>
            {error && (
              <p className="m-0 text-[12.5px] text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : (
        <form
          className="flex flex-col gap-3"
          aria-label={t('desktop.ai.writeWithAI')}
          onSubmit={(e) => {
            e.preventDefault()
            void generate()
          }}
        >
          <DialogTitle className="m-0 flex items-center gap-1.5 text-[15px] font-semibold">
            <Sparkles className="size-4 text-primary" aria-hidden="true" /> {t('desktop.composer.title')}
          </DialogTitle>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('desktop.composer.kind')}>
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={kind === k.value}
                className={cn(
                  'h-[26px] rounded-full border px-2.5 text-[12.5px] text-foreground disabled:opacity-50',
                  kind === k.value && 'border-primary text-primary',
                )}
                onClick={() => setKind(k.value)}
                disabled={Boolean(busy)}
              >
                {t(k.label)}
              </button>
            ))}
          </div>
          <Textarea
            className="resize-y bg-sunken text-sm select-text"
            autoFocus
            rows={3}
            value={prompt}
            disabled={Boolean(busy)}
            placeholder={t(kind === 'custom' ? 'desktop.composer.promptPlaceholder' : 'desktop.composer.briefPlaceholder')}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void generate()
              }
            }}
          />
          <fieldset className="m-0 flex flex-col gap-[5px] border-0 p-0 text-[12.5px]" disabled={Boolean(busy)}>
            <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('desktop.composer.context')}
            </legend>
            {isMeeting && (
              <label className={check}>
                <input type="checkbox" checked={useMeeting} onChange={(e) => setUseMeeting(e.target.checked)} />
                {t('desktop.composer.scopeMeeting', { title: current?.title ?? '' })}
              </label>
            )}
            {current && !(isMeeting && useMeeting) && (
              <label className={check}>
                <input type="checkbox" checked={useDoc} onChange={(e) => setUseDoc(e.target.checked)} />
                {t('desktop.composer.scopeDocument', { title: current.title })}
              </label>
            )}
            {!(isMeeting && useMeeting) && (
              <label className={check}>
                <input type="checkbox" checked={useNotes} onChange={(e) => setUseNotes(e.target.checked)} />
                {t('desktop.composer.autoFind')}
              </label>
            )}
            {!(isMeeting && useMeeting) && useNotes && (
              <div className="ml-[21px] flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-muted-foreground">
                  <span>{t('desktop.composer.scope')}</span>
                  <Select
                    label={t('desktop.composer.scope')}
                    value={scope}
                    options={SCOPES.map((s) => ({ value: s.value, label: t(s.label) }))}
                    onChange={(v) => setScope(v as Scope)}
                  />
                </label>
                {scope === 'files' && (
                  <div className="flex flex-col gap-1">
                    <Input
                      className="h-7 bg-sunken text-[12.5px]"
                      value={filter}
                      placeholder={t('desktop.composer.filesFilter')}
                      aria-label={t('desktop.composer.filesFilter')}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                    <div className="flex max-h-[150px] flex-col gap-0.5 overflow-y-auto rounded-md border px-2 py-1">
                      {pickable.slice(0, PICKER_ROWS).map((p) => (
                        <label key={p} className={cn(check, 'min-w-0')}>
                          <input
                            type="checkbox"
                            checked={pickedSet.has(p)}
                            onChange={(e) => togglePick(p, e.target.checked)}
                          />
                          <span className="truncate font-mono text-xs">{p}</span>
                        </label>
                      ))}
                      {!pickable.length && <p className={hint}>{t('desktop.composer.filesNone')}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground">{t('desktop.composer.filesPicked', { count: picked.length })}</span>
                  </div>
                )}
              </div>
            )}
            {!useMeeting && !useDoc && !useNotes && <p className={hint}>{t('desktop.composer.scopeNone')}</p>}
          </fieldset>
          <div className="flex items-center gap-2">
            <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
              <FolderInput className="size-3.5" aria-hidden="true" />
              <span>{t('desktop.vault.saveTo')}</span>
              <Select
                label={t('desktop.vault.saveTo')}
                value={folder}
                options={[{ value: '', label: t('desktop.vault.rootFolder') }, ...props.folders.map((p) => ({ value: p, label: p }))]}
                onChange={setFolder}
              />
            </label>
            {busy ? (
              <>
                <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <Sparkles className="size-3.5 animate-pulse text-primary motion-reduce:animate-none" aria-hidden="true" /> {busy}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={stop}>
                  <Square />
                  {t('desktop.ai.stop')}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
                  {t('desktop.settings.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={!canRun}>
                  <Sparkles />
                  {t('desktop.composer.generate')}
                </Button>
              </>
            )}
          </div>
          {error && (
            <p className="m-0 text-[12.5px] text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
