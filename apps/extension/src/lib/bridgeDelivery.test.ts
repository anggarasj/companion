import { describe, expect, it } from 'vitest';

import {
  deliveredSummaryVersion,
  isSummaryPending,
  markSummaryPending,
  needsDesktopDelivery,
  shouldBackfillDeliveredSummary,
  summaryMarkerAfterTranscriptOnlyExport,
} from './bridgeDelivery';
describe('needsDesktopDelivery', () => {
  it('delivers a summary after a transcript-only export sent every caption', () => {
    expect(
      needsDesktopDelivery({
        force: false,
        sentEntries: 8,
        totalEntries: 8,
        summaryVersion: '2026-09-30T10:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('does not resend a summary version that the desktop already received', () => {
    expect(
      needsDesktopDelivery({
        force: false,
        sentEntries: 8,
        totalEntries: 8,
        summaryVersion: 'v1',
        deliveredSummaryVersion: 'v1',
      }),
    ).toBe(false);
  });

  it('delivers a newer summary even when no captions changed', () => {
    expect(
      needsDesktopDelivery({
        force: false,
        sentEntries: 8,
        totalEntries: 8,
        summaryVersion: 'v2',
        deliveredSummaryVersion: 'v1',
      }),
    ).toBe(true);
  });

  it('delivers new captions or a forced summary resend', () => {
    expect(needsDesktopDelivery({ force: false, sentEntries: 7, totalEntries: 8 })).toBe(true);
    expect(
      needsDesktopDelivery({
        force: true,
        sentEntries: 8,
        totalEntries: 8,
        summaryVersion: 'v1',
        deliveredSummaryVersion: 'v1',
      }),
    ).toBe(true);
  });
});

describe('shouldBackfillDeliveredSummary', () => {
  it('marks a fully delivered legacy transcript as already summarized', () => {
    expect(shouldBackfillDeliveredSummary(8, 8, undefined, false)).toBe(true);
    expect(shouldBackfillDeliveredSummary(9, 8, undefined, false)).toBe(true);
  });

  it('does not backfill empty, incomplete, marked, or explicitly pending delivery', () => {
    expect(shouldBackfillDeliveredSummary(0, 0, undefined, false)).toBe(false);
    expect(shouldBackfillDeliveredSummary(7, 8, undefined, false)).toBe(false);
    expect(shouldBackfillDeliveredSummary(8, 8, 'old-version', false)).toBe(false);
    expect(shouldBackfillDeliveredSummary(8, 8, undefined, true)).toBe(false);
    expect(shouldBackfillDeliveredSummary(8, 8, undefined, false, true)).toBe(false);
  });
});


describe('summary markers', () => {
  it('preserves the delivered version while marking an explicit transcript-only export pending', () => {
    const marker = markSummaryPending('v1');
    expect(marker).not.toBe('v1');
    expect(isSummaryPending(marker)).toBe(true);
    expect(deliveredSummaryVersion(marker)).toBe('v1');
  });
});
describe('summary marker after transcript-only export', () => {
  it('keeps an existing delivered or pending summary marker', () => {
    expect(summaryMarkerAfterTranscriptOnlyExport('v1', 8, 8, 'v1')).toBe('v1')
    expect(summaryMarkerAfterTranscriptOnlyExport('pending:v1', 8, 8, 'v1')).toBe('pending:v1')
  })

  it('marks an unsummarized transcript pending for a later analysis', () => {
    expect(summaryMarkerAfterTranscriptOnlyExport(undefined, 0, 8, 'v1')).toBe('pending:')
    expect(summaryMarkerAfterTranscriptOnlyExport(undefined, 0, 8)).toBe('pending:')
  })

  it('treats a fully sent legacy summary as delivered during explicit transcript export', () => {
    expect(summaryMarkerAfterTranscriptOnlyExport(undefined, 8, 8, 'v1')).toBe('v1')
  })
})