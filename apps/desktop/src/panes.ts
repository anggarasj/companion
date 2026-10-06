// Which of the three side panes are open: the vault list, the file tree and
// the AI panel. Remembered per install, like the theme.
export interface Panes {
  vaults: boolean
  files: boolean
  ai: boolean
}

const KEY = 'companion:panes'
const DEFAULT: Panes = { vaults: true, files: true, ai: false }

export function loadPanes(): Panes {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof Panes, unknown>>
    return {
      vaults: typeof raw.vaults === 'boolean' ? raw.vaults : DEFAULT.vaults,
      files: typeof raw.files === 'boolean' ? raw.files : DEFAULT.files,
      ai: typeof raw.ai === 'boolean' ? raw.ai : DEFAULT.ai,
    }
  } catch {
    return DEFAULT
  }
}

export function savePanes(panes: Panes): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(panes))
  } catch {
    /* still applies for this session */
  }
}
