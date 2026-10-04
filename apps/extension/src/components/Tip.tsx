import type { ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function Tip({
  label,
  side = 'bottom',
  children,
}: {
  label: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}) {
  return (
    <TooltipProvider delayDuration={220}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
