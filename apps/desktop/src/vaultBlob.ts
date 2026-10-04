// A vault image or PDF as an object URL the WebView can display. The bytes come
// over IPC (`read_vault_bytes`): the WebView has no file access of its own.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

const TYPES: Record<string, string> = { pdf: 'application/pdf', svg: 'image/svg+xml' }

/** Object URL for `rel`, revoked when it changes or unmounts; null until loaded. */
export function useVaultBlob(rel: string | undefined): { url: string | null; error: string | null } {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null })
  useEffect(() => {
    setState({ url: null, error: null })
    if (!rel) return
    let alive = true
    let made: string | null = null
    invoke<ArrayBuffer>('read_vault_bytes', { rel })
      .then((bytes) => {
        if (!alive) return
        const type = TYPES[rel.split('.').pop()?.toLowerCase() ?? '']
        made = URL.createObjectURL(new Blob([bytes], type ? { type } : undefined))
        setState({ url: made, error: null })
      })
      .catch((e) => alive && setState({ url: null, error: String(e) }))
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [rel])
  return state
}
