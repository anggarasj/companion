import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SegmentedOption {
  value: string
  label: ReactNode
  icon?: LucideIcon
  disabled?: boolean
}

export interface SegmentedProps {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  role?: 'group' | 'tablist'
  className?: string
  itemClassName?: string
}

export function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
  role = 'tablist',
  className,
  itemClassName,
}: SegmentedProps) {
  const isTabList = role === 'tablist'

  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex h-8 items-center rounded-lg bg-muted/70 p-0.5 text-muted-foreground border border-border/50 gap-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const selected = value === option.value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role={isTabList ? 'tab' : undefined}
            aria-selected={isTabList ? selected : undefined}
            aria-pressed={isTabList ? undefined : selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all select-none outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
              selected
                ? 'bg-background text-foreground shadow-xs font-semibold'
                : 'hover:text-foreground hover:bg-background/40',
              itemClassName,
            )}
          >
            {Icon && <Icon className="size-3.5 shrink-0" />}
            <span className="truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export const SegmentedControl = Segmented
