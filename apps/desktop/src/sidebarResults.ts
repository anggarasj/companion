interface SearchableNote {
  platform?: string
  tags?: readonly string[]
}

export function isIncomingMeeting(note: SearchableNote): boolean {
  return Boolean(note.platform && note.platform !== 'manual' && !note.tags?.includes('dokumen'))
}

/** Search results belong to the active tab; generated documents aren't meetings. */
export function inboxSearchResults<T extends SearchableNote>(
  query: string,
  incoming: readonly T[],
  matches: readonly T[],
): readonly T[] {
  return query.trim() ? matches.filter(isIncomingMeeting) : incoming
}

interface VaultRow {
  sessionKey: string
  platform: string
  source?: string
}

/**
 * The Notes tab shows an edited copy in place of the meeting it came from, so
 * editing a meeting does not look like it spawned a second note. The meeting
 * stays on disk as the archive and stays listed under Incoming meetings.
 */
export function hideCopiedOriginals<T extends VaultRow>(list: readonly T[], all: readonly VaultRow[]): T[] {
  const copied = new Set<string>()
  for (const n of all) if (n.source) copied.add(n.source)
  return list.filter((n) => !n.platform || n.platform === 'manual' || !copied.has(n.sessionKey))
}
