// A `.excalidraw` vault file, drawn and saved in place. The file is
// Excalidraw's own JSON, so it opens unchanged in excalidraw.com or Obsidian's
// Excalidraw plugin. Reads and writes go through the same vault IPC as notes;
// nothing about a board lives in Rust.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { getLang } from '@meetcc/shared/i18n'
import { parseBoard, type Board } from './board'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}
// Fonts are bundled next to the app by the vite plugin; the CDN default is
// unreachable under the CSP.
window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'

const SAVE_DELAY_MS = 500

export function Whiteboard({ rel, onError }: { rel: string; onError: (message: string) => void }) {
  const [scene, setScene] = useState<Board | null>(null)
  // What is on disk, as Excalidraw serializes it; null until its first onChange.
  const saved = useRef<string | null>(null)
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const flush = () => {
    clearTimeout(timer.current)
    const content = pending.current
    if (content === null) return
    pending.current = null
    invoke('write_vault_file', { rel, content })
      .then(() => (saved.current = content))
      .catch((e) => onError(String(e)))
  }

  useEffect(() => {
    let alive = true
    invoke<string>('read_vault_file', { rel })
      .then((text) => {
        if (!alive) return
        setScene(parseBoard(text))
      })
      .catch((e) => alive && onError(String(e)))
    return () => {
      alive = false
      flush() // switching away must not drop the last stroke
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per file
  }, [rel])

  if (!scene) return null
  return (
    <div className="relative min-h-0 flex-1">
      <Excalidraw
        initialData={{ ...scene, scrollToContent: true }}
        theme={document.body.dataset.theme === 'light' ? 'light' : 'dark'}
        langCode={getLang() === 'id' ? 'id-ID' : 'en'}
        onChange={(elements, appState, files) => {
          // onChange also fires for selection and pointer moves; write only
          // when the persisted scene actually differs.
          const content = serializeAsJSON(elements, appState, files, 'local')
          // The first call is the file as loaded, normalized by Excalidraw.
          // Taking it as the baseline keeps merely opening a board from
          // rewriting it.
          if (saved.current === null) {
            saved.current = content
            return
          }
          if (content === saved.current || content === pending.current) return
          pending.current = content
          clearTimeout(timer.current)
          timer.current = setTimeout(flush, SAVE_DELAY_MS)
        }}
      />
    </div>
  )
}
