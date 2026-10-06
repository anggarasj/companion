// Media in a note: pictures, video, audio and any other file, the way Notion
// takes them — pasted, dropped, or picked from "/media". Every one is written
// into the vault's `.assets/` and stored in the .md as `![name](.assets/…)`,
// the image syntax the editor already round-trips; the view (MediaView.tsx)
// decides from the extension whether that is a picture, a player or a file.
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Fragment, Slice } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

export type MediaKind = 'image' | 'video' | 'audio' | 'file'

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
const VIDEO = /\.(mp4|mov|m4v|webm)$/i
const AUDIO = /\.(mp3|m4a|wav|ogg)$/i

/** What a `src` shows as, from its extension. */
export function mediaKind(src: string): MediaKind {
  const path = src.split(/[?#]/)[0]
  if (IMAGE.test(path)) return 'image'
  if (VIDEO.test(path)) return 'video'
  if (AUDIO.test(path)) return 'audio'
  return 'file'
}

/** A path inside the vault, as opposed to a web, data or blob URL. */
export const isVaultPath = (src: string): boolean => !/^[a-z][a-z0-9+.-]*:/i.test(src)

/** A clipboard picture can arrive without a usable name; its type still says what it is. */
const EXT_OF_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
}

/**
 * Where an attachment named `name` is written: `.assets/<slug>-<id>.<ext>`.
 * The slug is ASCII with no spaces, so the path survives markdown link syntax
 * and the IPC header it travels in; `id` keeps two "image.png" pastes apart.
 */
export function assetPath(name: string, type: string, id: string): string {
  const dot = name.lastIndexOf('.')
  const fromName = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  const ext = fromName || EXT_OF_TYPE[type] || 'bin'
  const stem = (dot > 0 ? name.slice(0, dot) : name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `.assets/${stem || 'file'}-${id}.${ext}`
}

const newId = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

export interface Attachment {
  src: string
  alt: string
}

/** Write a pasted or dropped file into the vault; its bytes go to Rust as the raw IPC body. */
export async function saveFile(file: File): Promise<Attachment> {
  const src = assetPath(file.name, file.type, newId())
  const bytes = new Uint8Array(await file.arrayBuffer())
  await invoke('write_vault_bytes', bytes, { headers: { 'x-vault-rel': src } })
  return { src, alt: file.name.replace(/\.[^.]+$/, '') || 'file' }
}

/** Ask for files and copy each into the vault; empty when the dialog was cancelled. */
export async function pickFiles(): Promise<Attachment[]> {
  const picked = await openDialog({ multiple: true })
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked]
  const out: Attachment[] = []
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() ?? 'file'
    const src = assetPath(name, '', newId())
    await invoke('import_vault_asset', { src: path, rel: src })
    out.push({ src, alt: name.replace(/\.[^.]+$/, '') || 'file' })
  }
  return out
}

/** Put attachments into the document at `pos`, or over the selection, one after another. */
export function insertMedia(view: EditorView, items: Attachment[], pos?: number): void {
  const image = view.state.schema.nodes.image
  if (!image || !items.length) return
  const tr = view.state.tr
  // Through the selection rather than tr.insert: a drop lands mid-paragraph,
  // and replacing the selection splits it to make room for blocks. All in one
  // slice: inserted one by one, each would select itself and be replaced by the next.
  if (pos !== undefined) tr.setSelection(TextSelection.near(tr.doc.resolve(pos)))
  tr.replaceSelection(new Slice(Fragment.from(items.map((a) => image.create({ src: a.src, alt: a.alt }))), 0, 0))
  view.dispatch(tr.scrollIntoView())
}

/** The web address of a clicked link, or null when the click was not on one. */
export function externalHref(target: EventTarget | null): string | null {
  const link = target instanceof Element ? target.closest('a[href]') : null
  const href = link?.getAttribute('href') ?? ''
  return /^https?:\/\//i.test(href) ? href : null
}

/**
 * The files a paste means to attach. Rich text copied from Word, Excel or
 * Pages also puts a picture of itself on the clipboard, beside its HTML; the
 * text is what was meant, so HTML that is more than a lone <img> wins. A
 * screenshot or a file copied in Finder carries no HTML and attaches.
 * ponytail: heuristic over clipboard flavours; per-app rules if one misfires.
 */
export function pastedFiles(data: DataTransfer | null | undefined): File[] {
  const files = data ? Array.from(data.files) : []
  if (!files.length || !data) return []
  const html = data.getData('text/html')
  if (html && !/^\s*(<meta[^>]*>\s*)?<img\b[^>]*>\s*$/i.test(html)) return []
  return files
}

/**
 * Paste or drop: save every file, then insert them. Returns false when there
 * are no files, so ProseMirror's own handling (text, HTML) runs as before.
 */
export function attachFiles(
  view: EditorView,
  files: FileList | File[] | null | undefined,
  onError: (message: string) => void,
  pos?: number,
): boolean {
  const list = files ? Array.from(files) : []
  if (!list.length) return false
  // One at a time: each file is read whole into memory before it is sent, and
  // a drop of twenty videos at once must not hold all of them together.
  void (async () => {
    const items: Attachment[] = []
    for (const file of list) items.push(await saveFile(file))
    return items
  })()
    .then((items) => insertMedia(view, items, pos))
    .catch((e) => onError(String(e)))
  return true
}
