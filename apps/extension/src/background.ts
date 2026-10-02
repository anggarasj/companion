// MV3 service worker: detects finished meetings and runs the AI pipeline.
// Business logic lives in @meetcc/meeting; this file only wires chrome.* in.
import {
  askMeeting,
  cleanTranscript,
  createClient,
  createRateLimiter,
  DOC_META,
  generateDiagrams,
  validateSettings,
} from '@meetcc/ai';
import { asLangPref, resolveLang, setLang, t } from '@meetcc/shared/i18n';
import {
  askMeetings,
  findExpiredMeetings,
  findFinishedMeetings,
  runDocGen,
  runPipeline,
  type DocGenDeps,
  type PipelineDeps,
  type PipelineOptions,
  type PipelineResult,
} from '@meetcc/meeting';
import { GATE_EVENT, describeGate, gateSummary } from '@meetcc/exporters/gate';
import { describeG3, g3Rollup } from '@meetcc/exporters/g3';
import { obsidianVault } from '@meetcc/exporters/obsidian';
import { loadSettingsForAI } from './lib/aiSettings';
import { makeZip } from './lib/zip';
import { toBridgeBatch, toDocumentBridgeBatch } from './lib/bridgeBatch';
import { classifyBridgeError } from './lib/bridgeError';
import {
  deliveredSummaryVersion,
  isSummaryPending,
  markSummaryPending,
  needsDesktopDelivery,
  shouldBackfillDeliveredSummary,
  summaryMarkerAfterTranscriptOnlyExport,
} from './lib/bridgeDelivery';
import { getStore, handleDb, refreshHighlights, syncIndex } from './db';
import {
  appendAudit,
  AUDIT_RING_MAX,
  clearClean,
  clearDocProgress,
  clearMeeting,
  deriveTitle,
  effectiveClean,
  ensureReleaseT0,
  fetchLatestRelease,
  getAnalysis,
  getTitle,
  loadAnalyses,
  loadAudit,
  loadChat,
  loadClean,
  getMeetingTags,
  loadDocs,
  getMiniContexts,
  isLive,
  loadMeetings,
  loadSettings,
  resolveSession,
  roomIdOf,
  sanitizeRoomId,
  saveChat,
  saveClean,
  saveDoc,
  saveDocProgress,
  saveTitle,
  setAnalysis,
  UPDATE_KEY,
  type Analysis,
  type AnalysisRecord,
  type AskResult,
  type ChatMessage,
  type DocType,
  type Meeting,
  type TimelineItem,
} from '@meetcc/shared';

// 6 AI runs per 10 minutes: a meeting sweep can never stampede a provider
const limiter = createRateLimiter(6, 10 * 60_000);

// Interactive calls (chat, doc generation) get a separate, roomier budget so
// they never starve the auto-analysis pipeline and vice-versa. Same mechanism.
const interactiveLimiter = createRateLimiter(20, 10 * 60_000);

async function makeInteractiveClient() {
  const settings = await loadSettingsForAI();
  const problem = validateSettings(settings);
  if (problem) throw new Error(problem);
  if (!interactiveLimiter.take()) {
    throw new Error(t('ext.err.rateLimited'));
  }
  return createClient(settings);
}

async function analysisOf(id: string): Promise<Analysis | null> {
  const rec = await getAnalysis(id);
  return rec?.status === 'done' ? rec.analysis : null;
}

