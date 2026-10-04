// The desktop's own provider settings store.
//
// It cannot reuse `loadSettings`/`saveSettings` from @meetcc/shared: those are
// `chrome.storage.local` from top to bottom, and there is no `chrome` in a
// Tauri window. Only the types and `switchProvider` are portable, so they are
// imported by deep path — the barrel pulls in the chrome-only modules.
//
// The split between the two halves is on purpose. Everything ordinary is a
// JSON file; the API key and the OAuth tokens go to the OS keychain, because
// the extension's approach (encrypt, then store the key beside the ciphertext)
// is obfuscation by its own admission and a desktop has a real keychain.
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_SETTINGS, type Settings } from '@meetcc/shared/types'
import { createClient, resolveConfig, validateSettings, type AIClient, type Effort } from '@meetcc/ai'

/** Keychain entry names. Two, so revoking a key leaves a sign-in alone. */
const API_KEY = 'apiKey'
const OAUTH = 'oauth'

/** Keys never written to the JSON file. */
type StoredSettings = Omit<Settings, 'apiKey' | 'oauth'>

const secret = async (name: string): Promise<string> => {
  try {
    return await invoke<string>('load_secret', { name })
  } catch {
    // A locked or denied keychain leaves the rest of the settings usable; the
    // field simply comes back empty and the user is asked for it again.
    return ''
  }
}

export async function loadAiSettings(): Promise<Settings> {
  let stored: Partial<StoredSettings> = {}
  try {
    const raw = await invoke<string>('load_ai_settings')
    if (raw) stored = JSON.parse(raw) as Partial<StoredSettings>
  } catch {
    // A first launch has no file, and a file someone hand-edited into invalid
    // JSON must not produce a dead settings screen — defaults are the better
    // answer either way.
  }
  const [apiKey, oauthRaw] = await Promise.all([secret(API_KEY), secret(OAUTH)])
  let oauth = DEFAULT_SETTINGS.oauth
  try {
    if (oauthRaw) oauth = JSON.parse(oauthRaw) as Settings['oauth']
  } catch {
    /* a token blob that will not parse is a sign-in to redo, not a crash */
  }
  return { ...DEFAULT_SETTINGS, ...stored, apiKey, oauth }
}

export async function saveAiSettings(settings: Settings): Promise<void> {
  const { apiKey, oauth, ...rest } = settings
  await invoke('save_ai_settings', { json: JSON.stringify(rest, null, 2) })
  await invoke('save_secret', { name: API_KEY, value: apiKey })
  // An empty value deletes the entry on the Rust side, so signing out actually
  // removes the tokens rather than leaving them behind the UI that hid them.
  const signedIn = Boolean(oauth?.accessToken || oauth?.refreshToken)
  await invoke('save_secret', { name: OAUTH, value: signedIn ? JSON.stringify(oauth) : '' })
}

/**
 * The model and effort picked in the AI panel. A per-install preference, not a
 * provider setting: it overrides the model for editor AI without touching
 * what Settings saved (the meeting pipeline keeps using that), and an empty
 * model means "whatever Settings says".
 */
export type EffortPref = 'auto' | Effort
export interface SessionAI {
  model: string
  effort: EffortPref
}
const SESSION_KEY = 'companion:aiSession'

export function loadSessionAI(): SessionAI {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}') as Partial<SessionAI>
    const effort = ['low', 'medium', 'high'].includes(raw.effort as string) ? (raw.effort as Effort) : 'auto'
    return { model: typeof raw.model === 'string' ? raw.model : '', effort }
  } catch {
    return { model: '', effort: 'auto' }
  }
}

export function saveSessionAI(prefs: SessionAI): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(prefs))
  } catch {
    /* still applies until the window closes */
  }
}

/** Settings as editor AI sees them: the saved provider, the panel's model. */
export async function editorAiSettings(): Promise<Settings> {
  const settings = await loadAiSettings()
  const { model } = loadSessionAI()
  return model ? { ...settings, model } : settings
}

/**
 * The client for whichever provider the user configured, or an Error saying
 * what is missing. Read per request, so a change in Settings or in the panel's
 * model and effort pickers applies to the next request without a restart.
 */
export async function configuredClient(): Promise<AIClient> {
  const settings = await editorAiSettings()
  const problem = validateSettings(settings)
  if (problem) throw new Error(problem)
  const client = createClient(resolveConfig(settings))
  const { effort } = loadSessionAI()
  if (effort === 'auto') return client
  return { provider: client.provider, complete: (req) => client.complete({ effort, ...req }) }
}
