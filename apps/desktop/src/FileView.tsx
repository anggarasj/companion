// A vault file that is not a note. PDFs open in the WebView's own viewer;
// anything else says plainly that it cannot be shown here, with a way to find
// it in Finder — never a blank pane that looks like a bug.
import { invoke } from '@tauri-apps/api/core'
import { t } from '@meetcc/shared/i18n'
import { FolderSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVaultBlob } from './vaultBlob'

export const isPdf = (rel: string): boolean => /\.pdf$/i.test(rel)
export const isImageFile = (rel: string): boolean => /\.(png|jpe?g|gif|webp|svg)$/i.test(rel)

export function FileView({ rel, onError }: { rel: string; onError: (message: string) => void }) {
  const viewable = isPdf(rel) || isImageFile(rel)
  const { url, error } = useVaultBlob(viewable ? rel : undefined)
  const name = rel.split('/').pop() ?? rel
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : ''
  const reveal = () => void invoke('reveal_vault_file', { rel }).catch((e) => onError(String(e)))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2.5 border-b px-3.5 py-2">
        <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
        <Button type="button" variant="outline" size="sm" onClick={reveal}>
          <FolderSearch />
          {t('desktop.file.reveal')}
        </Button>
      </div>
      {viewable && url && isPdf(rel) && <iframe className="w-full flex-1 border-0 bg-sunken" src={url} title={name} />}
      {viewable && url && !isPdf(rel) && <img className="m-auto max-h-full max-w-full object-contain p-5" src={url} alt={name} />}
      {viewable && error && <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">{error}</p>}
      {!viewable && (
        <div className="m-auto max-w-[440px] p-6 text-center">
          <p className="mb-1.5 mt-0 text-base font-semibold">{t('desktop.file.unsupported', { ext: ext || name })}</p>
          <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">{t('desktop.file.unsupportedHint')}</p>
        </div>
      )}
    </div>
  )
}
