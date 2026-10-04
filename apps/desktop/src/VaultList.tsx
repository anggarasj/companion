// The vault switcher at the top of the sidebar: every listed vault by its own
// name, the open one marked. Rename and hide sit on the row; hidden vaults fold
// into one line at the bottom so a long list stays short.
import { useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, FolderPlus, Pencil, X } from 'lucide-react'
import { t } from '@meetcc/shared/i18n'
import { cn } from '@/lib/utils'
import { Tip } from '@/components/Tip'
import { isCurrent, removeVault, renameVault, setHidden, type VaultEntry } from './vaults'

const ACT = 'grid size-[22px] place-items-center rounded-sm text-muted-foreground hover:bg-border hover:text-foreground'

export function VaultList({
  vaults,
  root,
  onOpen,
  onAdd,
  onChange,
}: {
  vaults: VaultEntry[]
  root: string | undefined
  onOpen: (vault: VaultEntry) => void
  onAdd: () => void
  onChange: (next: VaultEntry[]) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const visible = vaults.filter((v) => !v.hidden)
  const hidden = vaults.filter((v) => v.hidden)

  const row = (v: VaultEntry) => {
    const current = isCurrent(v, root)
    if (renaming === v.id) {
      return (
        <li key={v.id} className="relative flex h-7 items-center rounded-md">
          <input
            className="h-[26px] w-full rounded-md border border-primary bg-sunken px-2 text-[13px] text-foreground outline-none"
            autoFocus
            defaultValue={v.name}
            aria-label={t('desktop.vaults.rename')}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              onChange(renameVault(vaults, v.id, e.currentTarget.value))
              setRenaming(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(null)
            }}
          />
        </li>
      )
    }
    return (
      <li key={v.id} className={cn('group/vault relative flex h-7 items-center rounded-md hover:bg-muted', current && 'bg-muted')}>
        <Tip label={v.path}>
          <button
            type="button"
            className={cn(
              'flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-[13px] text-muted-foreground',
              current && 'cursor-default font-semibold text-foreground',
              v.hidden && 'opacity-70',
            )}
            aria-current={current ? 'true' : undefined}
            onClick={() => !current && onOpen(v)}
            onDoubleClick={() => setRenaming(v.id)}
          >
            {current ? (
              <ChevronDown className="size-3 flex-none" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3 flex-none" aria-hidden="true" />
            )}
            <span className="min-w-0 truncate">{v.name}</span>
          </button>
        </Tip>
        <span className="hidden gap-px pr-1 group-focus-within/vault:flex group-hover/vault:flex">
          <Tip label={t('desktop.vaults.rename')}>
            <button type="button" className={ACT} aria-label={t('desktop.vaults.rename')} onClick={() => setRenaming(v.id)}>
              <Pencil className="size-3" />
            </button>
          </Tip>
          {v.hidden ? (
            <Tip label={t('desktop.vaults.show')}>
              <button type="button" className={ACT} aria-label={t('desktop.vaults.show')} onClick={() => onChange(setHidden(vaults, v.id, false))}>
                <Eye className="size-3" />
              </button>
            </Tip>
          ) : (
            !current && (
              <Tip label={t('desktop.vaults.hide')}>
                <button type="button" className={ACT} aria-label={t('desktop.vaults.hide')} onClick={() => onChange(setHidden(vaults, v.id, true))}>
                  <EyeOff className="size-3" />
                </button>
              </Tip>
            )
          )}
          {!current && (
            <Tip label={t('desktop.vaults.removeHint')}>
              <button type="button" className={ACT} aria-label={t('desktop.vaults.remove')} onClick={() => onChange(removeVault(vaults, v.id))}>
                <X className="size-3" />
              </button>
            </Tip>
          )}
        </span>
      </li>
    )
  }

  return (
    <section className="flex flex-col gap-0.5" aria-label={t('desktop.vaults.title')}>
      <div className="flex items-center justify-between px-0.5 pb-0.5">
        <span className="text-[11px] font-semibold uppercase leading-none tracking-widest text-muted-foreground">
          {t('desktop.vaults.title')}
        </span>
        <Tip label={t('desktop.vaults.add')}>
          <button
            type="button"
            className="grid size-[26px] flex-none place-items-center text-muted-foreground hover:text-primary"
            aria-label={t('desktop.vaults.add')}
            onClick={onAdd}
          >
            <FolderPlus className="size-4" />
          </button>
        </Tip>
      </div>
      <ul className="m-0 flex list-none flex-col gap-px p-0">{visible.map(row)}</ul>
      {hidden.length > 0 && (
        <>
          <button
            type="button"
            className="h-6 self-start px-2 text-xs text-muted-foreground hover:text-foreground" aria-expanded={showHidden} onClick={() => setShowHidden((s) => !s)}>
            {t(showHidden ? 'desktop.vaults.hideHidden' : 'desktop.vaults.showHidden', { count: hidden.length })}
          </button>
          {showHidden && <ul className="m-0 flex list-none flex-col gap-px p-0">{hidden.map(row)}</ul>}
        </>
      )}
    </section>
  )
}
