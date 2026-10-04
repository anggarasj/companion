// "Write with AI": a new document, written by the configured provider and
// saved as a real .md file in the vault — not a chat answer.
//
// Meeting documents go through @meetcc/ai's existing docgen pipeline (context
// → draft → critique → revise, grounded in the transcript); a custom brief
// runs through that same pipeline. Without a meeting, the document is written
// from the prompt plus whatever notes the user ticked — and nothing else: the
// scope list below is exactly what leaves the machine.
import { useEffect, useRef, useState } from 'react'
import { generateDoc, DOC_META, type CustomDoc } from '@meetcc/ai'
import type { DocType } from '@meetcc/shared/types'
import type { Vault, VaultNote } from '@meetcc/vault'
import { t, type MessageKey } from '@meetcc/shared/i18n'
import { FolderInput, Sparkles, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { configuredClient } from './aiSettings'
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

/** Hard cap on notes read for folder scope, whatever the folder holds. */
const FOLDER_NOTES = 20

export interface ComposerProps {
  vault: Vault
  folders: string[]
  /** Folder the new file lands in by default ('' is the vault root). */
  folder: string
  /** The note on screen, offered as context. */
  current: VaultNote | null
  /** Vault paths, for the folder scope. */
  notePaths: string[]
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
  const [useFolder, setUseFolder] = useState(false)
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
        const sources: { title: string; body: string }[] = []
        if (useDoc && current) sources.push({ title: current.title, body: current.body })
        if (useFolder) {
          const inFolder = props.notePaths
            .filter((rel) => (folder ? rel.startsWith(`${folder}/`) : !rel.includes('/')))
            .slice(0, FOLDER_NOTES)
          for (const rel of inFolder) {
            const n = await vault.readNote(rel)
            if (n.id !== current?.id || !useDoc) sources.push({ title: n.title || rel, body: n.body })
          }
        }
        const brief = kind === 'custom' ? prompt.trim() : `${DOC_META[kind].label}. ${prompt.trim()}`
        markdown = await writeDocument(client, brief, sources, ctrl.signal)
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
                <input type="checkbox" checked={useFolder} onChange={(e) => setUseFolder(e.target.checked)} />
                {t('desktop.composer.scopeFolder', { count: FOLDER_NOTES })}
              </label>
            )}
            {!useMeeting && !useDoc && !useFolder && <p className={hint}>{t('desktop.composer.scopeNone')}</p>}
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
      </DialogContent>
    </Dialog>
  )
}