// Every AI read of the transcript prefers the cleaned version when the user
// has run "Rapikan" — so summaries, chat and docs use the corrected text.
// Transcript is append-only, so when the same meeting link is reused later the
// raw transcript grows past what was cleaned. Merge: cleaned lines for the part
// that was cleaned + raw lines for anything appended since. This never loses
// new content and still uses the corrections where they exist.
async function loadMeetingForAI(id: string): Promise<Meeting | null> {
  const meeting = (await loadMeetings()).find((m) => m.id === id);
  if (!meeting) return null;
  const clean = await loadClean(id);
  // §26: lines the user rejected fall back to the raw capture, and lines
  // captured after the cleanup ran are appended untouched
  const baseEntries =
    clean?.status !== 'done' || !clean.entries.length
      ? meeting.entries
      : effectiveClean(meeting.entries, clean);

  // §context: Enrich context with terms from active tags / glossary for AI accuracy
  const tags = meeting.tags ?? (await getMeetingTags(id));
  let context = meeting.context ?? '';
  if (tags && tags.length > 0) {
    const miniContexts = await getMiniContexts();
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const matched = miniContexts.filter(
      (c) =>
        tagSet.has(c.term.toLowerCase()) ||
        c.tags.some((tg) => tagSet.has(tg.toLowerCase())),
    );
    if (matched.length > 0) {
      const glossaryLines = matched.map((c) => `[${c.term}]: ${c.definition}`);
      const glossaryBlock = `Istilah & Konteks Tambahan:\n${glossaryLines.join('\n')}`;
      context = context.trim() ? `${context.trim()}\n\n${glossaryBlock}` : glossaryBlock;
    }
  }

  return { ...meeting, context, entries: baseEntries };
}

// The notification id IS the meeting id, so onClicked can open that meeting.
function notify(title: string, message: string, meetingId: string): void {
  chrome.notifications.create(meetingId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}

const deps: PipelineDeps = {
  getMeeting: loadMeetingForAI,
  getRecord: getAnalysis,
  setRecord: async (id, record) => {
    await setAnalysis(id, record);
    if (record.status === 'done') {
      const key = BRIDGE_SUMMARY_KEY(id);
      const stored = await chrome.storage.local.get(key);
      if (!isSummaryPending(stored[key])) {
        await chrome.storage.local.set({ [key]: markSummaryPending(stored[key]) });
      }
    }
  },
  createClient: async () => {
    const settings = await loadSettingsForAI();
    const problem = validateSettings(settings);
    if (problem) throw new Error(problem);
    if (!limiter.take()) throw new Error(t('ext.err.analysisRateLimited'));
    return createClient(settings);
  },
  audit: appendAudit,
  notify,
  now: () => new Date().toISOString(),
};

/** Run the pipeline and, on success, give the meeting a readable name if it
 *  doesn't have one. A user-set title is never overwritten. */
async function analyze(id: string, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const result = await runPipeline(id, deps, opts);
  if (!result.ok) return result;
  if (await getTitle(id)) return result;
  const analysis = await analysisOf(id);
  const title = analysis ? deriveTitle(analysis) : '';
  if (title) await saveTitle(id, title);
  return result;
}

/** Delete meetings past the user's retention window. Opt-in: `retentionDays`
 *  defaults to 0 (keep forever), and deletion here is irreversible. */
async function enforceRetention(meetings: Meeting[]): Promise<void> {
  const { retentionDays } = await loadSettings();
  const expired = findExpiredMeetings(meetings, retentionDays, Date.now());
  for (const m of expired) {
    await clearMeeting(m.id);
    await getStore()
      .then((db) => db.deleteSession(m.id))
      .catch(() => undefined);
    await appendAudit('retention.delete', `${m.id}: > ${retentionDays} hari`);
  }
}

let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const [meetings, records] = await Promise.all([loadMeetings(), loadAnalyses()]);
    for (const m of findFinishedMeetings(meetings, records, Date.now())) {
      await analyze(m.id);
      const refreshed = await getAnalysis(m.id);
      if (refreshed) records[m.id] = refreshed;
      else delete records[m.id];
    }
    await enforceRetention(meetings);
    // Opt-in second delivery target: the desktop vault. Only meetings that have
    // ended — a live one would hand over a note body before there is a summary
    // to put in it, and the vault fills the body once.
    if ((await loadSettings()).desktopBridge) {
      for (const m of meetings) {
        if (isLive(m, Date.now())) continue;
        await deliverToDesktop(
          m,
          false,
          true,
          records[m.id] ?? null,
        ).catch((e) => console.warn('[MeetCC] desktop bridge delivery failed:', e));
      }
    }
    // it correct even if a write was missed while the worker was suspended
    await syncIndex().catch((e) => console.warn('[MeetCC] index sync failed:', e));
    for (const m of meetings) {
      if (isLive(m, Date.now())) {
        await refreshHighlights(m.id, m.entries).catch(() => undefined);
      }
    }
  } finally {
    sweeping = false;
  }
}

