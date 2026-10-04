// The note list as a tree of folders.
//
// Folders come from the note paths, so the sidebar can never disagree with
// what is on disk. Expanded state is a per-viewer convenience and lives in
// localStorage, the way the theme and language preferences do.
import { useState } from 'react'
import { formatDate, t } from '@meetcc/shared/i18n'
import type { TreeFolder, TreeNote } from './tree'
import { ChevronRight, File, FileText, FileType, Folder, FolderOpen, FolderPlus, Pencil, Trash2, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/Tip'

const KEY = 'companion:collapsed-folders'

/** Per-folder actions stay hidden until the row is touched, so a sidebar of
 *  folders is not a wall of icons. */
const ROW_ACTION =
  'grid h-7 w-[26px] flex-none place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-muted hover:text-primary focus-visible:opacity-100 group-hover/row:opacity-100'

/** The whole row as one line, for a title the tree had to truncate. */
function rowTooltip(n: TreeNote): string {
  const date = n.updatedAt ? formatDate(n.updatedAt) : ''
  let tip = n.title
  if (n.source) tip += ` · ${n.source}`
  if (date) tip += ` · ${date}`
  return tip
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[])
  } catch {
    /* private mode, or a value someone hand-edited — start expanded */
    return new Set()
  }
}

function saveCollapsed(paths: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...paths]))
  } catch {
    /* the tree still works for this session */
  }
}

