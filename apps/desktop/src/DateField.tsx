// A date field that looks like the rest of the app.
//
// `<input type="date">` draws its calendar in the browser's own panel, which
// no stylesheet can reach — in a desktop window it reads as a foreign control
// pinned to its own palette. This is the same field built from ordinary
// elements, so it follows the theme tokens like everything else.
//
// The value stays the ISO `YYYY-MM-DD` the frontmatter stores; only the
// display is localised.
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDate, locale, t } from '@meetcc/shared/i18n'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** Weekday initials and month names come from Intl, so they follow the
    language without a second list to keep in step with the catalogue. */
function weekdayNames(): string[] {
  const fmt = new Intl.DateTimeFormat(locale(), { weekday: 'short' })
  // 2024-01-01 was a Monday, and this calendar starts on Monday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)))
}

function monthName(d: Date): string {
  return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(d)
}

export const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Parsed as local time: `new Date('2026-09-04')` is UTC and can shift a day. */
export function parseIso(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

function label(value: string): string {
  return parseIso(value) ? formatDate(value) : ''
}

/**
 * The days to draw for `month`, padded to whole weeks starting Monday, so the
 * grid never reflows as the user pages between months.
 */
export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  // getDay() is Sunday-first; this calendar starts on Monday.
  const lead = (first.getDay() + 6) % 7
  const start = new Date(first)
  start.setDate(1 - lead)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

export function DateField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState<Date>(() => parseIso(value) ?? new Date())
  const wrap = useRef<HTMLDivElement>(null)

  // Reopening on a note with a date should land on that date's month, not
  // wherever the last note left the calendar.
  useEffect(() => {
    if (open) setMonth(parseIso(value) ?? new Date())
  }, [open, value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const days = useMemo(() => monthGrid(month), [month])
  const dayNames = useMemo(() => weekdayNames(), [])
  const today = iso(new Date())
  const shift = (by: number): void =>
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + by, 1))

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        className="flex h-[34px] w-full items-center justify-between gap-1.5 rounded-lg border bg-sunken px-2.5 text-left text-[13px] text-foreground hover:border-muted-foreground"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <CalendarDays className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
        <span className={cn('flex-1', !value && 'text-muted-foreground')}>{label(value) || t('desktop.date.pick')}</span>
        {/* Clearing has to be reachable: a due date that cannot be removed is
            worse than one that was never set. */}
        {value && (
          <span
            role="button"
            tabIndex={0}
            className="flex-none px-0.5 text-muted-foreground hover:text-destructive"
            aria-label={t('desktop.date.clear')}
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                e.preventDefault()
                onChange('')
              }
            }}
          >
            <X className="size-3.5" />
          </span>
        )}
      </button>

      {open && (
        // Anchored to the trigger's right edge: this is the last field in the
        // row, so a left-anchored popover runs off the window.
        <div
          className="absolute right-0 top-[calc(100%+6px)] z-20 w-[244px] rounded-xl border bg-popover p-2.5 text-popover-foreground shadow-lg"
          role="dialog"
          aria-label={t('desktop.date.dialog')}
        >
          <div className="mb-2 flex items-center justify-between">
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => shift(-1)} aria-label={t('desktop.date.prevMonth')}>
              <ChevronLeft />
            </Button>
            <strong className="text-[12.5px] font-semibold">{monthName(month)}</strong>
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => shift(1)} aria-label={t('desktop.date.nextMonth')}>
              <ChevronRight />
            </Button>
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {dayNames.map((d, i) => (
              <span
                key={i}
                className="pb-1 text-center font-mono text-[9.5px] font-semibold uppercase leading-none tracking-wider text-muted-foreground"
              >
                {d}
              </span>
            ))}
            {days.map((d) => {
              const key = iso(d)
              const selected = key === value
              return (
                <button
                  key={key}
                  type="button"
                  className={cn(
                    'h-7 rounded-md text-xs text-foreground hover:bg-muted',
                    d.getMonth() !== month.getMonth() && 'text-muted-foreground opacity-50',
                    key === today && 'ring-1 ring-inset ring-border',
                    selected && 'bg-primary font-semibold text-primary-foreground hover:bg-primary',
                  )}
                  onClick={() => {
                    onChange(key)
                    setOpen(false)
                  }}
                >
                  {d.getDate()}
                </button>
              )
            })}
          </div>

          <div className="mt-2 border-t pt-2 text-right">
            <Button type="button" variant="link" size="xs" onClick={() => { onChange(today); setOpen(false) }}>
              {t('desktop.date.today')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
