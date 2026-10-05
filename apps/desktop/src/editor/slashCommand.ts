// "/" opens the block menu. The suggestion plugin finds the trigger and tracks
// the query; the menu itself is React (EditorMenus.tsx), reached through a
// bridge object so the plugin never holds a stale React closure.
import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { t, type MessageKey } from '@meetcc/shared/i18n'
import { textFilter } from '@/lib/utils'

export type SlashGroup = 'basic' | 'list' | 'content' | 'ai'

export interface SlashItem {
  id: string
  group: SlashGroup
  label: MessageKey
  /** Extra words the filter matches, in both languages. */
  keywords: string
  run: (editor: Editor, range: Range) => void
}

/** Hooks the editor component fills in; AI items need React state. */
export interface SlashBridge {
  open(props: SuggestionProps<SlashItem>): void
  close(): void
  key(event: KeyboardEvent): boolean
  ai(editor: Editor, kind: 'ask' | 'continue' | 'section' | 'summarize' | 'create'): void
  /** Pick files and insert them as media at the cursor. */
  media(editor: Editor): void
}

export function slashItems(bridge: Pick<SlashBridge, 'ai' | 'media'>): SlashItem[] {
  const chain = (e: Editor, r: Range) => e.chain().focus().deleteRange(r)
  return [
    { id: 'text', group: 'basic', label: 'desktop.slash.text', keywords: 'paragraph teks', run: (e, r) => chain(e, r).setParagraph().run() },
    { id: 'h1', group: 'basic', label: 'desktop.slash.h1', keywords: 'heading title judul h1', run: (e, r) => chain(e, r).setHeading({ level: 1 }).run() },
    { id: 'h2', group: 'basic', label: 'desktop.slash.h2', keywords: 'heading subjudul h2', run: (e, r) => chain(e, r).setHeading({ level: 2 }).run() },
    { id: 'h3', group: 'basic', label: 'desktop.slash.h3', keywords: 'heading h3', run: (e, r) => chain(e, r).setHeading({ level: 3 }).run() },
    { id: 'bullet', group: 'list', label: 'desktop.slash.bullet', keywords: 'bullet list unordered daftar', run: (e, r) => chain(e, r).toggleBulletList().run() },
    { id: 'ordered', group: 'list', label: 'desktop.slash.ordered', keywords: 'numbered ordered list nomor', run: (e, r) => chain(e, r).toggleOrderedList().run() },
    { id: 'todo', group: 'list', label: 'desktop.slash.todo', keywords: 'todo task checkbox tugas', run: (e, r) => chain(e, r).toggleTaskList().run() },
    { id: 'quote', group: 'content', label: 'desktop.slash.quote', keywords: 'quote blockquote kutipan', run: (e, r) => chain(e, r).toggleBlockquote().run() },
    { id: 'code', group: 'content', label: 'desktop.slash.code', keywords: 'code block kode', run: (e, r) => chain(e, r).toggleCodeBlock().run() },
    { id: 'divider', group: 'content', label: 'desktop.slash.divider', keywords: 'divider hr rule garis', run: (e, r) => chain(e, r).setHorizontalRule().run() },
    { id: 'media', group: 'content', label: 'desktop.slash.media', keywords: 'image picture photo video audio file upload gambar foto berkas lampiran', run: (e, r) => { chain(e, r).run(); bridge.media(e) } },
    { id: 'table', group: 'content', label: 'desktop.slash.table', keywords: 'table tabel grid', run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: 'ask', group: 'ai', label: 'desktop.slash.askAI', keywords: 'ai ask tanya', run: (e, r) => { chain(e, r).run(); bridge.ai(e, 'ask') } },
    { id: 'continue', group: 'ai', label: 'desktop.slash.continue', keywords: 'ai continue lanjut tulis', run: (e, r) => { chain(e, r).run(); bridge.ai(e, 'continue') } },
    { id: 'section', group: 'ai', label: 'desktop.slash.section', keywords: 'ai generate section bagian buat', run: (e, r) => { chain(e, r).run(); bridge.ai(e, 'section') } },
    { id: 'summarize', group: 'ai', label: 'desktop.slash.summarize', keywords: 'ai summarize ringkas', run: (e, r) => { chain(e, r).run(); bridge.ai(e, 'summarize') } },
    { id: 'create', group: 'ai', label: 'desktop.slash.createDoc', keywords: 'ai create document dokumen baru prd brd', run: (e, r) => { chain(e, r).run(); bridge.ai(e, 'create') } },
  ]
}

/** Items whose label (in the current language) or keywords contain the query. */
export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  if (!query.trim()) return items
  const has = textFilter(query)
  return items.filter((i) => has(`${t(i.label)} ${i.keywords} ${i.id}`))
}

export const SlashCommand = Extension.create<{ bridge: SlashBridge | null }>({
  name: 'slashCommand',
  addOptions: () => ({ bridge: null }),
  addProseMirrorPlugins() {
    const bridge = this.options.bridge
    if (!bridge) return []
    const all = slashItems(bridge)
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slashCommand'),
        char: '/',
        // Not inside code: "/" is a path separator there, not a command.
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => filterSlash(all, query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => ({
          onStart: (p) => bridge.open(p),
          onUpdate: (p) => bridge.open(p),
          onKeyDown: (p: SuggestionKeyDownProps) => bridge.key(p.event),
          onExit: () => bridge.close(),
        }),
      }),
    ]
  },
})