// Chromium never auto-updates an unpacked extension, so the dashboard has to
// be told a release exists. Once a day is plenty — the user updates by hand
// anyway, and GitHub's unauthenticated API is rate-limited per IP.
const MANUAL_UPDATE_CHECK = Boolean(chrome.runtime.getManifest().key);

async function checkForUpdate(): Promise<void> {
  const state = await fetchLatestRelease();
  if (state) await chrome.storage.local.set({ [UPDATE_KEY]: state });
}

function scheduleAlarms(): void {
  chrome.alarms.create('sweep', { periodInMinutes: 1 });
  if (MANUAL_UPDATE_CHECK) {
    chrome.alarms.create('update-check', { delayInMinutes: 1, periodInMinutes: 60 * 24 });
  } else {
    void chrome.alarms.clear('update-check');
  }
}

chrome.runtime.onInstalled.addListener(scheduleAlarms);
chrome.runtime.onStartup.addListener(scheduleAlarms);
// §32.1 gate anchor: stamped once, on the first run of the build that ships
// it — install for new users, update for existing ones — not guessed later
// from whatever the audit ring still holds.
chrome.runtime.onInstalled.addListener(() => void ensureReleaseT0(Date.now()));
chrome.runtime.onStartup.addListener(() => void ensureReleaseT0(Date.now()));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('sweep')) void sweep();
  if (MANUAL_UPDATE_CHECK && alarm.name === 'update-check') void checkForUpdate();
});

// Dashboard window: one shared popup window, reused/focused if already open.
// focused: true matters — an unfocused window opens behind the (often
// fullscreen) browser on macOS and looks like it never appeared.
const APP_URL = chrome.runtime.getURL('index.html');

async function openDashboard(marker?: string): Promise<void> {
  const url = marker ? `${APP_URL}?${marker}` : APP_URL;
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
    for (const w of wins) {
      const tab = w.tabs?.find((t) => t.url?.startsWith(APP_URL));
      if (tab && w.id !== undefined) {
        if (marker && tab.id !== undefined && !tab.url?.includes(marker)) {
          await chrome.tabs.update(tab.id, { url });
        }
        await chrome.windows.update(w.id, { focused: true });
        return;
      }
    }
    await chrome.windows.create({ url, type: 'popup', width: 980, height: 680, focused: true });
  } catch (e) {
    console.warn('[MeetCC] openDashboard window failed, falling back to tab:', e);
    await chrome.tabs.create({ url }).catch(() => undefined);
  }
}

chrome.action.onClicked.addListener(() => void openDashboard());

// The notification id is the meeting id (see `notify`) — open that meeting.
chrome.notifications.onClicked.addListener((notificationId) => {
  void openDashboard(`meeting=${encodeURIComponent(notificationId)}`);
  chrome.notifications.clear(notificationId);
});

