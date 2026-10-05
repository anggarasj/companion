import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openDatabase, type SqlDriver } from '@meetcc/store'
import { createIndex, search, Vault, uuidV7, type VaultNote } from '@meetcc/vault'
import { tauriVaultIo } from './vaultIo'
import { t, formatDate, type LangPref } from '@meetcc/shared/i18n'
import type { DocType } from '@meetcc/shared/types'
import { loadLangPref } from './lang'
import { DateField } from './DateField'
import { MeetingMeta } from './MeetingMeta'
import { Select, type Option, type Tone } from './Select'
import { activeSponsorLinks } from './sponsor'
import { NoteTree } from './NoteTree'
import { docPath, saveTarget, settleSaved } from './saveTarget'
import { loadAutosave } from './editorPrefs'
import { drainSpool } from './spool'
import { buildTree, folderPaths, withEmptyFolders } from './tree'
import { hideCopiedOriginals, inboxSearchResults, isIncomingMeeting } from './sidebarResults'
import { loadThemePref, type ThemePref } from './theme'
import { NoteEditor } from './NoteEditor'
import UpdateBanner from './UpdateBanner'
import { AIComposer } from './AIComposer'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { AISidebar } from './AISidebar'
import { UNSAVED_DOC, vaultWorkspace, type OpenBoard } from './agent/tools'
import { pdfText } from './pdfText'
import { mermaidToBoard } from './mermaidBoard'
import { contextOf } from './editor/editorOps'
import { VaultList } from './VaultList'
import { PageHeader } from './PageHeader'
import { FileView, isPdf } from './FileView'
import { EMPTY_BOARD, isBoard, newBoardPath } from './board'
import { PageMenu } from './PageMenu'
import { ExportModal } from './ExportModal'
import { loadPanes, savePanes, type Panes } from './panes'
import { loadVaults, saveVaults, withCurrent, type VaultEntry } from './vaults'
import type { Editor } from '@tiptap/core'
import {
  CircleAlert,
  Coffee,
  Copy,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FolderTree,
  HardDrive,
  Heart,
  Library,
  List,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Save,
  Shapes,
  Search,
  Settings,
  Sparkles,
  Sun,
  TriangleAlert,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { useToast } from './toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/Segmented'
import { Tip } from '@/components/Tip'
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { openSettingsWindow } from './openSettingsWindow'
import { useDesktopPreferences } from './useDesktopPreferences'
import { themeLabel } from './preferenceLabels'
import {
  SETTINGS_ACTION_EVENT,
  SETTINGS_PREFERENCES_EVENT,
  SETTINGS_VAULT_CHANGED_EVENT,
  type SettingsAction,
  type SettingsPreferences,
} from './settingsEvents'

// Excalidraw is ~2 MB; load it the first time a board opens, not at startup.
const Whiteboard = lazy(() => import('./Whiteboard').then((m) => ({ default: m.Whiteboard })))

/** The Companion mark from assets/brand/logo-mark.svg, inlined. */
function BrandMark() {
  return (
    <svg className="size-6 flex-none" viewBox="0 0 32 32" role="img" aria-label="Meet Companion">
      <rect width="32" height="32" rx="7" fill="#0a0a0a" />
      <path
        d="M10 7 H22 A4 4 0 0 1 26 11 V17 A4 4 0 0 1 22 21 H14.5 L10 25.5 V21 A4 4 0 0 1 6 17 V11 A4 4 0 0 1 10 7 Z"
        fill="#4ade80"
      />
      <rect x="10" y="11.2" width="12" height="2.6" rx="1.3" fill="#0a0a0a" />
      <rect x="10" y="15.4" width="7" height="2.6" rx="1.3" fill="#0a0a0a" opacity=".55" />
    </svg>
  )
}

function PaneButton({ on, label, onClick, icon: Icon }: { on: boolean; label: string; onClick: () => void; icon: LucideIcon }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        className={cn(
          'grid h-6 w-[26px] place-items-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground',
          on && 'text-foreground',
        )}
        aria-pressed={on}
        aria-label={label}
        onClick={onClick}
      >
        <Icon className="size-4" />
      </button>
    </Tip>
  )
}

/** Sponsor links carry a text glyph (sponsor.ts is shared with the extension); the desktop draws an icon instead. */
const SPONSOR_ICON: Record<string, LucideIcon> = { github: Heart, saweria: Coffee }

const KICKER = 'text-[11px] font-semibold uppercase leading-none tracking-widest text-muted-foreground'
const COUNT = 'ml-auto text-xs tabular-nums text-muted-foreground'
const HEAD_BTN =
  'grid size-[26px] flex-none place-items-center rounded-md text-muted-foreground hover:text-primary disabled:cursor-default disabled:opacity-45'
const LIST = 'm-0 min-h-0 min-w-0 flex-1 list-none overflow-y-auto overflow-x-hidden px-2 pb-3 pt-0'
const EMPTY_HINT = 'p-2.5 text-[12.5px] leading-normal text-muted-foreground'
const CRUMB = "truncate whitespace-nowrap before:mx-1.5 before:opacity-50 before:content-['/']"
const BAR = 'mt-3 flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-xs'

/** A row in the search results and the inbox: title over its metadata. */
const noteItem = (active: boolean): string =>
  cn(
    'flex w-full min-w-0 flex-col gap-[3px] rounded-lg border border-transparent px-2.5 py-2 text-left text-foreground transition-colors hover:border-border hover:bg-muted',
    active && 'border-input bg-muted shadow-[inset_3px_0_0_var(--primary)] hover:border-input',
  )
const NOTE_TITLE = 'truncate text-[13px] font-medium leading-snug text-foreground'

interface NoteHeader {
  rel: string
  id: string
  sessionKey: string
  /** Set when this note is an edited copy of a delivered meeting. */
  source?: string
  title: string
  updatedAt: string
  /** `manual` for a note written here; the meeting platform for a delivered one. */
  platform: string
  startedAt?: string
  participants: number
  /** A delivered note has no body until the extension sends the summary. */
  hasBody: boolean
}

const PLATFORM_LABELS: Record<string, string> = {
  'google-meet': 'Google Meet',
  'microsoft-teams': 'Microsoft Teams',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
  import: 'Impor',
}

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform
}

/** Dot folders are tool state (.obsidian, .assets, .trash), not notes. */
/** A vault PDF's text, for the AI agent. */
async function vaultPdfText(rel: string): Promise<string> {
  const bytes: ArrayBuffer = await invoke('read_vault_bytes', { rel })
  return pdfText(bytes)
}

const hiddenPath = (p: string): boolean => p.split('/').some((part) => part.startsWith('.'))

function dayOf(iso?: string): string {
  return iso ? iso.slice(0, 10) : ''
}

// Stored values stay English whatever the interface language: the note file is
// data other tools read, and a status whose spelling changed with the UI would
// make two notes written in two languages incomparable.
const STATUSES = ['', 'To Do', 'In Progress', 'Blocked', 'Done'] as const
const PRIORITIES = ['', 'Low', 'Medium', 'High', 'Urgent'] as const

const STATUS_LABEL: Record<string, string> = {
  'To Do': 'desktop.status.todo',
  'In Progress': 'desktop.status.inProgress',
  Blocked: 'desktop.status.blocked',
  Done: 'desktop.status.done',
}
const PRIORITY_LABEL: Record<string, string> = {
  Low: 'desktop.priority.low',
  Medium: 'desktop.priority.medium',
  High: 'desktop.priority.high',
  Urgent: 'desktop.priority.urgent',
}
/** Where each value sits on the palette's existing scale. */
const TONES: Record<string, Tone> = {
  'To Do': 'neutral',
  'In Progress': 'info',
  Blocked: 'danger',
  Done: 'success',
  Low: 'neutral',
  Medium: 'info',
  High: 'warning',
  Urgent: 'danger',
}

const optionLabel = (map: Record<string, string>, value: string): string =>
  value ? t(map[value] as Parameters<typeof t>[0]) : t('desktop.field.none')

/**
 * The choices to offer, plus whatever the note already holds.
 *
 * A note written elsewhere — by hand, or by a future version — can carry a
 * status this build does not know. Keeping it in the list means selecting
 * something else is a choice rather than the only way to make the control
 * agree with the file.
 */