export function NoteTree({
  root,
  selected,
  onOpen,
  onMove,
  onAddFolder,
  onRenameFolder,
  onTrashFolder,
}: {
  root: TreeFolder
  selected: string | null
  onOpen: (rel: string) => void
  /** Drop a note onto a folder. `folder` is '' for the vault root. */
  onMove: (rel: string, folder: string) => void
  /** Start naming a new folder inside this one. '' is the vault root. */
  onAddFolder: (folder: string) => void
  onRenameFolder: (folder: string, name: string) => void
  onTrashFolder: (folder: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [renaming, setRenaming] = useState<string | null>(null)
  // The folder currently under a dragged note, so the drop target is visible.
  // Without it the whole gesture is invisible and you are guessing.
  const [over, setOver] = useState<string | null>(null)

  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      saveCollapsed(next)
      return next
    })
  }

  const countNotes = (folder: TreeFolder): number =>
    folder.notes.length + folder.folders.reduce((n, f) => n + countNotes(f), 0)

  const renderFolder = (folder: TreeFolder, depth: number) => {
    const isCollapsed = collapsed.has(folder.path)
    const total = countNotes(folder)
    const FolderIcon = isCollapsed ? Folder : FolderOpen
    return (
      <li key={folder.path} className="group/tree min-w-0">
        <div className="group/row flex min-w-0 items-center gap-1">
          {renaming === folder.path ? (
            <Input
              className="h-7"
              autoFocus
              aria-label={t('desktop.vault.folderName')}
              defaultValue={folder.name}
              onBlur={(event) => {
                const name = event.currentTarget.value.trim()
                setRenaming(null)
                if (name && name !== folder.name) onRenameFolder(folder.path, name)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <button
              type="button"
              className={cn(
                'group/folder flex min-h-7 w-full min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-0.5 pr-2 text-left text-[13px] font-semibold leading-snug text-foreground transition-colors hover:bg-muted',
                over === folder.path && 'bg-muted ring-1 ring-inset ring-primary',
              )}
              aria-expanded={!isCollapsed}
              onClick={() => toggle(folder.path)}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOver(folder.path)
              }}
              onDragLeave={() => setOver((path) => (path === folder.path ? null : path))}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOver(null)
                const rel = e.dataTransfer.getData('text/plain')
                if (rel) onMove(rel, folder.path)
              }}
            >
              <ChevronRight
                className={cn(
                  'size-3.5 flex-none text-muted-foreground transition-transform duration-150 group-hover/folder:text-primary motion-reduce:transition-none',
                  !isCollapsed && 'rotate-90',
                )}
                aria-hidden="true"
              />
              <FolderIcon className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 truncate">{folder.name}</span>
              {total > 0 && (
                <span className="flex-none text-[11px] font-normal leading-none tabular-nums text-muted-foreground">
                  {total}
                </span>
              )}
            </button>
          )}
          <Tip label={t('desktop.vault.renameFolder', { folder: folder.name })}>
            <button
              type="button"
              className={ROW_ACTION}
              aria-label={t('desktop.vault.renameFolder', { folder: folder.name })}
              onClick={() => setRenaming(folder.path)}
            >
              <Pencil className="size-3.5" />
            </button>
          </Tip>
          <Tip label={t('desktop.vault.trashFolder', { folder: folder.name })}>
            <button
              type="button"
              className={ROW_ACTION}
              aria-label={t('desktop.vault.trashFolder', { folder: folder.name })}
              onClick={() => onTrashFolder(folder.path)}
            >
              <Trash2 className="size-3.5" />
            </button>
          </Tip>
          <Tip label={t('desktop.vault.newFolderIn', { folder: folder.name })}>
            <button
              type="button"
              className={ROW_ACTION}
              aria-label={t('desktop.vault.newFolderIn', { folder: folder.name })}
              onClick={() => onAddFolder(folder.path)}
            >
              <FolderPlus className="size-3.5" />
            </button>
          </Tip>
        </div>
        {!isCollapsed && renderChildren(folder, depth + 1)}
      </li>
    )
  }

  // One guide line per level, under the parent's chevron. Past four levels
  // the lines stop stepping right, so a deep path keeps room for its titles.
  const renderChildren = (folder: TreeFolder, depth: number) => (
    <ul
      className={cn(
        'm-0 flex min-w-0 list-none flex-col gap-0.5 p-0',
        0 < depth && depth < 5 && 'ml-[11px] border-l border-border/60 pl-1.5 transition-colors group-hover/tree:border-border motion-reduce:transition-none',
      )}
    >
      {folder.folders.map((f) => renderFolder(f, depth))}
      {folder.notes.map((n) => {
        const delivered = Boolean(n.platform && n.platform !== 'manual')
        const active = selected === n.rel
        const Icon = n.kind === 'pdf' ? FileType : n.kind === 'file' ? File : delivered ? Video : FileText
        return (
          <li key={n.rel} className="min-w-0">
            <button
              type="button"
              draggable
              className={cn(
                'group/note flex min-h-7 w-full min-w-0 cursor-grab items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted active:cursor-grabbing',
                active && 'bg-primary/12 shadow-[inset_2px_0_0_var(--primary)] hover:bg-primary/12',
              )}
              title={rowTooltip(n)}
              onClick={() => onOpen(n.rel)}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', n.rel)
                e.dataTransfer.effectAllowed = 'move'
              }}
            >
              {/* A delivered meeting is an archive — editing copies it — so it
                  is marked before the click, not after. */}
              <Icon
                className={cn(
                  'size-4 flex-none text-muted-foreground',
                  delivered && !n.kind && 'text-primary',
                  n.kind === 'pdf' && 'text-destructive',
                  n.kind === 'file' && 'opacity-60',
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px] leading-snug text-muted-foreground group-hover/note:text-foreground',
                  active && 'font-semibold text-foreground',
                )}
              >
                {n.title}
              </span>
              <span className="flex max-w-[45%] flex-none items-center gap-1.5 overflow-hidden">
                {n.source && (
                  <span
                    className={cn(
                      'hidden max-w-1/2 truncate rounded-sm border px-1 text-[10px] font-medium leading-snug tracking-wide text-muted-foreground group-hover/note:inline',
                      active && 'inline border-primary text-primary',
                    )}
                  >
                    {n.source}
                  </span>
                )}
                {n.updatedAt && (
                  <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
                    {formatDate(n.updatedAt, { day: 'numeric', month: 'short' })}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )

  const empty = root.folders.length === 0 && root.notes.length === 0
  if (empty) return <p className="m-0 p-2.5 text-[12.5px] leading-normal text-muted-foreground">{t('desktop.vault.empty')}</p>

  return (
    <div
      className={cn(
        'min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-md px-2.5 pb-3 pt-1.5',
        over === '' && 'bg-muted ring-1 ring-inset ring-primary',
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setOver('')
      }}
      onDragLeave={() => setOver((p) => (p === '' ? null : p))}
      onDrop={(e) => {
        e.preventDefault()
        setOver(null)
        const rel = e.dataTransfer.getData('text/plain')
        // Dropping on the background means the vault root — the way back out
        // of a folder, which a folder-only target list cannot express.
        if (rel) onMove(rel, '')
      }}
    >
      {renderChildren(root, 0)}
    </div>
  )
}
