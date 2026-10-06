// An image node in the editor, shown for what its file is: a picture, a video
// or audio player, or a card for any other file. A vault path is read through
// IPC into a blob URL — the WebView has no file access of its own — while a
// web or data URL is used as it is. Clicking a picture or a PDF opens it in a
// viewer; players keep the click for their own controls and get a button.
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { t } from '@meetcc/shared/i18n'
import { Expand, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/Tip'
import { useVaultBlob } from '../vaultBlob'
import { isVaultPath, mediaKind } from './media'
import { useToast } from '../toast'

const isPdf = (src: string): boolean => /\.pdf$/i.test(src.split(/[?#]/)[0])

export function MediaView({ node, selected }: ReactNodeViewProps) {
  const src = String(node.attrs.src ?? '')
  const alt = String(node.attrs.alt ?? '')
  const kind = mediaKind(src)
  const pdf = kind === 'file' && isPdf(src)
  const local = isVaultPath(src)
  const { url, error } = useVaultBlob(local && (kind !== 'file' || pdf) ? src : undefined)
  const shown = local ? url : src
  const toast = useToast()
  const [viewing, setViewing] = useState(false)
  const name = alt || src.split('/').pop() || src
  const reveal = () => void invoke('reveal_vault_file', { rel: src }).catch((e) => toast('error', String(e)))

  return (
    <NodeViewWrapper
      className={cn('group relative my-3 w-fit max-w-full rounded-md', selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background')}
      data-drag-handle
    >
      {kind === 'image' && shown && (
        <img
          src={shown}
          alt={alt}
          className="block max-w-full cursor-zoom-in rounded-md"
          draggable={false}
          onClick={() => setViewing(true)}
        />
      )}
      {kind === 'video' && shown && <video src={shown} controls className="block max-w-full rounded-md" />}
      {kind === 'audio' && shown && <audio src={shown} controls className="block w-[420px] max-w-full" />}
      {(kind === 'video' || kind === 'audio') && shown && (
        <Tip label={t('desktop.media.open')}>
          <button
            type="button"
            aria-label={t('desktop.media.open')}
            className="absolute right-2 top-2 grid size-7 place-items-center rounded-md bg-background/80 text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => setViewing(true)}
          >
            <Expand className="size-3.5" />
          </button>
        </Tip>
      )}
      {kind === 'file' && (
        <button
          type="button"
          className="flex items-center gap-2 rounded-md border bg-sunken px-3 py-2 text-left text-[13px] hover:bg-muted"
          onClick={() => (pdf && shown ? setViewing(true) : reveal())}
        >
          <FileText className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{name}</span>
          <span className="text-xs text-muted-foreground">{pdf ? t('desktop.media.open') : t('desktop.file.reveal')}</span>
        </button>
      )}
      {local && (kind !== 'file' || pdf) && !shown && (
        <p className="m-0 text-xs text-muted-foreground">{error ? t('desktop.media.missing', { path: src }) : '…'}</p>
      )}

      <Dialog open={viewing} onOpenChange={setViewing}>
        <DialogContent className="flex max-h-[92vh] w-auto max-w-[92vw] flex-col items-center gap-3 border-0 bg-popover p-3 sm:max-w-[92vw]">
          <DialogTitle className="max-w-full truncate text-sm font-medium">{name}</DialogTitle>
          {shown && kind === 'image' && (
            <img src={shown} alt={alt} className="max-h-[80vh] max-w-full rounded-md object-contain" />
          )}
          {shown && kind === 'video' && (
            <video src={shown} controls autoPlay className="max-h-[80vh] max-w-full rounded-md" />
          )}
          {shown && kind === 'audio' && <audio src={shown} controls autoPlay className="w-[480px] max-w-full" />}
          {shown && pdf && <iframe src={shown} title={name} className="h-[80vh] w-[80vw] rounded-md border-0 bg-sunken" />}
        </DialogContent>
      </Dialog>
    </NodeViewWrapper>
  )
}
