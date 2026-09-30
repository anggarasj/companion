import { describe, expect, it } from 'vitest';
import type { Analysis, Meeting } from '@meetcc/shared';
import { toBridgeBatch, toDocumentBridgeBatch } from './bridgeBatch';

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 'abc-defg-hij#1787918400000',
  meta: { id: 'abc-defg-hij#1787918400000', startedAt: '2026-08-28T14:00:00+07:00', lastSeenAt: '2026-08-28T15:00:00+07:00' },
  entries: [
    { speaker: 'Andi', text: 'baris satu', time: '2026-08-28T14:01:00Z' },
    { speaker: 'Rani', text: 'baris dua', time: '2026-08-28T14:02:00Z' },
  ],
  ...over,
});

describe('toBridgeBatch', () => {
  it('sends only the captions the vault has not seen', () => {
    const batch = toBridgeBatch(meeting(), 1);
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0].text).toBe('baris dua');
  });

  it('derives the same operation id for the same slice', () => {
    expect(toBridgeBatch(meeting(), 0).operationId).toBe(toBridgeBatch(meeting(), 0).operationId);
    expect(toBridgeBatch(meeting(), 1).operationId).not.toBe(toBridgeBatch(meeting(), 0).operationId);
  });

  it('distinguishes transcript-only and summarized delivery ids', () => {
    const analysis: Analysis = {
      executiveSummary: 'Ringkasan rapat.',
      timeline: [],
      keyDiscussions: [],
      decisions: [],
      actionItems: [],
      risks: [],
      openQuestions: [],
      nextSteps: [],
      diagrams: [],
    };
    expect(toBridgeBatch(meeting(), 0).operationId).not.toBe(
      toBridgeBatch(meeting(), 0, analysis).operationId,
    );
  });

  it('includes the analysis version in summary operation ids', () => {
    const analysis: Analysis = {
      executiveSummary: 'Ringkasan rapat.',
      timeline: [],
      keyDiscussions: [],
      decisions: [],
      actionItems: [],
      risks: [],
      openQuestions: [],
      nextSteps: [],
      diagrams: [],
    };
    expect(toBridgeBatch(meeting(), 0, analysis, false, 'v1').operationId).not.toBe(
      toBridgeBatch(meeting(), 0, analysis, false, 'v2').operationId,
    );
  });

  it('carries the room, participants and start of the meeting', () => {
    const batch = toBridgeBatch(meeting(), 0);
    expect(batch.roomId).toBe('abc-defg-hij');
    expect(batch.platform).toBe('google-meet');
    expect(batch.participants).toEqual(['Andi', 'Rani']);
    expect(batch.startedAt).toBe('2026-08-28T14:00:00+07:00');
  });

  it('labels a Teams room', () => {
    expect(toBridgeBatch(meeting({ id: 'tms-xyz#1787918400000' }), 0).platform).toBe('teams');
  });

  it('only puts a note body on the first delivery', () => {
    const analysis = {
      executiveSummary: 'Ringkasan rapat.',
      timeline: [],
      keyDiscussions: [],
      decisions: [],
      actionItems: [],
      risks: [],
      openQuestions: [],
      nextSteps: [],
      diagrams: [],
    };
    expect(toBridgeBatch(meeting(), 0, analysis).markdown).toContain('Ringkasan rapat.');
    expect(toBridgeBatch(meeting(), 1, analysis).markdown).toBeUndefined();
  });
  it('exports transcript entries without a summary', () => {
    const batch = toBridgeBatch(meeting(), 0, null, true);
    expect(batch.entries.map((entry) => entry.text)).toEqual(['baris satu', 'baris dua']);
    expect(batch.markdown).toBeUndefined();
    expect(batch.snapshot).toBe(true);
  });
  it('marks repeated transcript-only exports as snapshots', () => {
    expect(toBridgeBatch(meeting(), 0, null, true).snapshot).toBe(true);
  });
});

describe('toBridgeBatch resend', () => {
  const analysis: Analysis = {
    executiveSummary: 'Ringkasan baru.',
    timeline: [],
    keyDiscussions: [],
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
    nextSteps: [],
    diagrams: [],
  };

  it('a manual full resend carries the body and marks the transcript as a snapshot', () => {
    const batch = toBridgeBatch(meeting(), 0, analysis, true);
    expect(batch.markdown).toBeTruthy();
    expect(batch.replaceBody).toBe(true);
    expect(batch.snapshot).toBe(true);
  });

  it('carries meeting tags', () => {
    expect(toBridgeBatch(meeting({ tags: ['vault'] }), 0).tags).toEqual(['vault']);
  });
});

describe('toDocumentBridgeBatch', () => {
  it('creates a separate meeting-platform note for the selected output', () => {
    const document = toDocumentBridgeBatch(
      meeting({ tags: ['architecture'] }),
      'notulen',
      'Quarterly architecture sync',
      'Notulen',
      '# Decisions\n\nPakai read replica.',
      '2026-09-29T10:00:00.000Z',
    );

    expect(document.roomId).toBe('abc-defg-hij-document-notulen');
    expect(document.sessionKey).toBe('abc-defg-hij-document-notulen#2026-08-28T14:00:00+07:00');
    expect(document.platform).toBe('google-meet');
    expect(document.entries).toEqual([]);
    expect(document.markdown).toContain('# Quarterly architecture sync — Notulen');
    expect(document.markdown).toContain('Pakai read replica.');
    expect(document.replaceBody).toBe(true);
    expect(document.snapshot).toBe(true);
    expect(document.includeTranscript).toBe(false);
    expect(document.tags).toEqual(['architecture', 'dokumen', 'notulen']);
  });

  it('uses the source meeting platform for Teams documents', () => {
    const document = toDocumentBridgeBatch(
      meeting({ id: 'tms-xyz#1787918400000' }),
      'notulen',
      'Sync',
      'Notulen',
      '# Notes',
      '2026-09-29T10:00:00.000Z',
    );
    expect(document.platform).toBe('teams');
  });
});
