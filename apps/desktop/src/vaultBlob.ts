// A vault image or PDF as an object URL the WebView can display. The bytes come
// over IPC (`read_vault_bytes`): the WebView has no file access of its own.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// WebKit plays a blob only when it knows the media type; images sniff fine without one.
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
}

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
