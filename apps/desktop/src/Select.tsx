// A dropdown that belongs to the app.
//
// A native `<select>` draws its open panel in the platform's own chrome, which
// no stylesheet reaches — the same reason `<input type="date">` had to go. The
// closed control could be styled; the list could not.
//
// Replacing a native control means inheriting its obligations. A `<select>` is
// keyboard-operable for free, so this one is too: Up/Down move, Enter and
// Space choose, Escape closes without changing anything, Home/End jump.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The five the palette already has; anything unmapped stays neutral. */
export type Tone = 'neutral' | 'info' | 'warning' | 'danger' | 'success'

export interface Option {
  /** Stored verbatim; not translated, because it goes into the note file. */
  value: string
  label: string
  /** Colours the dot and tints the label. Absent means neutral. */
  tone?: Tone
}

// The dot does the work; the text is only tinted, so the tone is never the
// sole carrier of meaning for anyone who cannot separate these hues.
const DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  success: 'bg-primary',
}
const TEXT: Record<Tone, string> = {
  neutral: '',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-destructive',
  success: 'text-primary',
}

const toneOf = (option: Option | undefined): Tone => (option?.value === '' ? 'neutral' : (option?.tone ?? 'neutral'))

function Dot({ option }: { option: Option }) {
  // An empty value is "nothing chosen", which is not the same as a grey
  // status — it gets a hollow dot rather than a filled neutral one.
  const empty = option.value === ''
  return (
    <span
      data-dot={empty ? 'empty' : toneOf(option)}
      className={cn('size-[7px] flex-none rounded-full', empty ? 'ring-1 ring-inset ring-border' : DOT[toneOf(option)])}
      aria-hidden="true"
    />
  )
}

function Label({ option, className }: { option: Option | undefined; className?: string }) {
  return (
    <span data-tone={toneOf(option)} className={cn('truncate', TEXT[toneOf(option)], className)}>
      {option?.label ?? ''}
    </span>
  )
}

/** Keep in step with the panel's `max-h-[220px]` plus its offset. */
const PANEL_MAX = 232

export function Select({
  value,
  options,
  onChange,
  label,
  compact = false,
  className,
}: {
  value: string
  options: Option[]
  onChange: (value: string) => void
  label: string
  /** The AI panel's pickers: one short line, no tone dots, list opens leftwards-anchored. */
  compact?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  // Which way the panel opens. A select sitting in the editor's action bar is
  // a few pixels from the window's bottom edge, and a panel that always drops
  // downwards is simply cut off there — the options exist but cannot be seen.
  const [up, setUp] = useState(false)
  const [cursor, setCursor] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const index = useMemo(() => options.findIndex((o) => o.value === value), [options, value])
  const current = index >= 0 ? options[index] : options[0]

  // Opening lands on the current value, not at the top: arrowing from the
  // selected option is what a native select does.
  useEffect(() => {
    if (open) setCursor(index >= 0 ? index : 0)
  }, [open, index])

  // Measured at the moment of opening, not guessed from where the control
  // lives: the same select flips as the window is resized.
  useEffect(() => {
    if (!open) return
    const rect = wrap.current?.getBoundingClientRect()
    if (rect) setUp(rect.bottom + PANEL_MAX > window.innerHeight && rect.top > PANEL_MAX)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Keep the cursor visible when the list is long enough to scroll.
  useEffect(() => {
    if (!open) return
    const row = list.current?.querySelector<HTMLElement>('[data-cursor="true"]')
    // Called optionally: scrollIntoView is absent in some environments, and
    // keeping the list scrolled is never worth taking the component down.
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [open, cursor])

  const choose = (i: number): void => {
    onChange(options[i].value)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      // Down or Enter opens, matching a native select.
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        break
      case 'ArrowDown':
        e.preventDefault()
        setCursor((c) => Math.min(c + 1, options.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setCursor((c) => Math.max(c - 1, 0))
        break
      case 'Home':
        e.preventDefault()
        setCursor(0)
        break
      case 'End':
        e.preventDefault()
        setCursor(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        choose(cursor)
        break
      default:
        break
    }
  }

  return (
    <div className={cn('relative', className)} ref={wrap}>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border bg-sunken text-left text-foreground outline-none hover:border-muted-foreground focus-visible:border-primary',
          compact ? 'h-7 gap-1.5 rounded-md px-2 text-xs' : 'h-[34px] px-2.5 text-[13px]',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        {current && !compact && <Dot option={current} />}
        <Label option={current} className="min-w-0" />
        <ChevronDown className="ml-auto size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
      </button>

      {open && (
        <div
          className={cn(
            // Sized to its longest option, not to the control: tying the width
            // to the button made the list wide or narrow depending on which
            // option happened to be selected.
            'absolute z-25 max-h-[220px] w-max min-w-full max-w-[min(340px,60vw)] overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg',
            up ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]',
            compact ? 'left-0' : 'right-0',
          )}
          data-side={up ? 'top' : 'bottom'}
          role="listbox"
          aria-label={label}
          ref={list}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              data-cursor={i === cursor}
              className={cn(
                'flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-[13px]',
                i === cursor && 'bg-muted',
                o.value === value && 'font-semibold text-primary',
              )}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => {
                // mousedown, not click: the outside-click listener fires first
                // otherwise and the panel closes before the choice lands.
                e.preventDefault()
                choose(i)
              }}
            >
              {!compact && <Dot option={o} />}
              <Label option={o} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
