import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export interface SegmentedOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

/** One choice out of a few, always visible. A single-select toggle group that
 *  never deselects: clicking the chosen option again keeps it chosen. */
export function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  itemClassName,
}: {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  className?: string
  itemClassName?: string
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={1}
      value={value}
      onValueChange={(next) => next && onChange(next)}
      aria-label={ariaLabel}
      className={cn('flex-none', className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            'h-7 rounded-full px-3.5 text-xs font-semibold text-muted-foreground shadow-none hover:text-foreground data-[state=on]:border-primary data-[state=on]:bg-primary/14 data-[state=on]:text-primary',
            itemClassName,
          )}
        >
          <span className="min-w-0 truncate">{option.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
