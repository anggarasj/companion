import { describe, expect, it } from 'vitest';
import { needsDesktopDelivery } from './bridgeDelivery';

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