function options(
  values: readonly string[],
  labels: Record<string, string>,
  current: string | undefined,
): Option[] {
  const known = values.map((v) => ({ value: v, label: optionLabel(labels, v), tone: TONES[v] }))
  // A value from another version has no tone — neutral is the honest colour
  // for "this build does not know what this means".
  return current && !values.includes(current)
    ? [...known, { value: current, label: current }]
    : known
}

/**
 * The ticket half of a note: what the body cannot carry as prose.
 *
 * The values are free-form in the file (frontmatter is hand-editable markdown,
 * not a schema), so the selects offer a set without enforcing it — a note
 * carrying a value from somewhere else keeps it.
 */
function TicketFields({
  note,
  onChange,
}: {
  note: VaultNote
  onChange: (patch: Partial<VaultNote>) => void
}) {
  const pick = (value: string): string | undefined => value || undefined

  // Only properties the note already carries are shown. A note is a markdown
  // file someone can edit by hand, so a value set in the file still appears
  // here; an empty one stays out of the document view entirely.
  const set = {
    status: Boolean(note.status),
    priority: Boolean(note.priority),
    assignee: Boolean(note.assignee),
    due: Boolean(note.dueDate),
  }
  if (!Object.values(set).some(Boolean)) return null
  const show = (field: keyof typeof set): boolean => set[field]

  const field = 'flex min-w-0 flex-col gap-[5px]'
  // Direct children only: the date field draws its own value in a nested span.
  const caption = 'text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'

  // A grid, not a wrapping flex row: equal columns keep the controls the same
  // width, and a shared height keeps their boxes on one baseline.
  return (
    <div className="mb-3.5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-x-[18px] gap-y-2.5 border-b pb-3.5">
      {show('status') && (
      <label className={field}>
        <span className={caption}>{t('desktop.field.status')}</span>
        <Select
          label={t('desktop.field.status')}
          value={note.status ?? ''}
          options={options(STATUSES, STATUS_LABEL, note.status)}
          onChange={(v) => onChange({ status: pick(v) })}
        />
      </label>
      )}
      {show('priority') && (
      <label className={field}>
        <span className={caption}>{t('desktop.field.priority')}</span>
        <Select
          label={t('desktop.field.priority')}
          value={note.priority ?? ''}
          options={options(PRIORITIES, PRIORITY_LABEL, note.priority)}
          onChange={(v) => onChange({ priority: pick(v) })}
        />
      </label>
      )}
      {show('assignee') && (
      <label className={field}>
        <span className={caption}>{t('desktop.field.assignee')}</span>
        <Input
          className="h-[34px] w-full bg-sunken dark:bg-sunken"
          value={note.assignee ?? ''}
          placeholder={t('desktop.field.assigneePlaceholder')}
          onChange={(e) => onChange({ assignee: pick(e.target.value) })}
        />
      </label>
      )}
      {show('due') && (
      <label className={field}>
        <span className={caption}>{t('desktop.field.due')}</span>
        <DateField value={note.dueDate ?? ''} onChange={(v) => onChange({ dueDate: pick(v) })} />
      </label>
      )}
    </div>
  )
}

