import { useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { VaultNote } from '@meetcc/vault'
import { t } from '@meetcc/shared/i18n'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, type Option } from './Select'
import { useToast } from './toast'
import { exportNote, type ExportFormat } from './exportNote'

export function ExportModal({
  open,
  onClose,
  note,
  editor,
}: {
  open: boolean
  onClose: () => void
  note: VaultNote | null
  editor: Editor | null
}) {
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [includeMetadata, setIncludeMetadata] = useState(true)
  const [includeTitle, setIncludeTitle] = useState(true)
  const [exporting, setExporting] = useState(false)
  const toast = useToast()

  if (!note) return null

  const formatOptions: Option[] = [
    { value: 'markdown', label: t('desktop.export.formatMarkdown') },
    { value: 'html', label: t('desktop.export.formatHtml') },
    { value: 'pdf', label: t('desktop.export.formatPdf') },
  ]

  const handleExport = async () => {
    setExporting(true)
    try {
      const bodyHtml = editor ? editor.getHTML() : `<p>${note.body.replace(/\n\n/g, '</p><p>')}</p>`
      const saved = await exportNote(note, bodyHtml, {
        format,
        includeMetadata,
        includeTitle,
      })
      if (saved === null) return // dialog cancelled: stay open, choice intact
      toast('success', t('desktop.export.success', { filename: saved.split(/[\\/]/).pop() ?? saved }))
      onClose()
    } catch (e) {
      toast('error', t('desktop.export.failed', { error: (e as Error).message }))
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton
        className="top-[20vh] w-[380px] max-w-[92vw] translate-y-0 gap-4 rounded-xl border bg-popover p-5 text-popover-foreground shadow-xl"
      >
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{t('desktop.export.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('desktop.export.format')}</span>
            <Select
              label={t('desktop.export.format')}
              value={format}
              options={formatOptions}
              onChange={(val) => setFormat(val as ExportFormat)}
            />
          </div>

          <div className="flex flex-col gap-2.5 pt-1">
            <label className="flex cursor-pointer items-center justify-between gap-2 text-[13px]">
              <span className="text-foreground">{t('desktop.export.includeProperties')}</span>
              <input
                type="checkbox"
                checked={includeMetadata}
                onChange={(e) => setIncludeMetadata(e.target.checked)}
                className="size-4 rounded-xs border-border text-primary accent-primary"
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between gap-2 text-[13px]">
              <span className="text-foreground">{t('desktop.export.includeTitle')}</span>
              <input
                type="checkbox"
                checked={includeTitle}
                onChange={(e) => setIncludeTitle(e.target.checked)}
                className="size-4 rounded-xs border-border text-primary accent-primary"
              />
            </label>
          </div>
        </div>

        <DialogFooter className="mt-2 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={exporting}>
            {t('desktop.export.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={() => void handleExport()} disabled={exporting}>
            {t('desktop.export.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
