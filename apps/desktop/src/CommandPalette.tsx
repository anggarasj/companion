// Cmd/Ctrl+K: one box for "open that note" and "do that thing".
//
// Notes match by title and path here, and by body through the same SQLite FTS
// index the sidebar search uses (`searchBodies`), so this adds no second index.
import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@meetcc/shared/i18n'
import { CornerDownLeft, FileText, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

export interface PaletteNote {
  rel: string
  title: string
}

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run: () => void
}

/** Commands first when they match, then notes; at most 50 rows. */
export function paletteResults(
  query: string,
  commands: PaletteCommand[],
  notes: PaletteNote[],
  bodyHits: string[] = [],
): Array<{ kind: 'command'; command: PaletteCommand } | { kind: 'note'; note: PaletteNote }> {
  const q = query.trim().toLowerCase()
  const cmds = commands.filter((c) => !q || c.label.toLowerCase().includes(q))
  const seen = new Set<string>()
  const hits: PaletteNote[] = []
  const push = (n: PaletteNote | undefined) => {
    if (n && !seen.has(n.rel)) {
      seen.add(n.rel)
      hits.push(n)
    }
  }
  for (const n of notes) if (!q || n.title.toLowerCase().includes(q) || n.rel.toLowerCase().includes(q)) push(n)
  const byRel = new Map(notes.map((n) => [n.rel, n]))
  for (const rel of bodyHits) push(byRel.get(rel))
  return [
    ...cmds.map((command) => ({ kind: 'command' as const, command })),
    ...hits.map((note) => ({ kind: 'note' as const, note })),
  ].slice(0, 50)
}

export function CommandPalette({
  commands,
  notes,
  searchBodies,
  onOpen,
  onClose,
}: {
  commands: PaletteCommand[]
  notes: PaletteNote[]
  searchBodies: (query: string) => string[]
  onOpen: (rel: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const results = useMemo(
    () => paletteResults(query, commands, notes, query.trim().length > 1 ? searchBodies(query) : []),
    [query, commands, notes, searchBodies],
  )

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (i: number) => {
    const r = results[i]
    if (!r) return
    onClose()
    if (r.kind === 'command') r.command.run()
    else onOpen(r.note.rel)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-[12vh] w-[min(600px,92vw)] max-w-none translate-y-0 gap-0 rounded-lg bg-popover p-1.5 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{t('desktop.palette.title')}</DialogTitle>
        <div className="flex items-center border-b px-2.5">
          <Search className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus
            className="h-10 w-full bg-transparent px-2.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
            value={query}
            placeholder={t('desktop.palette.placeholder')}
            aria-label={t('desktop.palette.title')}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = results.length
                if (n) setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(index)
              }
            }}
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto pt-1" ref={list} role="listbox">
          {results.map((r, i) => (
            <button
              key={r.kind === 'command' ? `c:${r.command.id}` : `n:${r.note.rel}`}
              type="button"
              role="option"
              aria-selected={i === index}
              data-active={i === index}
              className="flex h-[30px] w-full items-center gap-2 rounded-[5px] px-2 text-left text-[13px] data-[active=true]:bg-muted"
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(i)}
            >
              {r.kind === 'command' ? (
                <CornerDownLeft className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
              ) : (
                <FileText className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
              )}
              <span className="max-w-[60%] flex-none truncate">{r.kind === 'command' ? r.command.label : r.note.title}</span>
              <span className="flex-1 truncate text-right text-[11.5px] text-muted-foreground">
                {r.kind === 'command' ? r.command.hint : r.note.rel}
              </span>
            </button>
          ))}
          {results.length === 0 && <p className="m-0 p-2 text-[12.5px] text-muted-foreground">{t('desktop.vault.noMatches')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
