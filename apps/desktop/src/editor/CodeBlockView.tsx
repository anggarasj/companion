// Code blocks in the editor. Every block is still a plain fenced block in the
// .md file; only the view differs. A ```mermaid block shows its diagram, with
// the source one click away and a live preview while it is edited.
import { useEffect, useState } from 'react'
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { t } from '@meetcc/shared/i18n'
import { Check, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { renderMermaid } from './mermaid'

/** Debounce for the live preview while the source is being typed. */
const PREVIEW_DELAY_MS = 400

export function CodeBlockView({ node }: ReactNodeViewProps) {
  const language = String(node.attrs.language ?? '')
  const isMermaid = language.toLowerCase() === 'mermaid'
  const source = node.textContent
  const [editing, setEditing] = useState(false)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isMermaid) return
    if (!source.trim()) {
      setSvg(null)
      setError(null)
      return
    }
    let alive = true
    const timer = setTimeout(
      () => {
        renderMermaid(source)
          .then((out) => {
            if (!alive) return
            setSvg(out)
            setError(null)
          })
          .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      },
      svg ? PREVIEW_DELAY_MS : 0,
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // svg only decides whether the first render waits; it must not re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMermaid, source])

  if (!isMermaid) {
    return (
      <NodeViewWrapper as="pre">
        <NodeViewContent<'code'> as="code" className={language ? `language-${language}` : undefined} />
      </NodeViewWrapper>
    )
  }

  // Until a diagram exists (loading, empty, or broken) the source is the view.
  const showSource = editing || !svg
  return (
    <NodeViewWrapper className="overflow-hidden rounded-md border bg-sunken" data-editing={showSource ? 'true' : 'false'}>
      <div className="flex h-[30px] select-none items-center justify-between border-b pl-3 pr-1.5" contentEditable={false}>
        <span className="text-[11.5px] text-muted-foreground">{t('desktop.mermaid.label')}</span>
        <button
          type="button"
          className="flex h-6 items-center gap-1 rounded-[5px] px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? <Check className="size-3" aria-hidden="true" /> : <Pencil className="size-3" aria-hidden="true" />}
          {t(editing ? 'desktop.mermaid.done' : 'desktop.mermaid.edit')}
        </button>
      </div>
      {/* The source stays in the DOM either way — ProseMirror owns it — and
          is only hidden while the diagram is shown. */}
      {/* Important: the document's own `pre` rule is more specific than these. */}
      <pre data-mermaid-source className={cn('m-0! rounded-none! border-0!', showSource && svg && 'border-b!')} hidden={!showSource}>
        <NodeViewContent<'code'> as="code" className="language-mermaid" />
      </pre>
      {svg && (
        <div
          className="flex cursor-zoom-in justify-center overflow-x-auto p-4 [&_svg]:h-auto [&_svg]:max-w-full"
          contentEditable={false}
          onDoubleClick={() => setEditing(true)}
          // mermaid output, sanitized by securityLevel 'strict'
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {error && (
        <p className="m-0 px-3 py-2 text-[12.5px] text-destructive" contentEditable={false} role="status">
          {t('desktop.mermaid.error', { message: error.split('\n')[0] })}
        </p>
      )}
    </NodeViewWrapper>
  )
}