// F2: chat with transcript. Runs in the SW so the decrypted API key never
// reaches the dashboard page and every call passes the interactive limiter.
async function handleAsk(
  id: string,
  question: string,
): Promise<{ ok: true; answer: string; result: AskResult } | { ok: false; error: string }> {
  const meeting = await loadMeetingForAI(id);
  if (!meeting) return { ok: false, error: t('ext.err.meetingNotFound') };
  if (!meeting.entries.length) return { ok: false, error: 'Transcript masih kosong.' };
  const history = await loadChat(id);
  // Persist the question before asking, not after answering. A failed call
  // used to take the question with it: the dashboard held it in component
  // state, so leaving the tab lost what was typed with nothing to retry from.
  const asked: ChatMessage[] = [
    ...history,
    { role: 'user', content: question, time: new Date().toISOString() },
  ];
  await saveChat(id, asked);
  const client = await makeInteractiveClient();
  const result = await askMeeting(client, meeting, await analysisOf(id), history, question);
  const turns: ChatMessage[] = [
    ...asked,
    { role: 'assistant', content: result.answer, time: new Date().toISOString(), result },
  ];
  await saveChat(id, turns);
  await appendAudit('ask', `${id} (${result.answerability})`);
  return { ok: true, answer: result.answer, result };
}

// P1.8: Ask across every stored meeting. Retrieval is SQL + FTS5 over the
// local index; only the resulting evidence windows go to the model.
async function handleGlobalAsk(
  question: string,
): Promise<{ ok: true; result: Awaited<ReturnType<typeof askMeetings>> } | { ok: false; error: string }> {
  const client = await makeInteractiveClient();
  const result = await askMeetings(client, await getStore(), question);
  // §32.1 G3 needs the number of *distinct meetings* whose evidence supported
  // the answer. The answer's verified spans are per-meeting windows, so the
  // count comes from the ids those spans belong to — one structured audit
  // field per query, still local-only (no telemetry).
  const sessionsCited = new Set(result.evidence.map((span) => span.sessionId));
  await appendAudit(
    'ask.global',
    `question=${question.slice(0, 60)}; meetingsCited=${sessionsCited.size}; answerability=${result.answerability}`,
  );
  return { ok: true, result };
}

// F4: on-demand document generation (BRD / PRD / notulen). Orchestration and
// the double-submit guard live in @meetcc/meeting (runDocGen); this is only
// the chrome.* wiring, like the pipeline above.
const docGenDeps: DocGenDeps = {
  getMeeting: loadMeetingForAI,
  getAnalysis: analysisOf,
  createClient: makeInteractiveClient,
  saveProgress: saveDocProgress,
  clearProgress: clearDocProgress,
  saveDoc,
  getTemplate: async (templateId) =>
    templateId ? (await getStore()).templates().find((t) => t.id === templateId) : undefined,
  audit: appendAudit,
  now: () => new Date().toISOString(),
};

function resolveTimelineSelection(
  value: unknown,
  analysis: Analysis | null,
): { topics?: TimelineItem[]; error?: string } {
  if (value === undefined) return {}
  if (!Array.isArray(value) || !value.length || !analysis) {
    return { error: t('ext.docs.timelineSelectionInvalid') }
  }
  const topics: TimelineItem[] = []
  const seen = new Set<number>()
  for (const index of value) {
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= analysis.timeline.length
    ) {
      return { error: t('ext.docs.timelineSelectionInvalid') }
    }
    if (seen.has(index)) continue
    seen.add(index)
    topics.push(analysis.timeline[index])
  }
  return topics.length ? { topics } : { error: t('ext.docs.timelineSelectionInvalid') }
}

async function handleGenerateDoc(
  id: string,
  docType: DocType,
  templateId?: string,
  timelineIndices?: unknown,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const selection = resolveTimelineSelection(timelineIndices, await analysisOf(id))
  if (selection.error) return { ok: false, error: selection.error }
  const res = await runDocGen(id, docType, templateId, docGenDeps, selection.topics)
  return res.ok ? res : { ok: false, error: res.error };
}

