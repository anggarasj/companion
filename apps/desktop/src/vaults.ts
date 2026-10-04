// The vaults the sidebar lists, Zed-style: any number of folders, each with a
// name of its own. The name is a label, not the folder name — "Work" can point
// at ~/Documents/notes-2026 — and a vault can be hidden from the list without
// being forgotten. Only one is open at a time; switching goes through the same
// `set_vault_root` the Settings window uses.
//
// A per-install list in localStorage: it is about this machine's folders, and
// nothing in a vault should have to know about the others.

export interface VaultEntry {
  id: string
  name: string
  path: string
  hidden: boolean
}

const KEY = 'companion:vaults'

const clean = (p: string): string => p.replace(/\/+$/, '') || '/'
export const folderName = (p: string): string => clean(p).split('/').pop() || p

export function loadVaults(): VaultEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (v): v is VaultEntry => typeof v?.id === 'string' && typeof v?.path === 'string' && typeof v?.name === 'string',
    ).map((v) => ({ ...v, hidden: Boolean(v.hidden) }))
  } catch {
    return []
  }
}

export function saveVaults(list: VaultEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* the list still holds for this session */
  }
}

/** Add `path` unless it is already listed; a re-added hidden vault reappears. */
export function addVault(list: VaultEntry[], path: string, name = folderName(path)): VaultEntry[] {
  const p = clean(path)
  if (list.some((v) => clean(v.path) === p)) {
    return list.map((v) => (clean(v.path) === p ? { ...v, hidden: false } : v))
  }
  return [...list, { id: `v${Date.now().toString(36)}${list.length}`, name: name.trim() || folderName(p), path: p, hidden: false }]
}

/** The open vault is always listed and never hidden, whatever the list says. */
export function withCurrent(list: VaultEntry[], root: string): VaultEntry[] {
  const p = clean(root)
  const found = list.find((v) => clean(v.path) === p)
  if (!found) return addVault(list, p)
  return found.hidden ? list.map((v) => (v === found ? { ...v, hidden: false } : v)) : list
}

export const renameVault = (list: VaultEntry[], id: string, name: string): VaultEntry[] =>
  name.trim() ? list.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)) : list

export const setHidden = (list: VaultEntry[], id: string, hidden: boolean): VaultEntry[] =>
  list.map((v) => (v.id === id ? { ...v, hidden } : v))

/** Forget a vault. The folder and its notes are not touched. */
export const removeVault = (list: VaultEntry[], id: string): VaultEntry[] => list.filter((v) => v.id !== id)

export const isCurrent = (v: VaultEntry, root: string | undefined): boolean =>
  Boolean(root) && clean(v.path) === clean(root!)
