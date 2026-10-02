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

/** A completed legacy transcript with no marker predates summary tracking. */
export function shouldBackfillDeliveredSummary(
  sentEntries: number,
  totalEntries: number,
  deliveredSummaryVersion: string | undefined,
  pendingSummary: boolean,
  force = false,
): boolean {
  return (
    !force &&
    sentEntries > 0 &&
    sentEntries >= totalEntries &&
    deliveredSummaryVersion === undefined &&
    !pendingSummary
  )
}

const PENDING_PREFIX = 'pending:'

export function deliveredSummaryVersion(marker: unknown): string | undefined {
  if (typeof marker !== 'string') return undefined
  const version = marker.startsWith(PENDING_PREFIX) ? marker.slice(PENDING_PREFIX.length) : marker
  return version || undefined
}

export function isSummaryPending(marker: unknown): boolean {
  return typeof marker === 'string' && marker.startsWith(PENDING_PREFIX)
}

export function markSummaryPending(marker: unknown): string {
  return `${PENDING_PREFIX}${deliveredSummaryVersion(marker) ?? ''}`
}
/** A transcript-only send preserves a delivered summary, or marks a new one pending. */
export function summaryMarkerAfterTranscriptOnlyExport(
  marker: unknown,
  sentEntries: number,
  totalEntries: number,
  currentSummaryVersion?: string,
): string {
  if (isSummaryPending(marker)) return marker as string
  const deliveredVersion = deliveredSummaryVersion(marker)
  if (deliveredVersion !== undefined) return marker as string
  if (currentSummaryVersion && sentEntries > 0 && sentEntries >= totalEntries) {
    return currentSummaryVersion
  }
  return markSummaryPending(marker)
}
