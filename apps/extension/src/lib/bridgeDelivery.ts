export interface BridgeDeliveryState {
  force: boolean
  sentEntries: number
  totalEntries: number
  summaryVersion?: string
  deliveredSummaryVersion?: string
}

/** A delivered transcript can still need a later summary update. */
export function needsDesktopDelivery(state: BridgeDeliveryState): boolean {
  return (
    state.force ||
    state.sentEntries < state.totalEntries ||
    (state.summaryVersion !== undefined && state.summaryVersion !== state.deliveredSummaryVersion)
  )
}
