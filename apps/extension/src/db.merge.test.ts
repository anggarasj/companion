import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_PREFIX,
  CHAT_PREFIX,
  CLEAN_PREFIX,
  CONTEXT_PREFIX,
  DOCS_PREFIX,
  DOCPROG_PREFIX,
  MERGED_PREFIX,
  META_PREFIX,
  RESOLVED_PREFIX,
  TITLE_PREFIX,
  TRANSCRIPT_PREFIX,
  mergeStoredMeetings,
  parseMeetingMergeSelection,
} from '@meetcc/shared';

interface TestEntry {
  speaker: string;
  text: string;
  time: string;
}

const entry = (text: string, time: string): TestEntry => ({ speaker: 'Speaker', text, time });
let values: Record<string, unknown> = {};
const storage = {
  get: vi.fn(async (key: string | string[] | null) => {
    if (key === null) return { ...values };
    if (typeof key === 'string') return { [key]: values[key] };
    return Object.fromEntries(key.filter((item) => item in values).map((item) => [item, values[item]]));
  }),
  set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
  remove: vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
  }),
};

function seedMeeting(id: string, startedAt: string, lastSeenAt: string, lines: TestEntry[]) {
  values[META_PREFIX + id] = { id, startedAt, lastSeenAt };
  values[TRANSCRIPT_PREFIX + id] = lines;
}

beforeEach(() => {
  values = {};
  vi.clearAllMocks();
  vi.stubGlobal('chrome', { storage: { local: storage } });
});

describe('merge stored meetings', () => {
  it('merges ended sources into a live target, ordered by time, and clears derived results', async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(now + ms).toISOString();
    seedMeeting('target', iso(-60_000), iso(-1_000), [entry('target later', iso(10_000)), entry('repeat', iso(20_000))]);
    seedMeeting('source-a', iso(-300_000), iso(-60_000), [entry('source early', iso(0)), entry('repeat', iso(20_000))]);
    seedMeeting('source-b', iso(-180_000), iso(-45_000), [entry('source middle', iso(5_000))]);
    values[TITLE_PREFIX + 'target'] = 'Main meeting';
    values[CONTEXT_PREFIX + 'target'] = 'Keep destination context';
    for (const prefix of [ANALYSIS_PREFIX, CHAT_PREFIX, CLEAN_PREFIX, DOCS_PREFIX, DOCPROG_PREFIX, RESOLVED_PREFIX]) {
      values[prefix + 'target'] = [];
    }
    values[ANALYSIS_PREFIX + 'source-a'] = { status: 'done' };

    const result = await mergeStoredMeetings(
      parseMeetingMergeSelection(['target', 'source-a', 'source-b'], 'target'),
    );

    expect(result).toEqual({ targetId: 'target', sourceIds: ['source-a', 'source-b'], entries: 5 });
    expect((values[TRANSCRIPT_PREFIX + 'target'] as TestEntry[]).map((line) => line.text)).toEqual([
      'source early',
      'source middle',
      'target later',
      'repeat',
      'repeat',
    ]);
    expect(values[MERGED_PREFIX + 'target']).toEqual(['source-a', 'source-b']);
    expect(values[ANALYSIS_PREFIX + 'target']).toBeUndefined();
    expect(values[CHAT_PREFIX + 'target']).toBeUndefined();
    expect(values[CLEAN_PREFIX + 'target']).toBeUndefined();
    expect(values[DOCS_PREFIX + 'target']).toBeUndefined();
    expect(values[DOCPROG_PREFIX + 'target']).toBeUndefined();
    expect(values[RESOLVED_PREFIX + 'target']).toBeUndefined();
    expect(values[TITLE_PREFIX + 'target']).toBe('Main meeting');
    expect(values[CONTEXT_PREFIX + 'target']).toBe('Keep destination context');
    for (const id of ['source-a', 'source-b']) {
      expect(values[TRANSCRIPT_PREFIX + id]).toBeUndefined();
      expect(values[META_PREFIX + id]).toBeUndefined();
    }
  });

  it('rejects a live source without changing either transcript', async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(now + ms).toISOString();
    seedMeeting('ended-target', iso(-120_000), iso(-60_000), [entry('keep', iso(-80_000))]);
    seedMeeting('live-source', iso(-60_000), iso(-1_000), [entry('do not lose', iso(-500))]);
    const beforeTarget = values[TRANSCRIPT_PREFIX + 'ended-target'];
    const beforeSource = values[TRANSCRIPT_PREFIX + 'live-source'];

    await expect(
      mergeStoredMeetings(parseMeetingMergeSelection(['ended-target', 'live-source'], 'ended-target')),
    ).rejects.toThrow('Only one meeting can be live');

    expect(values[TRANSCRIPT_PREFIX + 'ended-target']).toBe(beforeTarget);
    expect(values[TRANSCRIPT_PREFIX + 'live-source']).toBe(beforeSource);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('does not duplicate transcript lines when source cleanup is retried', async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(now + ms).toISOString();
    seedMeeting('target', iso(-120_000), iso(-60_000), [entry('target line', iso(-80_000))]);
    seedMeeting('source', iso(-300_000), iso(-120_000), [entry('source line', iso(-200_000))]);
    storage.remove.mockRejectedValueOnce(new Error('temporary storage failure'));
    const selection = parseMeetingMergeSelection(['target', 'source'], 'target');

    await expect(mergeStoredMeetings(selection)).rejects.toThrow('temporary storage failure');
    await mergeStoredMeetings(selection);

    expect((values[TRANSCRIPT_PREFIX + 'target'] as TestEntry[]).map((line) => line.text)).toEqual([
      'source line',
      'target line',
    ]);
    expect(values[TRANSCRIPT_PREFIX + 'source']).toBeUndefined();
  });

  it('requires a distinct destination among at least two selected sessions', () => {
    expect(() => parseMeetingMergeSelection(['only'], 'only')).toThrow();
    expect(() => parseMeetingMergeSelection(['one', 'two'], 'missing')).toThrow();
  });
});