// F1: on-demand diagram generation. Runs on the cleaned transcript when
// available and merges the diagrams into the existing (done) analysis record,
// so exports and the Diagram tab pick them up. Requires summary to exist.
async function handleGenerateDiagram(
  id: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const rec = await getAnalysis(id);
  if (rec?.status !== 'done') {
    return { ok: false, error: t('ext.err.summaryFirst') };
  }
  const meeting = await loadMeetingForAI(id);
  if (!meeting?.entries.length) return { ok: false, error: 'Transcript masih kosong.' };
  const client = await makeInteractiveClient();
  const diagrams = await generateDiagrams(client, meeting);
  await setAnalysis(id, { ...rec, analysis: { ...rec.analysis, diagrams } });
  await appendAudit('diagram', `${id}: ${diagrams.length}`);
  return { ok: true, count: diagrams.length };
}

// AI transcript cleanup: correct ASR errors on the RAW transcript, store the
// result under clean:<id> (raw stays untouched). One client reused across all
// chunks, so a whole cleanup costs a single interactive-limiter token.
async function handleCleanTranscript(
  id: string,
  fromScratch = false,
): Promise<{ ok: true; changed: number } | { ok: false; error: string }> {
  const meeting = (await loadMeetings()).find((m) => m.id === id);
  if (!meeting) return { ok: false, error: t('ext.err.meetingNotFound') };
  if (!meeting.entries.length) return { ok: false, error: 'Transcript masih kosong.' };

  // resume an interrupted run: reuse partial entries + continue from `done`,
  // unless the user asked to start over (fromScratch)
  const prev = await loadClean(id);
  const resumable =
    !fromScratch &&
    prev?.status === 'processing' &&
    Array.isArray(prev.entries) &&
    prev.entries.length === meeting.entries.length &&
    Number.isFinite(prev.done);
  const base = resumable ? prev.entries : meeting.entries;
  const startLine = resumable ? prev.done : 0;
  const startedAt =
    resumable && prev.startedAt ? prev.startedAt : new Date().toISOString();
  const now = () => new Date().toISOString();

  await saveClean(id, {
    status: 'processing',
    startedAt,
    updatedAt: now(),
    done: startLine,
    total: base.length,
    entries: base,
  });
  try {
    const client = await makeInteractiveClient();
    const { entries, changed } = await cleanTranscript(
      client,
      base,
      async (done, total, partial) => {
        await saveClean(id, {
          status: 'processing',
          startedAt,
          updatedAt: now(),
          done,
          total,
          entries: partial,
        });
      },
      startLine,
    );
    await saveClean(id, { status: 'done', entries, generatedAt: now(), changed });
    await appendAudit('clean', `${id}: ${changed} baris`);
    return { ok: true, changed };
  } catch (e) {
    await clearClean(id); // drop the marker so the button is usable again
    throw e;
  }
}

// P0.1: the content script knows the *room* (the Meet/Teams link); which
// *session* that is depends on what is already stored, so the decision is
// made here — one implementation, shared with the tests, instead of a copy
// of the rule inside content.js.
async function handleResolveSession(raw: string): Promise<{ sessionId: string }> {
  const roomId = sanitizeRoomId(raw);
  if (!roomId) throw new Error(t('ext.err.invalidRoomId'));
  const { sessionId, resumed } = resolveSession(roomId, await loadMeetings(), Date.now());
  if (!resumed) await appendAudit('session.start', `${roomId} -> ${sessionId}`);
  return { sessionId };
}

// §32.1 W4: the gate review reads this device's audit ring as JSON. Local
// download only — the ring never leaves the device (no telemetry, unchanged).
// The per-device §32.1 snapshots (gateSummary for G1/G2, g3Rollup for G3)
// ride along so the review can read every demand signal straight from the
// file.
async function handleExportAudit(): Promise<{
  ok: true; count: number; json: string;
}> {
  const events = await loadAudit();
  // belt-and-suspenders: the onInstalled/onStartup listeners stamp T0 already,
  // but ensureReleaseT0 is idempotent, so a missed listener still self-heals.
  const t0 = await ensureReleaseT0(Date.now());
  const gate = gateSummary(events, Date.now(), t0);
  const g3 = g3Rollup(events, Date.now());
  return {
    ok: true,
    count: events.length,
    json: JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        ringMax: AUDIT_RING_MAX,
        count: events.length,
        gate: { ...gate, describe: describeGate(gate) },
        g3: { ...g3, describe: describeG3(g3) },
        events,
      },
      null,
      2,
    ),
  };
}

