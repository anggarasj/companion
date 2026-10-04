// Building the payload the desktop vault expects out of a stored meeting.
//
// Pure on purpose: no chrome.*, no storage. What to send and when is the
// service worker's business (see `deliverToDesktop` in background.ts); this
// only decides what one delivery looks like.
import { toMarkdown } from '@meetcc/exporters/markdown';
import { participants, roomIdOf, startedAt, type Analysis, type DocType, type Meeting } from '@meetcc/shared';
import type { BridgeBatch } from '@meetcc/vault';

/**
 * One delivery for `meeting`, carrying only the captions after `sent`.
 *
 * `operationId` is derived from the caption slice and summary version. A
 * transcript-only export and its later summarized delivery must not dedupe
 * each other; retries of either version remain idempotent.
 */
export function toBridgeBatch(
  meeting: Meeting,
  sent: number,
  analysis?: Analysis | null,
  /** A manual export: carry the current summary even after the first delivery. */
  resend = false,
  summaryVersion?: string,
): BridgeBatch {
  const roomId = roomIdOf(meeting.id);
  const from = Math.max(0, sent);
  return {
    operationId: `${meeting.id}:${sent}-${meeting.entries.length}:${analysis ? `summary:${summaryVersion ?? ''}` : 'transcript'}`,
    roomId,
    // same rule the meeting store uses to label a room
    platform: roomId.startsWith('tms-') ? 'teams' : roomId.startsWith('zm-') ? 'zoom' : 'google-meet',
    startedAt: startedAt(meeting) ?? '',
    participants: participants(meeting),
    entries: meeting.entries
      .slice(from)
      .map((e) => ({ speaker: e.speaker, text: e.text, time: e.time })),
    // Only the first delivery carries a body on its own; a sweep must not
    // overwrite the note. A manual export asks for the body to be replaced.
    ...((from === 0 || resend) && analysis ? { markdown: toMarkdown(meeting, analysis) } : {}),
    ...(resend && analysis ? { replaceBody: true } : {}),
    ...(resend && from === 0 ? { snapshot: true } : {}),
    ...(meeting.tags?.length ? { tags: meeting.tags } : {}),
  };
}

/** A generated document is a separate delivered note, never a replacement for
 * the meeting note. Its real meeting platform makes desktop saves copy rather
 * than overwrite the delivered source. Re-exporting a version is idempotent. */
export function toDocumentBridgeBatch(
  meeting: Meeting,
  docType: DocType,
  title: string,
  label: string,
  markdown: string,
  generatedAt: string,
): BridgeBatch {
  const meetingRoomId = roomIdOf(meeting.id);
  const roomId = `${meetingRoomId}-document-${docType}`;
  const start = startedAt(meeting) ?? generatedAt;
  return {
    operationId: `${meeting.id}:document:${docType}:${generatedAt}`,
    sessionKey: `${roomId}#${start}`,
    roomId,
    platform: meetingRoomId.startsWith('tms-') ? 'teams' : meetingRoomId.startsWith('zm-') ? 'zoom' : 'google-meet',
    startedAt: start,
    participants: participants(meeting),
    entries: [],
    markdown: `# ${title} — ${label}\n\n${markdown}`,
    replaceBody: true,
    snapshot: true,
    includeTranscript: false,
    tags: [...(meeting.tags ?? []), 'dokumen', docType],
  };
}
