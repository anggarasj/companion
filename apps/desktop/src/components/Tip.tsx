import type { ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** A tooltip drawn by us. macOS renders this window in WKWebView, which never
 *  shows the HTML `title` attribute, so an icon-only control needs one of
 *  these. The accessible name still comes from the control's aria-label. A
 *  disabled control gets no hover events — wrap it in a span first. */
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