// §32.1 W1: whole-vault Obsidian export. Runs in the worker because the
// meeting library lives in chrome.storage (worker-owned), and the audit
// event must record the true number of exported meetings even if the
// dashboard tab dies mid-download.
async function handleExportObsidian(): Promise<{
  ok: true; count: number; base64: string; name: string;
}> {
  const [meetings, records] = await Promise.all([loadMeetings(), loadAnalyses()]);
  const files = obsidianVault(meetings, records);
  if (!files.length) throw new Error(t('ext.err.nothingToExport'));
  const blob = makeZip(files);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  await appendAudit(GATE_EVENT, `meetings=${files.length - 1}`); // minus README
  return {
    ok: true,
    count: files.length - 1,
    base64: btoa(binary),
    name: `companion-vault-${new Date().toISOString().slice(0, 10)}.zip`,
  };
}

// Native-messaging host registered by the desktop installer. Sending to it is
// best-effort: a missing / uninstalled host must never crash the worker or
// block capture, so failures resolve to an `ok:false` and the vault is rebuilt
// from the extension store as before.
const NATIVE_HOST = 'dev.suiflex.companion';

/** One audit line per worker lifetime, not one per meeting per sweep. */
let bridgeErrorLogged = false;

/** How many caption lines of a meeting the vault has already been given. */
const BRIDGE_SENT_KEY = (meetingId: string): string => `bridge:${meetingId}`;
const BRIDGE_SUMMARY_KEY = (meetingId: string): string => `bridge-summary:${meetingId}`;

function handleBridgeSend(
  batch: object,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  // lib is ES2022 (no Promise.withResolvers) and sendNativeMessage is
  // executor-callback-based, so the executor form is required here.
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, batch, (res) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message ?? 'native-host-error' });
      else resolve({ ok: true, data: res });
    });
  });
}

/** Delivers new captions and any summary version not yet confirmed by desktop. */
async function deliverToDesktop(
  meeting: Meeting,
  force = false,
  includeSummary = true,
  knownRecord?: AnalysisRecord | null,
): Promise<{ ok: boolean; error?: string }> {
  const key = BRIDGE_SENT_KEY(meeting.id);
  const summaryKey = BRIDGE_SUMMARY_KEY(meeting.id);
  const stored = await chrome.storage.local.get([key, summaryKey]);
  const sent = Number(stored[key] ?? 0);
  const record = includeSummary
    ? knownRecord === undefined
      ? await getAnalysis(meeting.id)
      : knownRecord
    : knownRecord ?? null;
  const completeRecord =
    includeSummary && record?.status === 'done' ? record : null;
  const deliveredVersion = deliveredSummaryVersion(stored[summaryKey]);
  const pendingSummaryMarker = isSummaryPending(stored[summaryKey]);
  if (
    completeRecord &&
    shouldBackfillDeliveredSummary(
      sent,
      meeting.entries.length,
      deliveredVersion,
      pendingSummaryMarker,
      force,
    )
  ) {
    await chrome.storage.local.set({ [summaryKey]: completeRecord.generatedAt });
    return { ok: true };
  }
  const summaryPending =
    !!completeRecord &&
    (pendingSummaryMarker || deliveredVersion !== completeRecord.generatedAt);
  if (
    !needsDesktopDelivery({
      force,
      sentEntries: sent,
      totalEntries: meeting.entries.length,
      summaryVersion: completeRecord?.generatedAt,
      deliveredSummaryVersion: deliveredVersion,
    })
  ) return { ok: true };
  const fromSent = force && sent >= meeting.entries.length ? 0 : sent;
  const replaceSummary = !!completeRecord && (force || summaryPending);
  const batch = toBridgeBatch(
    meeting,
    fromSent,
    completeRecord?.analysis ?? null,
    force || replaceSummary,
    completeRecord?.generatedAt,
  );
  if (force && sent >= meeting.entries.length) {
    batch.operationId = `${meeting.id}:manual-${Date.now()}`;
  }
  const res = await handleBridgeSend(batch);
  const error = nativeMessageError(res);
  if (error) {
    if (!bridgeErrorLogged) {
      bridgeErrorLogged = true;
      await appendAudit(
        'bridge.error',
        `[${classifyBridgeError(error)}] ${error}`,
      );
    }
    return { ok: false, error };
  }
  bridgeErrorLogged = false;
  const storageUpdate: Record<string, string | number> = { [key]: meeting.entries.length };
  if (!includeSummary) {
    storageUpdate[summaryKey] = summaryMarkerAfterTranscriptOnlyExport(
      stored[summaryKey],
      sent,
      meeting.entries.length,
      knownRecord?.status === 'done' ? knownRecord.generatedAt : undefined,
    );
  }
  if (completeRecord) storageUpdate[summaryKey] = completeRecord.generatedAt;
  await chrome.storage.local.set(storageUpdate);
  await appendAudit('bridge.send', `${meeting.id}: ${batch.entries.length} baris`);
  return { ok: true };
}

