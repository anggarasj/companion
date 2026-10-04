// The "⋯" menu for the open page: what used to be a row of buttons under the
// editor. Saving is automatic, so the only actions left are the rare ones.
import { useEffect, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import { t } from '@meetcc/shared/i18n'
import { cn } from '@/lib/utils'
import { Tip } from '@/components/Tip'

export interface PageAction {
  id: string
  label: string
  danger?: boolean
  run: () => void
}

export function PageMenu({ actions }: { actions: PageAction[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <span className="relative inline-flex" ref={wrap}>
      <Tip label={t('desktop.page.menu')}>
        <button
          type="button"
          className="grid h-6 w-[26px] place-items-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('desktop.page.menu')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Ellipsis className="size-4" />
        </button>
      </Tip>
      {open && (
        <div
          className="absolute right-0 top-[calc(100%+6px)] z-40 min-w-[200px] rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
          role="menu"
        >
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className={cn(
                'flex h-[30px] w-full items-center rounded-[5px] px-2.5 text-left text-[13px] hover:bg-muted',
                a.danger && 'text-destructive',
              )}
              onClick={() => {
                setOpen(false)
                a.run()
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