export default function App() {
  const [vault, setVault] = useState<Vault | null>(null)
  const [notes, setNotes] = useState<NoteHeader[]>([])
  const [driver, setDriver] = useState<SqlDriver | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState<VaultNote | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'notes' | 'inbox'>('notes')
  const [notesView, setNotesView] = useState<'tree' | 'list'>(() => {
    try {
      return (localStorage.getItem('companion:notes-view') as 'tree' | 'list') || 'tree'
    } catch {
      return 'tree'
    }
  })
  const [exportOpen, setExportOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [autosave, setAutosave] = useState(loadAutosave)
  // Bumped only when a different note is opened, so the editor remounts then
  // and never mid-typing — a save can change the note's id (a delivered
  // meeting becomes its copy), which keying by id used to turn into a jump.
  const [editorKey, setEditorKey] = useState(0)
  // The note as last rendered, for a save to see what was typed during its
  // write, and the write in flight, so two saves never race into two copies.
  const noteRef = useRef<VaultNote | null>(null)
  noteRef.current = note
  const savingRef = useRef<Promise<boolean> | null>(null)
  // Search fell back to titles because the SQLite index would not open.
  const [indexDown, setIndexDown] = useState(false)
  // The duplicate-key warning already shown, so it is not repeated per poll.
  const reportedRef = useRef('')
  const settingsActionRef = useRef<(action: SettingsAction) => void>(() => {})
  const settingsWindowOpeningRef = useRef(false)
  // A brand-new note is a draft with no file yet. Pre-selecting its "New note"
  // default title shows a beginner it is editable and lets them type straight
  // over it, the way renaming a file in Finder selects the name. `freshIdRef`
  // stops the selection from repeating on every keystroke.
  const titleRef = useRef<HTMLInputElement>(null)
  const freshIdRef = useRef<string | null>(null)
  // Select the title of a brand-new note (no file yet) once, so typing replaces
  // the "New note" default. Never for notes that already live on disk.
  useEffect(() => {
    if (note && !selected && freshIdRef.current !== note.id) {
      freshIdRef.current = note.id
      titleRef.current?.select()
    }
  }, [note, selected])
  const [themePref, setThemePref] = useState<ThemePref>(loadThemePref)
  const toast = useToast()
  const [langPref, setLangPref] = useState<LangPref>(loadLangPref)
  useDesktopPreferences(themePref, langPref)
  // Folders that exist on disk, including ones holding no notes — an empty
  // directory has no note path to be derived from, so it would vanish the
  // moment it was made.
  const [folders, setFolders] = useState<string[]>([])
  // Files that are not notes (PDFs, images, office files …), for the tree.
  const [otherFiles, setOtherFiles] = useState<string[]>([])
  // A non-note file open in the main pane; exclusive with `note`.
  const [viewing, setViewing] = useState<string | null>(null)
  // The folder a new folder is being named inside: null is "not naming", ''
  // is the vault root. Which parent it belongs to comes from the button that
  // was clicked, so nothing has to be asked afterwards.
  const [namingFolder, setNamingFolder] = useState<string | null>(null)
  // Where an unsaved note will land. Null means "wherever the session key
  // says", which is what happened before folders existed.
  const [target, setTarget] = useState<string | null>(null)

  // Leaving a note with unsaved edits used to drop them silently. Hold the
  // action the user asked for until they say what to do with the edits.
  const [pending, setPending] = useState<null | (() => Promise<void>)>(null)
  // A second confirmation, for actions that are not about unsaved edits. Kept
  // separate rather than folded into `pending` so the two can chain: leaving a
  // dirty note *and* moving the vault asks about the note first.
  const [confirm, setConfirm] = useState<null | {
    message: string
    label: string
    run: () => Promise<void>
  }>(null)
  const driverRef = useRef<SqlDriver | null>(null)
  // "Write with AI". `kind` pre-selects a document type, e.g. from a meeting.
  const [composer, setComposer] = useState<null | { kind?: DocType }>(null)
  const [palette, setPalette] = useState(false)
  const [panes, setPanesState] = useState<Panes>(loadPanes)
  const togglePane = (pane: keyof Panes) =>
    setPanesState((p) => {
      const next = { ...p, [pane]: !p[pane] }
      savePanes(next)
      return next
    })
  const aiPanel = panes.ai
  const setAiPanel = (open: boolean) => panes.ai !== open && togglePane('ai')
  const [vaults, setVaults] = useState<VaultEntry[]>(loadVaults)
  const updateVaults = (next: VaultEntry[]) => {
    setVaults(next)
    saveVaults(next)
  }
  // The open note's live editor, published by NoteEditor for the AI panel.
  const [liveEditor, setLiveEditor] = useState<Editor | null>(null)
  // The board open in the main pane, published by Whiteboard for the AI panel.
  const [liveBoard, setLiveBoard] = useState<OpenBoard | null>(null)
  // Window shortcuts read the current render through this.
  const saveShortcutRef = useRef<() => void>(() => {})

  useEffect(() => {
    let alive = true
    let unlisten: UnlistenFn[] = []
    void Promise.all([
      listen<SettingsAction>(SETTINGS_ACTION_EVENT, ({ payload }) => {
        settingsActionRef.current(payload)
      }),
      listen<SettingsPreferences>(SETTINGS_PREFERENCES_EVENT, ({ payload }) => {
        if (payload.themePref) setThemePref(payload.themePref)
        if (payload.langPref) setLangPref(payload.langPref)
        if (payload.autosave !== undefined) setAutosave(payload.autosave)
      }),
    ])
      .then((stop) => {
        if (alive) unlisten = stop
        else stop.forEach((unsubscribe) => unsubscribe())
      })
      .catch((error) => setError(String(error)))
    return () => {
      alive = false
      unlisten.forEach((unsubscribe) => unsubscribe())
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      try {
        const root = await invoke<string>('vault_root')
        const v = new Vault({ io: tauriVaultIo(root) })
        // The vault is the product; it is plain .md over Rust IPC and needs no
        // SQLite at all. Open it first, so nothing downstream can take away the
        // ability to read and write notes.
        setVault(v)

        // Derived index is disposable and session-scoped: an in-memory SQLite
        // rebuilt from the .md files is all the UI needs for search. Losing it
        // costs full-text search, nothing else — `filtered` already falls back
        // to matching titles, and `refresh` skips indexing without a driver. It
        // used to be opened before the vault, so a failure here left the whole
        // window inert with a disabled "new note" button.
        try {
          const { driver } = await openDatabase()
          driverRef.current = driver
          setDriver(driver)
        } catch (e) {
          console.warn('[Companion] search index unavailable, titles only:', e)
          setIndexDown(true)
        }

        await refresh(v)
      } catch (e) {
        setError(String(e))
      }
    }
    void init()
  }, [])

  async function refresh(v: Vault) {
    // Read the vault once and feed both the sidebar and the index from it —
    // every read here is a round trip through Rust, and this runs on every save.
    const rel = await v.listNotes()
    const read = await Promise.all(rel.map((r) => v.readNote(r)))
    setNotes(
      read.map((n, i) => ({
        rel: rel[i],
        id: n.id,
        sessionKey: n.sessionKey,
        source: n.source,
        title: n.title || rel[i],
        updatedAt: n.updatedAt,
        platform: n.platform,
        startedAt: n.startedAt,
        participants: n.participants?.length ?? 0,
        hasBody: Boolean(n.body.trim()),
      })),
    )
    if (driverRef.current) {
      const skipped = await createIndex(driverRef.current, v, read, rel)
      // A duplicate session key no longer fails the rebuild, but silently
      // dropping a note from search would be its own trap — say which file.
      //
      // Once, though. This runs on every save and every five-second poll, and
      // a duplicate is a state that persists until someone opens the vault and
      // deletes a file — repeating the warning on every tick turns a fact into
      // noise that buries the toasts that report what just happened.
      const key = skipped.join('\n')
      if (key !== reportedRef.current) {
        reportedRef.current = key
        if (skipped.length) {
          toast(
            'error',
            skipped.length === 1
              ? t('desktop.vault.duplicateSessionKey', { path: skipped[0] })
              : t('desktop.vault.duplicateSessionKeys', {
                  count: skipped.length,
                  path: skipped[0],
                }),
          )
        }
      }
    }
    await invoke<string[]>('list_vault_folders').then(setFolders).catch(() => undefined)
    await invoke<string[]>('list_vault_files').then(setOtherFiles).catch(() => undefined)
  }

  // Notes also arrive from outside this window: the extension hands finished
  // meetings to the native host, which writes straight into the vault. Without
  // this the app only ever read the vault at startup, so a delivery looked
  // like nothing had happened until the next restart.
  //
  // ponytail: polls `listMarkdown` — one IPC call per tick, whatever the vault
  // holds. Deliberately NOT `listNotes`, which stats every note individually
  // and would put a round trip per note on a five-second loop forever.
  //
  // The ceiling that buys: only *new* files are noticed, so a second delivery
  // filling in an existing note's summary waits for the next save or reopen.
  // Swap in tauri-plugin-fs watch when that starts to matter.
  useEffect(() => {
    if (!vault) return
    const seen = notes.map((n) => n.rel).sort().join('\n')
    const timer = setInterval(() => {
      // Never while editing: refresh replaces the note list the editor's
      // selection is addressed against, and unsaved work is not ours to drop.
      if (dirty) return
      // Deliveries land in the spool first now: the host writes them there and
      // the note is only created here, so a drain has to happen before the
      // file list is compared or a new meeting looks like nothing happened.
      void drainSpool(vault)
        .then((r) => {
          if (r.applied) return refresh(vault)
        })
        .catch(() => undefined)
      void vault.io
        .listMarkdown()
        .then((abs) => {
          // Same prefix rule the Vault's own `relative` uses, so the two sides
          // of this comparison cannot drift apart over a trailing slash.
          const root = vault.io.root.replace(/\/+$/, '')
          const rel = abs.map((a) => (a.startsWith(`${root}/`) ? a.slice(root.length + 1) : a)).sort()
          if (rel.join('\n') !== seen) return refresh(vault)
        })
        .catch(() => undefined)
    }, 5000)
    return () => clearInterval(timer)
  }, [vault, notes, dirty])

  /** Run `action`, unless there are unsaved edits to resolve first. */
  function guard(action: () => Promise<void>) {
    if (!dirty) return void action()
    // With autosave the edits are kept, not asked about; only a failed write
    // falls back to the question.
    if (!autosave) return setPending(() => action)
    void save(true).then((ok) => (ok ? action() : setPending(() => action)))
  }

  async function resume(discard: boolean) {
    const action = pending
    setPending(null)
    if (!discard) await save()
    setDirty(false)
    if (action) await action()
  }

  async function open(rel: string) {
    if (!vault) return
    if (!rel.toLowerCase().endsWith('.md')) {
      setNote(null)
      setSelected(null)
      setDirty(false)
      setViewing(rel)
      setError(null)
      return
    }
    const n = await vault.readNote(rel)
    setViewing(null)
    setSelected(rel)
    setTarget(null)
    setNote(n)
    setEditorKey((k) => k + 1)
    setDirty(false)
    setError(null)
  }

  // `window.prompt` is a no-op in this window — the WebView has no dialog for
  // it and returns null without showing anything, so the button appeared dead.
  // The name is typed in the sidebar instead.
  async function createFolder(parent: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return setNamingFolder(null)
    try {
      // Slashes would make one field create a whole path, which is more than
      // the control promises; the rest is left alone so a folder can be named
      // in any language.
      const safe = trimmed.replace(/[/\\]/g, '-')
      const rel = parent ? `${parent}/${safe}` : safe
      await invoke('create_vault_folder', { rel })
      if (vault) await refresh(vault)
      toast('success', t('desktop.vault.folderCreated', { name: rel }))
    } catch (e) {
      setError(String(e))
    } finally {
      setNamingFolder(null)
    }
  }
  async function renameFolder(folder: string, name: string) {
    if (!vault) return
    const trimmed = name.trim()
    if (!trimmed) return
    const safe = trimmed.replace(/[/\\]/g, '-')
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : ''
    const renamed = parent ? `${parent}/${safe}` : safe
    if (renamed === folder) return
    try {
      await invoke('rename_vault_folder', { from: folder, to: renamed })
      if (selected && (selected === folder || selected.startsWith(`${folder}/`))) {
        setSelected(`${renamed}${selected.slice(folder.length)}`)
      }
      if (target && (target === folder || target.startsWith(`${folder}/`))) {
        setTarget(`${renamed}${target.slice(folder.length)}`)
      }
      await refresh(vault)
      toast('success', t('desktop.vault.folderRenamed', { name: renamed }))
    } catch (e) {
      setError(String(e))
    }
  }

  function requestTrashFolder(folder: string) {
    if (!vault) return
    const containsSelected = selected === folder || selected?.startsWith(`${folder}/`)
    setConfirm({
      message: `${t('desktop.vault.confirmTrashFolder', { folder })}${
        containsSelected && dirty ? ` ${t('desktop.vault.confirmTrashDirty')}` : ''
      }`,
      label: t('desktop.vault.trashFolderAction'),
      run: async () => {
        guard(async () => {
          try {
            await invoke('trash_vault_folder', { rel: folder })
            if (selected === folder || selected?.startsWith(`${folder}/`)) {
              setNote(null)
              setSelected(null)
              setDirty(false)
            }
            await refresh(vault)
            toast('info', t('desktop.vault.folderTrashed', { name: folder }))
          } catch (e) {
            setError(String(e))
          }
        })
      },
    })
  }


  async function moveNoteFrom(from: string, folder: string) {
    if (!vault) return
    const file = from.split('/').pop() ?? from
    const to = folder ? `${folder}/${file}` : file
    if (to === from) return
    try {
      await invoke('move_vault_file', { from, to })
      if (selected === from) setSelected(to)
      await refresh(vault)
      toast('success', t('desktop.vault.moved', { folder: folder || t('desktop.vault.rootFolder') }))
    } catch (e) {
      setError(String(e))
    }
  }

  async function openNew() {
    if (!vault) return
    const fresh: VaultNote = {
      id: uuidV7(),
      sessionKey: `nota/${Date.now().toString(36)}`,
      platform: 'manual',
      updatedAt: new Date().toISOString(),
      title: t('desktop.editor.newNoteTitle'),
      body: '',
    }
    // A new note belongs where you were looking, but `selected` has to stay
    // null: it means "this note has a file", and `trash()` reads it to decide
    // between trashing a file and simply dropping an unsaved draft. The folder
    // travels separately until the first save gives the note a path.
    setTarget(selected ? selected.split('/').slice(0, -1).join('/') : null)
    setSelected(null)
    setNote(fresh)
    setEditorKey((k) => k + 1)
    setDirty(false)
    setError(null)
  }

  /** A blank whiteboard file, created beside whatever is open, then opened. */
  async function openNewBoard() {
    if (!vault) return
    const near = selected ?? viewing
    const folder = near ? near.split('/').slice(0, -1).join('/') : ''
    const rel = newBoardPath(folder, t('desktop.board.untitled'), new Date(), otherFiles)
    try {
      await invoke('write_vault_file', { rel, content: EMPTY_BOARD })
      await refresh(vault)
      await open(rel)
    } catch (e) {
      setError(String(e))
    }
  }

  /**
   * A document written in one step (by AI) becomes a real file straight away,
   * named after its title, never on top of an existing one — then opens. It
   * is a plain `manual` note: no `source`, because that field means "edited
   * copy of this meeting" and would hide the meeting from the Notes tab.
   */
  async function createDocument(title: string, body: string, folder: string): Promise<void> {
    if (!vault) return
    const fresh: VaultNote = {
      id: uuidV7(),
      sessionKey: `nota/${Date.now().toString(36)}`,
      platform: 'manual',
      updatedAt: new Date().toISOString(),
      title,
      body,
    }
    const rel = docPath(folder, title, notes.map((n) => n.rel))
    await vault.writeNoteAt(rel, fresh)
    await refresh(vault)
    setComposer(null)
    toast('success', t('desktop.composer.created', { path: rel }))
    guard(() => open(rel))
  }

  /** Write the open note. `silent` is autosave: no toast unless a copy was made. */
  function save(silent = false): Promise<boolean> {
    // ponytail: joins the write in flight rather than queueing another; the
    // settled note stays dirty if typing happened, which schedules the next.
    if (savingRef.current) return savingRef.current
    const run = writeOpenNote(silent).finally(() => {
      savingRef.current = null
    })
    savingRef.current = run
    return run
  }

  async function writeOpenNote(silent: boolean): Promise<boolean> {
    if (!vault || !note) return false
    const sent = note
    try {
      // Where this goes and what it writes lives in `saveTarget`, which is
      // pure and has tests: the rule was three nested ternaries here and was
      // wrong twice — once writing a second file for a note that already had
      // one, once making a fresh copy of a meeting on every single save.
      const { rel, note: toWrite, copied } = saveTarget({
        note: sent,
        selected,
        target,
        relPath: (n) => vault.relPath(n),
        existing: notes,
      })
      await vault.writeNoteAt(rel, toWrite)
      // `selected` addresses a file, so it has to become the path the note was
      // just written to — otherwise trashing a freshly created note aims at
      // its session key and misses.
      setSelected(rel)
      setTarget(null)
      const current = noteRef.current
      // Another note was opened, or this one trashed, while the file was
      // written: leave whatever is on screen now alone.
      if (current && current.id === sent.id) {
        const settled = settleSaved(current, sent, { ...toWrite })
        setNote(settled.note)
        setDirty(settled.dirty)
      }
      await refresh(vault)
      setError(null)
      if (copied) toast('success', t('desktop.toast.copiedToNotes'))
      else if (!silent) toast('success', t('desktop.toast.saved'))
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }

  // Autosave: a quiet moment after the last edit. An untouched draft is left
  // unwritten — it only becomes a file once something was typed.
  useEffect(() => {
    if (!autosave || !dirty || !note || pending) return
    if (!note.title.trim() && !note.body.trim()) return
    const timer = setTimeout(() => void save(true), 800)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save reads the same note
  }, [autosave, dirty, note, pending])

  function trash() {
    if (!vault || pending) return
    // A PDF, image or board: no draft and no unsaved state, just the file.
    if (!note) {
      const rel = viewing
      if (!rel) return
      setConfirm({
        message: t('desktop.vault.confirmTrash'),
        label: t('desktop.editor.trash'),
        run: async () => {
          // Unmount first: a board flushes its last stroke on unmount, and
          // that write must land before the move, not recreate the file after.
          flushSync(() => setViewing(null))
          await vault.trash(rel)
          await refresh(vault)
          toast('info', t('desktop.toast.trashed'))
          setError(null)
        },
      })
      return
    }
    // A note that was never saved has no file. An untouched draft drops
    // silently; one with typed content asks first — there is no file to come
    // back from, so a single misfire would erase real work.
    if (!selected) {
      const drop = async () => {
        setNote(null)
        setSelected(null)
        setDirty(false)
        setError(null)
      }
      if (dirty) {
        setConfirm({
          message: t('desktop.vault.discardDraft'),
          label: t('desktop.editor.discard'),
          run: drop,
        })
      } else {
        drop()
      }
      return
    }
    // Trashing is destructive and there is no restore view yet, so ask first.
    // Kept out of `guard`: this is not "save then continue", it is "sure you
    // want to throw this away?" — and a dirty note carries its own warning.
    setConfirm({
      message: dirty
        ? `${t('desktop.editor.confirmUnsaved')} ${t('desktop.vault.confirmTrashDirty')}`
        : t('desktop.vault.confirmTrash'),
      label: t('desktop.editor.trash'),
      run: async () => {
        await vault.trash(selected)
        await refresh(vault)
        toast('info', t('desktop.toast.trashed'))
        setNote(null)
        setSelected(null)
        setDirty(false)
        setError(null)
      },
    })
  }

  /**
   * Point the vault at another folder.
   *
   * `set_vault_root` has existed in the backend since the first commit with
   * nothing calling it; this is what finally reaches it. The Vault is rebuilt
   * rather than mutated because its io carries the root, and the derived index
   * is repopulated from whatever the new folder holds.
   */
  /** Point the vault at `path`, rebuilding everything that captured the old root. */
  async function applyRoot(path: string, message = t('desktop.toast.vaultMoved', { path })): Promise<void> {
    const next = new Vault({ io: tauriVaultIo(path) })
    setVault(next)
    setNote(null)
    setSelected(null)
    setDirty(false)
    await refresh(next)
    void emitTo('settings', SETTINGS_VAULT_CHANGED_EVENT).catch(() => undefined)
    setError(null)
    toast('success', message)
  }

  /** Switch to a listed vault. A folder that is gone is reported, never
   *  recreated: `set_vault_root` would make an empty one in its place. */
  async function openVault(entry: VaultEntry): Promise<void> {
    try {
      const probe = await invoke<{ exists: boolean }>('probe_vault_root', { path: entry.path })
      if (!probe.exists) {
        toast('error', t('desktop.vaults.missing', { path: entry.path }))
        return
      }
      await invoke('set_vault_root', { path: entry.path })
      await applyRoot(entry.path, t('desktop.vaults.opened', { name: entry.name }))
    } catch (e) {
      setError(String(e))
    }
  }

  async function resetVault() {
    setConfirm({
      message: t('desktop.settings.confirmReset'),
      label: t('desktop.settings.resetVault'),
      run: async () => {
        const root = await invoke<string>('reset_vault_root')
        await applyRoot(root)
      },
    })
  }

  /** "+" in the vault list: the folder picked in the dialog opens at once —
   *  choosing it there is the decision, so no second confirmation. */
  async function addVault(): Promise<void> {
    try {
      const picked = await openDialog({ directory: true, title: t('desktop.vaults.add') })
      if (typeof picked !== 'string') return
      await invoke('set_vault_root', { path: picked })
      await applyRoot(picked, t('desktop.vaults.opened', { name: picked.replace(/\/+$/, '').split('/').pop() ?? picked }))
    } catch (e) {
      setError(String(e))
    }
  }

  async function moveVault() {
    if (!vault) return
    try {
      const picked = await openDialog({ directory: true, title: t('desktop.settings.pickVault') })
      if (typeof picked !== 'string') return

      // Ask before writing. `set_vault_root` prepares the folder, so a
      // mis-click used to leave a `.transcript/` directory behind somewhere
      // the user never meant to touch.
      const probe = await invoke<{ exists: boolean; markdown: number; is_vault: boolean }>(
        'probe_vault_root',
        { path: picked },
      )
      setConfirm({
        message: probe.is_vault
          ? t('desktop.settings.confirmExistingVault', { path: picked })
          : probe.markdown > 0
            ? t('desktop.settings.confirmForeignFolder', { path: picked, count: probe.markdown })
            : t('desktop.settings.confirmEmptyFolder', { path: picked }),
        label: t('desktop.settings.moveHere'),
        run: async () => {
          await invoke('set_vault_root', { path: picked })
          await applyRoot(picked)
        },
      })
    } catch (e) {
      setError(String(e))
    }
  }
  settingsActionRef.current = (action) => {
    const run = action === 'move-vault' ? moveVault : resetVault
    void getCurrentWindow()
      .setFocus()
      .then(() => guard(run))
      .catch((error) => {
        setError(String(error))
        toast('error', String(error))
      })
  }

  // Whatever is open is listed: the first launch, a vault picked in Settings,
  // or one chosen with "+" all end up here.
  const openRoot = vault?.io.root
  useEffect(() => {
    if (!openRoot) return
    setVaults((list) => {
      const next = withCurrent(list, openRoot)
      if (next !== list) saveVaults(next)
      return next
    })
  }, [openRoot])

  saveShortcutRef.current = () => {
    if (noteRef.current) void save()
  }

  // Window shortcuts. Cmd+B is bold inside the editor, so it only toggles the
  // sidebar from outside it; Cmd+\ toggles it from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const inEditor = Boolean((e.target as HTMLElement | null)?.closest?.('.ProseMirror'))
      if (key === 'k' || key === 'p') {
        e.preventDefault()
        setPalette((open) => !open)
      } else if (key === 's') {
        e.preventDefault()
        saveShortcutRef.current()
      } else if (key === '\\' || (key === 'b' && !inEditor)) {
        e.preventDefault()
        togglePane('files')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtered = useMemo(() => {
    if (!query.trim()) return notes
    const q = query.trim().toLowerCase()
    // FTS hits carry a vault-relative `path` (and match the note body too);
    // title-substring matches on the full list fill any gap. Dedupe by rel.
    const hits = driver
      ? search(driver, q).map((h) => {
          // The index carries no metadata; take it from the note list when the
          // hit is one we already read, so a search result renders like a row.
          const known = notes.find((n) => n.rel === h.path)
          return {
            rel: h.path,
            id: known?.id ?? h.path,
            sessionKey: known?.sessionKey ?? '',
            source: known?.source,
            title: h.title,
            updatedAt: h.updatedAt,
            platform: known?.platform ?? '',
            startedAt: known?.startedAt,
            participants: known?.participants ?? 0,
            hasBody: known?.hasBody ?? false,
          }
        })
      : []
    const seen = new Set<string>()
    const ordered: NoteHeader[] = []
    for (const h of hits) {
      if (!h.rel) continue
      if (seen.has(h.rel)) continue
      seen.add(h.rel)
      ordered.push(h)
    }
    for (const n of notes) {
      if (n.title.toLowerCase().includes(q) && !seen.has(n.rel)) {
        seen.add(n.rel)
        ordered.push(n)
      }
    }
    return ordered
  }, [notes, driver, query])

  // Grouped view of the same notes the search filters over — when a query is
  // running the flat result list is what makes sense, so the tree is only the
  // resting state.
  const notesTab = useMemo(() => hideCopiedOriginals(notes, notes), [notes])
  const notesTabResults = useMemo(() => hideCopiedOriginals(filtered, notes), [filtered, notes])
  const tree = useMemo(
    () =>
      withEmptyFolders(
        buildTree([
          ...notesTab.flatMap((n) => (hiddenPath(n.rel) ? [] : [{
            rel: n.rel,
            title: n.title,
            platform: n.platform,
            source: n.platform && n.platform !== 'manual' ? platformLabel(n.platform) : undefined,
            updatedAt: n.updatedAt,
          }])),
          ...otherFiles.map((rel) => ({
            rel,
            title: rel.split('/').pop() ?? rel,
            kind: isPdf(rel) ? ('pdf' as const) : ('file' as const),
          })),
        ]),
        folders.filter((f) => !hiddenPath(f)),
      ),
    [notesTab, folders, otherFiles],
  )

  // Notes the extension delivered, as opposed to ones written here. The split
  // needs no new field: openNew stamps `manual`, applyBatch stamps the meeting
  // platform. Newest meeting first — an inbox is read from the top.
  const incoming = useMemo(
    () =>
      notes
        .filter(isIncomingMeeting)
        .sort((a, b) => (b.startedAt ?? b.updatedAt).localeCompare(a.startedAt ?? a.updatedAt)),
    [notes],
  )
  const filteredIncoming = useMemo(
    () => inboxSearchResults(query, incoming, filtered),
    [query, incoming, filtered],
  )

  /**
   * The vault as the AI agent sees it, built fresh per request and per Apply.
   * The open note comes from the live editor, so the agent reads unsaved
   * edits and a change it applies lands there, under the editor's own save.
   */
  const agentWorkspace = (vault: Vault) => {
    const ed = note && liveEditor && !liveEditor.isDestroyed ? liveEditor : null
    return vaultWorkspace({
      vault,
      index: driver ? (q) => search(driver, q) : undefined,
      paths: notes.map((n) => n.rel),
      files: otherFiles,
      pdfText: vaultPdfText,
      mermaid: mermaidToBoard,
      board: liveBoard && liveBoard.path === viewing ? liveBoard : null,
      openFile: viewing && (isBoard(viewing) || isPdf(viewing)) ? viewing : undefined,
      open:
        note && ed
          ? {
              path: selected ?? UNSAVED_DOC,
              title: note.title,
              platform: note.platform,
              markdown: () => ed.getMarkdown(),
              selection: () => contextOf(ed, ed.state.selection.from, ed.state.selection.to).selection,
              replace: (markdown) => {
                if (!ed.isEditable) throw new Error(t('desktop.aiPanel.inlineOpen'))
                ed.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: true })
              },
            }
          : null,
    })
  }

  const searchBodies = (q: string): string[] => {
    if (!driver) return []
    try {
      return search(driver, q.trim().toLowerCase()).map((h) => h.path)
    } catch {
      return [] // a query FTS cannot parse still matches titles
    }
  }

  const paletteCommands: PaletteCommand[] = [
    { id: 'new', label: t('desktop.vault.newNote'), run: () => guard(openNew) },
    { id: 'board', label: t('desktop.board.new'), run: () => guard(openNewBoard) },
    { id: 'ai', label: t('desktop.ai.writeWithAI'), hint: '✦', run: () => setComposer({}) },
    ...(note && isIncomingMeeting(note)
      ? [{ id: 'meeting-doc', label: t('desktop.composer.fromMeeting'), hint: '✦', run: () => setComposer({ kind: 'prd' as const }) }]
      : []),
    ...(note ? [{ id: 'export', label: t('desktop.editor.export'), run: () => setExportOpen(true) }] : []),
    {
      id: 'folder',
      label: t('desktop.vault.newFolder'),
      run: () => {
        if (!panes.files) togglePane('files')
        setView('notes')
        setNamingFolder('')
      },
    },
    { id: 'ai-panel', label: t('desktop.panes.ai'), hint: '✦', run: () => togglePane('ai') },
    { id: 'sidebar', label: t('desktop.panes.files'), hint: '⌘\\', run: () => togglePane('files') },
    { id: 'vaults', label: t('desktop.panes.vaults'), run: () => togglePane('vaults') },
    { id: 'settings', label: t('desktop.nav.settings'), run: () => void showSettingsWindow() },
  ]

  const ThemeIcon = themePref === 'system' ? Monitor : themePref === 'light' ? Sun : Moon

  async function showSettingsWindow(): Promise<void> {
    if (settingsWindowOpeningRef.current) return
    settingsWindowOpeningRef.current = true
    try {
      await openSettingsWindow(t('desktop.settings.title'))
    } catch (error) {
      toast('error', String(error))
    } finally {
      settingsWindowOpeningRef.current = false
    }
  }

  return (
    <div className="flex h-full min-w-0">
      <UpdateBanner />
      {/* Two left columns, Zed-style: which vault, then what is in it. */}
      {panes.vaults && (
        <aside
          className="flex w-[200px] min-w-[160px] max-w-[280px] flex-none resize-x flex-col gap-3.5 overflow-y-auto overflow-x-hidden border-r bg-card px-2.5 py-3.5"
          aria-label={t('desktop.vaults.title')}
        >
          <div className="flex items-center gap-[9px] px-0.5 pb-0.5">
            <BrandMark />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-[0.12em]">Companion</span>
          </div>
          <VaultList
            vaults={vaults}
            root={vault?.io.root}
            onOpen={(entry) => guard(() => openVault(entry))}
            onAdd={() => guard(addVault)}
            onChange={updateVaults}
          />
        </aside>
      )}
      {panes.files && (
        // Resizable, but bounded beside the editor.
        <aside
          className="flex min-h-0 w-[276px] min-w-[240px] max-w-[340px] flex-none resize-x flex-col overflow-hidden border-r bg-card"
          aria-label={t('desktop.nav.notes')}
        >
          <div className="flex flex-none flex-col gap-2 border-b px-3 pb-2.5 pt-3.5">
            <div className="flex items-center gap-2 rounded-lg border bg-muted px-2.5 focus-within:border-primary">
              <Search className="size-3.5 flex-none text-faint" aria-hidden="true" />
              <input
                type="search"
                className="w-full min-w-0 flex-1 bg-transparent py-[7px] text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-45"
                placeholder={
                  !vault
                    ? t('desktop.vault.preparing')
                    : view === 'inbox'
                      ? t('desktop.inbox.search')
                      : indexDown
                        ? t('desktop.vault.searchTitlesOnly')
                        : t('desktop.vault.search')
                }
                aria-label={view === 'inbox' ? t('desktop.inbox.search') : t('desktop.vault.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={!vault}
              />
            </div>
            <nav className="w-full">
              <Segmented
                ariaLabel={t('desktop.sidebar.tabs')}
                className="grid w-full grid-cols-2 gap-0.5 rounded-[9px] border bg-muted p-[3px]"
                itemClassName="h-auto min-w-0 overflow-hidden rounded-md border-transparent px-[5px] py-[7px] text-[11.5px]"
                options={[
                  { value: 'notes', label: t('desktop.nav.notes') },
                  { value: 'inbox', label: t('desktop.nav.inbox') },
                ]}
                value={view}
                onChange={(value) => setView(value as 'notes' | 'inbox')}
              />
            </nav>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-2.5 py-3">
            {view === 'notes' && (
              <>
                <div className="flex flex-none items-center gap-1.5 border-b px-1 pb-2">
                  <span className={KICKER}>{t('desktop.vault.kicker')}</span>
                  <span className={COUNT}>{t('desktop.vault.count', { count: notesTab.length })}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <div
                      className="flex items-center rounded-md border bg-muted/60 p-0.5 text-muted-foreground"
                      role="radiogroup"
                      aria-label={t('desktop.vault.viewMode')}
                    >
                      <Tip label={t('desktop.vault.viewTree')}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={notesView === 'tree'}
                          className={cn(
                            'grid size-5 place-items-center rounded-sm transition-colors',
                            notesView === 'tree'
                              ? 'bg-background text-foreground shadow-xs'
                              : 'hover:text-foreground',
                          )}
                          onClick={() => {
                            setNotesView('tree')
                            try {
                              localStorage.setItem('companion:notes-view', 'tree')
                            } catch {
                              /* the view choice still holds for this session */
                            }
                          }}
                          aria-label={t('desktop.vault.viewTree')}
                        >
                          <FolderTree className="size-3.5" />
                        </button>
                      </Tip>
                      <Tip label={t('desktop.vault.viewList')}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={notesView === 'list'}
                          className={cn(
                            'grid size-5 place-items-center rounded-sm transition-colors',
                            notesView === 'list'
                              ? 'bg-background text-foreground shadow-xs'
                              : 'hover:text-foreground',
                          )}
                          onClick={() => {
                            setNotesView('list')
                            try {
                              localStorage.setItem('companion:notes-view', 'list')
                            } catch {
                              /* the view choice still holds for this session */
                            }
                          }}
                          aria-label={t('desktop.vault.viewList')}
                        >
                          <List className="size-3.5" />
                        </button>
                      </Tip>
                    </div>
                    <Tip label={t('desktop.ai.writeWithAI')}>
                      <span className="inline-flex">
                        <button
                          type="button"
                          className={cn(HEAD_BTN, 'text-primary')}
                          onClick={() => setComposer({})}
                          aria-label={t('desktop.ai.writeWithAI')}
                          disabled={!vault}
                        >
                          <Sparkles className="size-4" />
                        </button>
                      </span>
                    </Tip>
                    {notesView === 'tree' && (
                      <Tip label={t('desktop.vault.newFolder')}>
                        <span className="inline-flex">
                          <button
                            type="button"
                            className={HEAD_BTN}
                            onClick={() => setNamingFolder('')}
                            aria-label={t('desktop.vault.newFolder')}
                            disabled={!vault}
                          >
                            <FolderPlus className="size-4" />
                          </button>
                        </span>
                      </Tip>
                    )}
                    <Tip label={vault ? t('desktop.board.new') : t('desktop.vault.preparing')}>
                      <span className="inline-flex">
                        <button
                          type="button"
                          className={HEAD_BTN}
                          onClick={() => guard(openNewBoard)}
                          aria-label={t('desktop.board.new')}
                          disabled={!vault}
                        >
                          <Shapes className="size-4" />
                        </button>
                      </span>
                    </Tip>
                    <Tip label={vault ? t('desktop.vault.newNote') : t('desktop.vault.preparing')}>
                      <span className="inline-flex">
                        <button
                          type="button"
                          className={HEAD_BTN}
                          onClick={() => guard(openNew)}
                          aria-label={t('desktop.vault.newNote')}
                          disabled={!vault}
                        >
                          <FilePlus className="size-4" />
                        </button>
                      </span>
                    </Tip>
                  </div>
                </div>
                {namingFolder !== null && (
                  <Input
                    className="h-8 flex-none"
                    autoFocus
                    placeholder={
                      namingFolder
                        ? t('desktop.vault.folderNameIn', { folder: namingFolder })
                        : t('desktop.vault.folderName')
                    }
                    aria-label={t('desktop.vault.folderName')}
                    onBlur={(e) => void createFolder(namingFolder, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createFolder(namingFolder, e.currentTarget.value)
                      if (e.key === 'Escape') setNamingFolder(null)
                    }}
                  />
                )}
                {!query.trim() ? (
                  notesView === 'tree' ? (
                    <NoteTree
                      root={tree}
                      selected={viewing ?? selected}
                      onOpen={(rel) => guard(() => open(rel))}
                      onMove={(rel, folder) => void moveNoteFrom(rel, folder)}
                      onAddFolder={(folder) => setNamingFolder(folder)}
                      onRenameFolder={(folder, name) => guard(() => renameFolder(folder, name))}
                      onTrashFolder={requestTrashFolder}
                    />
                  ) : (
                    <ul className={LIST}>
                      {notesTab.map((n) => (
                        <li key={n.rel || n.title}>
                          <button
                            type="button"
                            className={noteItem((viewing ?? selected) === n.rel)}
                            onClick={() => guard(() => open(n.rel))}
                          >
                            <span className={NOTE_TITLE}>{n.title}</span>
                            <span className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
                              {n.platform && n.platform !== 'manual' && (
                                <span
                                  className={cn(
                                    'max-w-1/2 truncate rounded-sm border px-[5px] py-px text-[10px] font-medium leading-snug tracking-wide text-muted-foreground',
                                    (viewing ?? selected) === n.rel && 'border-primary text-primary',
                                  )}
                                >
                                  {platformLabel(n.platform)}
                                </span>
                              )}
                              <span className="ml-auto min-w-0 flex-1 truncate text-right text-[11px] leading-snug text-muted-foreground">
                                {dayOf(n.updatedAt)}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                      {notesTab.length === 0 && <li className={EMPTY_HINT}>{t('desktop.vault.empty')}</li>}
                    </ul>
                  )
                ) : (
                  <ul className={LIST}>
                    {notesTabResults.map((n) => (
                      <li key={n.rel || n.title}>
                        {n.rel ? (
                          <button
                            type="button"
                            className={noteItem(selected === n.rel)}
                            onClick={() => guard(() => open(n.rel))}
                          >
                            <span className={NOTE_TITLE}>{n.title}</span>
                            <span className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
                              {n.platform && n.platform !== 'manual' && (
                                <span
                                  className={cn(
                                    'max-w-1/2 truncate rounded-sm border px-[5px] py-px text-[10px] font-medium leading-snug tracking-wide text-muted-foreground',
                                    selected === n.rel && 'border-primary text-primary',
                                  )}
                                >
                                  {platformLabel(n.platform)}
                                </span>
                              )}
                              <span className="ml-auto min-w-0 flex-1 truncate text-right text-[11px] leading-snug text-muted-foreground">
                                {dayOf(n.updatedAt)}
                              </span>
                            </span>
                          </button>
                        ) : (
                          <Tip label={t('desktop.vault.bodyHit')}>
                            <span className="block cursor-default truncate px-[9px] py-[7px] text-[13px] text-muted-foreground">
                              {n.title}
                            </span>
                          </Tip>
                        )}
                      </li>
                    ))}
                    {notesTabResults.length === 0 && <li className={EMPTY_HINT}>{t('desktop.vault.noMatches')}</li>}
                  </ul>
                )}
              </>
            )}
            {view === 'inbox' && (
              <>
                <div className="flex flex-none items-center gap-2 border-b px-1 pb-2">
                  <span className={KICKER}>{t('desktop.inbox.kicker')}</span>
                  <span className={COUNT}>
                    {t('desktop.inbox.count', {
                      count: query.trim() ? filteredIncoming.length : incoming.length,
                    })}
                  </span>
                </div>
                <ul className={LIST}>
                  {filteredIncoming.map((n) => (
                    <li key={n.rel}>
                      {/* One row per delivered meeting: where it came from,
                          when, how many people, and whether the summary has
                          landed yet. */}
                      <button
                        type="button"
                        className={noteItem(selected === n.rel)}
                        onClick={() => guard(() => open(n.rel))}
                      >
                        <span className={NOTE_TITLE}>{n.title}</span>
                        <span className="flex flex-wrap items-center gap-2 font-mono text-[9.5px] leading-snug text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Video className="size-3" aria-hidden="true" />
                            {platformLabel(n.platform)}
                          </span>
                          <span>{dayOf(n.startedAt) || dayOf(n.updatedAt)}</span>
                          {n.participants > 0 && (
                            <span className="flex items-center gap-1">
                              <Users className="size-3" aria-hidden="true" />
                              {t('desktop.inbox.participants', { count: n.participants })}
                            </span>
                          )}
                          {!n.hasBody && <span className="text-primary opacity-75">{t('desktop.inbox.transcriptOnly')}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                  {filteredIncoming.length === 0 && (
                    <li className={EMPTY_HINT}>
                      {t(query.trim() ? 'desktop.inbox.noMatches' : 'desktop.inbox.empty')}
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>

          <div className="flex flex-none items-center gap-1.5 border-t bg-card px-3 pb-3 pt-2.5">
            <Tip label={t('desktop.nav.theme', { mode: themeLabel(themePref) })} side="top">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t('desktop.nav.theme', { mode: themeLabel(themePref) })}
                onClick={() => {
                  const next = themePref === 'system' ? 'light' : themePref === 'light' ? 'dark' : 'system'
                  setThemePref(next)
                  void emitTo('settings', SETTINGS_PREFERENCES_EVENT, { themePref: next }).catch(() => undefined)
                }}
              >
                <ThemeIcon />
              </Button>
            </Tip>
            <Tip label={t('desktop.nav.settings')} side="top">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t('desktop.nav.settings')}
                onClick={() => void showSettingsWindow()}
              >
                <Settings />
              </Button>
            </Tip>
            <span className="flex-1" />
            {activeSponsorLinks().map((link) => {
              const Icon = SPONSOR_ICON[link.id]
              return (
                <Tip key={link.id} label={`${t('sponsor.title')} · ${t(link.label)}`} side="top">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label={`${t('sponsor.title')} · ${t(link.label)}`}
                    onClick={() => void invoke('open_external', { url: link.url })}
                  >
                    {Icon ? <Icon /> : link.icon}
                  </Button>
                </Tip>
              )
            })}
          </div>
        </aside>

      )}

      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-[38px] flex-none items-center gap-3 border-b bg-sunken px-3.5">
          <span className="mr-1 flex gap-0.5">
            <PaneButton on={panes.vaults} label={t('desktop.panes.vaults')} onClick={() => togglePane('vaults')} icon={Library} />
            <PaneButton on={panes.files} label={t('desktop.panes.files')} onClick={() => togglePane('files')} icon={PanelLeft} />
          </span>
          <nav className="flex min-w-0 flex-1 items-center overflow-hidden text-[12.5px] text-muted-foreground" aria-label={t('desktop.breadcrumb')}>
            <Tip label={vault?.io.root ?? '…'}>
              <span className="flex items-center gap-1.5 truncate">
                <FolderOpen className="size-3.5 flex-none" aria-hidden="true" />
                {vault?.io.root.replace(/\/+$/, '').split('/').pop() ?? '…'}
              </span>
            </Tip>
            {(selected ?? (target ? `${target}/_` : ''))
              .split('/')
              .slice(0, -1)
              .map((part, i) => (
                <span key={i} className={CRUMB}>
                  {part}
                </span>
              ))}
            {note && <span className={cn(CRUMB, 'text-foreground')}>{note.title || t('desktop.composer.untitled')}</span>}
          </nav>
          {note && (
            // Notion's "Edited just now": quiet unless unsaved.
            <span className={cn('ml-auto whitespace-nowrap text-xs text-muted-foreground', dirty && !autosave && 'text-warning')}>
              {dirty
                ? autosave
                  ? t('desktop.editor.saving')
                  : t('desktop.editor.unsaved')
                : t('desktop.editor.updated', { date: formatDate(note.updatedAt) || '—' })}
            </span>
          )}
          {note && (
            <Tip label={t('desktop.badge.local')}>
              <Badge className="gap-1.5 rounded-full border-primary/40 bg-primary/12 px-[9px] py-[5px] font-mono text-[9px] font-bold leading-none tracking-[0.12em] text-primary">
                <HardDrive className="size-2.5!" aria-hidden="true" />
                LOKAL
              </Badge>
            </Tip>
          )}
          {(note || viewing) && (
            <PageMenu
              actions={[
                ...((selected ?? viewing)
                  ? [
                      {
                        id: 'reveal',
                        label: t('desktop.file.reveal'),
                        run: () => void invoke('reveal_vault_file', { rel: selected ?? viewing }).catch((e) => setError(String(e))),
                      },
                    ]
                  : []),
                ...(note ? [{ id: 'export', label: t('desktop.editor.export'), run: () => setExportOpen(true) }] : []),
                ...(note || viewing ? [{ id: 'trash', label: t('desktop.editor.trash'), danger: true, run: trash }] : []),
              ]}
            />
          )}
          <Tip label={t('desktop.panes.ai')}>
            <button
              type="button"
              className={cn(
                'inline-flex h-6 items-center gap-[5px] rounded-md border px-[9px] text-xs text-muted-foreground hover:bg-muted hover:text-foreground',
                aiPanel && 'bg-muted text-foreground',
              )}
              aria-pressed={aiPanel}
              aria-label={t('desktop.panes.ai')}
              onClick={() => togglePane('ai')}
            >
              <Sparkles className="size-3.5 text-primary" aria-hidden="true" /> {t('desktop.aiPanel.toggle')}
              <PanelRight className="ml-0.5 size-3.5" aria-hidden="true" />
            </button>
          </Tip>
        </header>

        <section
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-10 py-7 *:mx-auto *:w-full *:max-w-[780px]',
            // A PDF or image fills the pane.
            viewing && 'overflow-hidden p-0 *:max-w-none',
          )}
        >
          {viewing ? (
            isBoard(viewing) ? (
              <Suspense fallback={null}>
                <Whiteboard key={viewing} rel={viewing} onError={setError} onBoard={setLiveBoard} />
              </Suspense>
            ) : (
              <FileView rel={viewing} onError={setError} />
            )
          ) : note ? (
            <>
              <PageHeader
                note={note}
                onChange={(patch) => {
                  setNote({ ...note, ...patch })
                  setDirty(true)
                }}
                onError={(message) => setError(message)}
              />
              {/* The title is text on the page, not a form field: no frame,
                  no fill, no focus ring — the caret is the only sign it is
                  being edited, as in Notion. */}
              <input
                ref={titleRef}
                className="mb-3.5 border-0 bg-transparent p-0 text-[34px] font-bold leading-[1.2] tracking-[-0.02em] text-foreground outline-none placeholder:text-muted-foreground/50"
                value={note.title}
                placeholder={t('desktop.editor.titlePlaceholder')}
                onChange={(e) => {
                  setNote({ ...note, title: e.target.value })
                  setDirty(true)
                }}
              />
              {isIncomingMeeting(note) && (
                <>
                  <MeetingMeta note={note} vault={vault} />
                  <div className="-mt-1.5 mb-3.5">
                    <Button type="button" variant="outline" size="sm" onClick={() => setComposer({ kind: 'prd' })}>
                      <Sparkles className="text-primary" /> {t('desktop.composer.fromMeeting')}
                    </Button>
                  </div>
                </>
              )}
              <TicketFields note={note} onChange={(patch) => { setNote({ ...note, ...patch }); setDirty(true) }} />
              {/* Keyed by which note was opened, not its id or path: the
                  editor owns its document, so opening another note must
                  remount it — but a save, which can give the note a path or
                  (for a meeting's copy) a new id, must not, or the cursor
                  jumps out from under the typing. */}
              <NoteEditor
                key={editorKey}
                value={note.body}
                onChange={(body) => {
                  setNote({ ...note, body })
                  setDirty(true)
                }}
                onWriteWithAI={() => setComposer({})}
                onEditor={setLiveEditor}
              />
              {/* Saving is automatic; a button only appears for someone who
                  turned autosave off in Settings. For a delivered meeting it
                  says what it does — it makes a copy, the archive stays. */}
              {!autosave && (
                <div className="mt-3.5 flex items-center gap-2.5">
                  <Button type="button" size="sm" onClick={() => void save()}>
                    {note.platform && note.platform !== 'manual' ? <Copy /> : <Save />}
                    {note.platform && note.platform !== 'manual'
                      ? t('desktop.editor.saveCopy')
                      : t('desktop.editor.save')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
              <h1 className="m-0 text-[26px] font-semibold">{t('desktop.editor.emptyTitle')}</h1>
              <p className="m-0 max-w-[46ch] text-muted-foreground">{t('desktop.editor.emptyBody')}</p>
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" onClick={() => guard(openNew)} disabled={!vault}>
                  <FilePlus />
                  {t('desktop.vault.newNote')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setComposer({})} disabled={!vault}>
                  <Sparkles className="text-primary" /> {t('desktop.ai.writeWithAI')}
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t('desktop.palette.hint')}</p>
            </div>
          )}
          {/* Pinned to the bottom of the pane: at the end of a long note they
              would render below the fold, and the button would seem dead. */}
          {(confirm || pending) && (
            <div className={cn('sticky bottom-0 z-10 bg-background pb-3', viewing && 'px-3')}>
              {confirm && (
                <div className={cn(BAR, 'border-warning bg-warning/10 text-foreground')} role="alert">
                  <TriangleAlert className="size-4 flex-none text-warning" aria-hidden="true" />
                  <span className="flex-1">{confirm.message}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirm(null)}>
                    {t('desktop.settings.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      const action = confirm.run
                      setConfirm(null)
                      void action().catch((e) => setError(String(e)))
                    }}
                  >
                    {confirm.label}
                  </Button>
                </div>
              )}
              {pending && (
                <div className={cn(BAR, 'border-warning bg-warning/10 text-foreground')} role="alert">
                  <TriangleAlert className="size-4 flex-none text-warning" aria-hidden="true" />
                  <span className="flex-1">{t('desktop.editor.confirmUnsaved')}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void resume(true)}>
                    {t('desktop.editor.discard')}
                  </Button>
                  <Button type="button" size="sm" onClick={() => void resume(false)}>
                    {t('desktop.editor.saveAndGo')}
                  </Button>
                </div>
              )}
            </div>
          )}
          {error && (
            <div className={cn(BAR, 'items-start border-destructive bg-destructive/10 font-mono leading-snug text-destructive')}>
              <CircleAlert className="size-4 flex-none" aria-hidden="true" />
              {error}
            </div>
          )}
        </section>
      </main>
      {aiPanel && vault && (
        <AISidebar
          hasDocument={Boolean(note)}
          folder={selected ? selected.split('/').slice(0, -1).join('/') : (target ?? '')}
          workspace={() => agentWorkspace(vault)}
          onOpen={(rel) => guard(() => open(rel))}
          onChanged={async (removed) => {
            if (selected && removed.includes(selected)) {
              setNote(null)
              setSelected(null)
              setDirty(false)
            }
            // An undone board creation takes the board away; do not leave its viewer on a missing file.
            if (viewing && removed.includes(viewing)) setViewing(null)
            await refresh(vault)
          }}
          onClose={() => setAiPanel(false)}
          onWriteWithAI={() => setComposer({})}
        />
      )}
      {composer && vault && (
        <AIComposer
          vault={vault}
          folders={folderPaths(tree)}
          folder={selected ? selected.split('/').slice(0, -1).join('/') : (target ?? '')}
          current={note}
          notePaths={notes.map((n) => n.rel)}
          workspace={() => agentWorkspace(vault)}
          kind={composer.kind}
          onCreate={createDocument}
          onClose={() => setComposer(null)}
        />
      )}
      {palette && (
        <CommandPalette
          commands={paletteCommands}
          notes={notesTab.map((n) => ({ rel: n.rel, title: n.title }))}
          searchBodies={searchBodies}
          onOpen={(rel) => guard(() => open(rel))}
          onClose={() => setPalette(false)}
        />
      )}
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        note={note}
        editor={liveEditor}
        folder={selected ? selected.split('/').slice(0, -1).join('/') : (target ?? '')}
        onExported={() => vault && void refresh(vault)}
      />
    </div>
  )
}