function nativeMessageError(
  response: { ok: boolean; error?: string; data?: unknown },
): string | undefined {
  if (!response.ok) return response.error ?? 'native-host-error';
  if (!response.data || typeof response.data !== 'object') return undefined;
  const reply = response.data as { status?: unknown; error?: unknown };
  if (reply.status !== 'error') return undefined;
  return typeof reply.error === 'string' ? reply.error : 'native-host-error';
}

async function deliverTranscriptToDesktop(id: string): Promise<{ ok: boolean; error?: string }> {
  const meeting = await loadMeetingForAI(id);
  if (!meeting) return { ok: false, error: t('ext.err.meetingNotFound') };
  if (!meeting.entries.length) return { ok: false, error: t('ext.err.emptyTranscription') };
  const record = await getAnalysis(id);
  return deliverToDesktop(meeting, true, false, record);
}

function isDocType(value: unknown): value is DocType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOC_META, value);
}

async function exportDocumentToDesktop(
  id: string,
  docType: DocType,
  generatedAt: string,
): Promise<{ ok: boolean; error?: string }> {
  const [meeting, documents, title] = await Promise.all([
    loadMeetingForAI(id),
    loadDocs(id),
    getTitle(id),
  ]);
  if (!meeting) return { ok: false, error: t('ext.err.meetingNotFound') };
  const document = documents[docType];
  if (!document?.content.trim()) return { ok: false, error: t('ext.docs.noOutput') };
  if (document.generatedAt !== generatedAt) {
    return { ok: false, error: t('ext.docs.documentChanged') };
  }
  const batch = toDocumentBridgeBatch(
    meeting,
    docType,
    title.trim() || roomIdOf(id),
    DOC_META[docType].label,
    document.content,
    document.generatedAt,
  );
  const response = await handleBridgeSend(batch);
  const error = nativeMessageError(response);
  if (error) {
    if (!bridgeErrorLogged) {
      bridgeErrorLogged = true;
      await appendAudit('bridge.error', `[${classifyBridgeError(error)}] ${error}`);
    }
    return { ok: false, error };
  }
  bridgeErrorLogged = false;
  await appendAudit('bridge.document.send', `${id}: ${docType}`);
  return { ok: true };
}


// The worker is its own context: the dashboard applying a language says
// nothing about the errors this file throws. Read it at startup and follow the
// same storage key the UI writes.
const applyStoredLang = (raw: unknown): void =>
  setLang(resolveLang(asLangPref(raw), self.navigator?.languages ?? []));

