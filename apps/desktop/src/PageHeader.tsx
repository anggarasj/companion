// Cover and icon above the title, the way Notion does it: nothing shows until
// the pointer is over the header, then "Add icon" / "Add cover".
//
// Both live in the note's frontmatter (`icon`, `cover`), so they are part of
// the .md file. An icon is an emoji or a vault-relative image; a cover is a
// vault-relative image. Uploaded images are copied into the vault's `.assets/`
// folder, so the vault stays self-contained when it is moved or synced.
import { useEffect, useRef, useState } from 'react'
import { useVaultBlob } from './vaultBlob'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import type { VaultNote } from '@meetcc/vault'
import { t } from '@meetcc/shared/i18n'
import { ImagePlus, ImageUp, Shuffle, Smile, Trash2, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const PAGE_BTN = 'h-7 px-2 text-[13px] font-normal text-muted-foreground'
const ON_COVER = 'h-7 bg-black/55 px-2 text-[13px] font-normal text-white hover:bg-black/70 hover:text-white'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
export const isImagePath = (v: string | undefined): boolean => Boolean(v && /\.(png|jpe?g|gif|webp|svg)$/i.test(v))

/** The icon picker's emoji, space-separated, in display order. */
const EMOJI = (
  '📄 📝 📌 📎 📚 📖 🗂️ 📁 🗒️ 📋 ✅ ☑️ 🎯 🚀 💡 🔥 ⭐ ✨ ⚡ 🧭 🛠️ ⚙️ 🔧 🧪 🧩 🔒 🔑 🐛 📦 🧱 ' +
  '📊 📈 💰 🧾 📅 ⏰ 🗓️ 🤝 💬 📣 🏗️ 🏢 🌐 🗺️ 🎨 🎵 🌱 🍀 ☕ ❤️'
).split(' ')

/** Ask for an image file and copy it into `.assets/`; resolves to its vault path. */
async function importImage(kind: 'cover' | 'icon'): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: t('desktop.page.images'), extensions: IMAGE_EXTS }],
  })
  if (typeof picked !== 'string') return null
  const ext = picked.split('.').pop()?.toLowerCase() ?? 'png'
  const rel = `.assets/${kind}-${Date.now().toString(36)}.${ext}`
  await invoke('import_vault_asset', { src: picked, rel })
  return rel
}

export function PageHeader({
  note,
  onChange,
  onError,
}: {
  note: VaultNote
  onChange: (patch: Partial<VaultNote>) => void
  onError: (message: string) => void
}) {
  const [picker, setPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const cover = useVaultBlob(isImagePath(note.cover) ? note.cover : undefined).url
  const iconImage = useVaultBlob(isImagePath(note.icon) ? note.icon : undefined).url

  useEffect(() => {
    if (!picker) return
    const close = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPicker(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [picker])

  const upload = (kind: 'cover' | 'icon') =>
    void importImage(kind)
      .then((rel) => {
        if (rel) onChange(kind === 'cover' ? { cover: rel } : { icon: rel })
        setPicker(false)
      })
      .catch((e) => onError(String(e)))

  const hasIcon = Boolean(note.icon)
  return (
    // The add buttons stay hidden until the pointer is over the header, so an
    // untouched page is just its title.
    <div className="group/head relative mb-1 max-w-none!">
      {note.cover && (
        <div
          className="group/cover relative -mx-10 -mt-7 h-[200px] bg-muted bg-cover bg-center bg-no-repeat"
          style={cover ? { backgroundImage: `url("${cover}")` } : undefined}
        >
          <div className="absolute bottom-3 right-4 hidden gap-1.5 group-hover/cover:flex">
            <Button type="button" variant="ghost" size="sm" className={ON_COVER} onClick={() => upload('cover')}>
              <ImageUp />
              {t('desktop.page.changeCover')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className={ON_COVER} onClick={() => onChange({ cover: undefined })}>
              <Trash2 />
              {t('desktop.page.removeCover')}
            </Button>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-[780px]">
        {hasIcon && (
          <div className="relative inline-block" ref={pickerRef}>
            <button
              type="button"
              className={cn(
                'mb-1 mt-2 grid size-[78px] place-items-center rounded-lg text-[64px] leading-none hover:bg-muted',
                note.cover && '-mt-10',
              )}
              aria-label={t('desktop.page.changeIcon')}
              onClick={() => setPicker((p) => !p)}
            >
              {isImagePath(note.icon) ? iconImage ? <img className="size-[72px] rounded-md object-cover" src={iconImage} alt="" /> : null : note.icon}
            </button>
            {picker && <IconPicker onPick={(icon) => { onChange({ icon }); setPicker(false) }} onUpload={() => upload('icon')} onRemove={() => { onChange({ icon: undefined }); setPicker(false) }} />}
          </div>
        )}

        <div className="flex min-h-7 gap-1 pt-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/head:opacity-100">
          {!hasIcon && (
            <div className="relative inline-block" ref={pickerRef}>
              <Button type="button" variant="ghost" size="sm" className={PAGE_BTN} onClick={() => setPicker((p) => !p)}>
                <Smile />
                {t('desktop.page.addIcon')}
              </Button>
              {picker && <IconPicker onPick={(icon) => { onChange({ icon }); setPicker(false) }} onUpload={() => upload('icon')} />}
            </div>
          )}
          {!note.cover && (
            <Button type="button" variant="ghost" size="sm" className={PAGE_BTN} onClick={() => upload('cover')}>
              <ImagePlus />
              {t('desktop.page.addCover')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function IconPicker({
  onPick,
  onUpload,
  onRemove,
}: {
  onPick: (emoji: string) => void
  onUpload: () => void
  onRemove?: () => void
}) {
  return (
    <div
      className="absolute left-0 top-[calc(100%+4px)] z-30 w-[336px] rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
      role="dialog"
      aria-label={t('desktop.page.changeIcon')}
    >
      <div className="mb-1.5 flex gap-1">
        <Button type="button" variant="ghost" size="sm" className={PAGE_BTN} onClick={() => onPick(EMOJI[Math.floor(Math.random() * EMOJI.length)])}>
          <Shuffle />
          {t('desktop.page.random')}
        </Button>
        <Button type="button" variant="ghost" size="sm" className={PAGE_BTN} onClick={onUpload}>
          <Upload />
          {t('desktop.page.upload')}
        </Button>
        {onRemove && (
          <Button type="button" variant="ghost" size="sm" className={PAGE_BTN} onClick={onRemove}>
            <Trash2 />
            {t('desktop.page.removeIcon')}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-10 gap-0.5">
        {EMOJI.map((e) => (
          <button key={e} type="button" className="h-[30px] rounded-[5px] text-[19px] hover:bg-muted" onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}