void chrome.storage.local
  .get('lang')
  .then(({ lang }) => applyStoredLang(lang))
  .catch(() => undefined);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lang) applyStoredLang(changes.lang.newValue);
});

function handleBridgeMessage(msg: Record<string, unknown>): Promise<unknown> | null {
  if (msg.type === 'bridge-send' && msg.batch && typeof msg.batch === 'object') {
    return handleBridgeSend(msg.batch as object);
  }
  if (msg.type === 'bridge-ping') {
    return handleBridgeSend({ type: 'ping' });
  }
  if (msg.type === 'bridge-deliver-meeting' && typeof msg.meetingId === 'string') {
    return loadMeetings().then((meetings) => {
      const meeting = meetings.find((item) => item.id === msg.meetingId);
      if (!meeting) return { ok: false, error: t('ext.err.meetingNotFound') };
      return deliverToDesktop(meeting, true);
    });
  }
  if (msg.type === 'bridge-deliver-transcript' && typeof msg.meetingId === 'string') {
    return deliverTranscriptToDesktop(msg.meetingId);
  }
  if (msg.type === 'bridge-export-document' && typeof msg.meetingId === 'string') {
    return isDocType(msg.docType) && typeof msg.generatedAt === 'string'
      ? exportDocumentToDesktop(msg.meetingId, msg.docType, msg.generatedAt)
      : Promise.resolve({ ok: false, error: t('ext.docs.invalidType') });
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'db' && typeof msg.op === 'string') {
    handleDb({ op: msg.op, args: msg.args })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
  if (msg?.type === 'export-obsidian') {
    handleExportObsidian()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
  const bridgeTask = msg && typeof msg === 'object' ? handleBridgeMessage(msg as Record<string, unknown>) : null;
  if (bridgeTask) {
    bridgeTask
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
  if (msg?.type === 'export-audit') {
    handleExportAudit()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
  if (msg?.type === 'global-ask' && typeof msg.question === 'string') {
    handleGlobalAsk(msg.question)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
  if (msg?.type === 'resolve-session' && typeof msg.roomId === 'string' && msg.roomId) {
    handleResolveSession(msg.roomId)
      .then(sendResponse)
      // a failed lookup must not lose the meeting: fall back to the room id
      .catch(() => sendResponse({ sessionId: sanitizeRoomId(msg.roomId) }));
    return true; // async response
  }
  if (msg?.type === 'meeting-started' && msg.meetingId) {
    void openDashboard(`meeting=${encodeURIComponent(msg.meetingId)}`);
    return;
  }
  if (msg?.type === 'meeting-left') {
    // heartbeat needs ~15s to go stale; sweep shortly after
    setTimeout(() => void sweep(), 20_000);
    chrome.alarms.create('sweep-once', { delayInMinutes: 0.5 });
    return;
  }
  if (msg?.type === 'regenerate' && msg.meetingId) {
    // Asking mid-meeting is allowed — waiting for the meeting to end is not
    // much use to someone who needs the minutes during it. The transcript so
    // far is what gets analysed, and the result is marked provisional so the
    // sweep still writes the real notes afterwards.
    void loadMeetingForAI(msg.meetingId)
      .then((m) => analyze(msg.meetingId, { force: true, provisional: !!m && isLive(m, Date.now()) }))
      .then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'ask' && msg.meetingId && typeof msg.question === 'string') {
    handleAsk(msg.meetingId, msg.question)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
  if (msg?.type === 'generate-doc' && msg.meetingId && msg.docType) {
    handleGenerateDoc(msg.meetingId, msg.docType as DocType, msg.templateId, msg.timelineIndices)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
  if (msg?.type === 'clean-transcript' && msg.meetingId) {
    handleCleanTranscript(msg.meetingId, !!msg.fromScratch)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
  if (msg?.type === 'generate-diagram' && msg.meetingId) {
    handleGenerateDiagram(msg.meetingId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // async response
  }
});
