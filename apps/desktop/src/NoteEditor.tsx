// The note body: Tiptap as the editing engine, markdown as the document.
//
// The .md file is the source of truth. The body arrives as markdown, is parsed
// into Tiptap's document, and every edit is serialized straight back — the
// frontmatter that noteToMarkdown wraps around this body never enters the
// editor at all. Nothing here stores Tiptap JSON or HTML.
//
// The parent keys this component by the opened note, so another note is a
// fresh editor rather than a value pushed into this one; that remount is also
// what cancels an AI request still running for the note that was left.
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { CodeBlock } from '@tiptap/extension-code-block'
import { CodeBlockView } from './editor/CodeBlockView'
import { BubbleMenu } from '@tiptap/react/menus'
import { Placeholder } from '@tiptap/extensions'
import type { SuggestionProps } from '@tiptap/suggestion'
import { t, type MessageKey } from '@meetcc/shared/i18n'
import {
  Bold,
  Code,
  CodeXml,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Quote,
  RotateCcw,
  Sparkles,
  Square,
  Strikethrough,
  Table,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/Tip'
import { DOCUMENT, PREVIEW } from './editor/prose'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { baseExtensions } from './editor/extensions'
import { SlashCommand, type SlashBridge, type SlashItem } from './editor/slashCommand'
import {
  ACTIONS,
  isAbort,
  runEditorAI,
  type ActionId,
  type AIRequest,
  type EditOp,
} from './editor/editorAI'
import { applyEdit, contextOf, markdownToHTML } from './editor/editorOps'
import { configuredClient } from './aiSettings'

const ACTION_LABEL: Record<ActionId, MessageKey> = {
  continue: 'desktop.ai.action.continue',
  improve: 'desktop.ai.action.improve',
  grammar: 'desktop.ai.action.grammar',
  shorter: 'desktop.ai.action.shorter',
  longer: 'desktop.ai.action.longer',
  simplify: 'desktop.ai.action.simplify',
  professional: 'desktop.ai.action.professional',
  casual: 'desktop.ai.action.casual',
  translate: 'desktop.ai.action.translate',
  explain: 'desktop.ai.action.explain',
  summarize: 'desktop.ai.action.summarize',
  outline: 'desktop.ai.action.outline',
  table: 'desktop.ai.action.table',
  actionItems: 'desktop.ai.action.actionItems',
  decisions: 'desktop.ai.action.decisions',
  rewrite: 'desktop.ai.action.rewrite',
}

/** Code blocks with a view: mermaid fences render as diagrams. */
const ViewedCodeBlock = CodeBlock.extend({
  addNodeView: () => ReactNodeViewRenderer(CodeBlockView),
})

const SELECTION_ACTIONS = (Object.keys(ACTIONS) as ActionId[]).filter((a) => ACTIONS[a].scope === 'selection')
const CURSOR_ACTIONS = (Object.keys(ACTIONS) as ActionId[]).filter((a) => ACTIONS[a].scope !== 'selection')

/** Slash items without an icon here (the AI group) wear the sparkle. */
const SLASH_ICON: Record<string, LucideIcon> = {
  text: Pilcrow,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bullet: List,
  ordered: ListOrdered,
  todo: ListTodo,
  quote: Quote,
  code: CodeXml,
  divider: Minus,
  table: Table,
}

/** Floating surfaces share one panel style. */
const POPOVER = 'rounded-lg border bg-popover text-popover-foreground shadow-lg'

const SPARK = 'size-3.5 flex-none text-primary'

const SLASH_GROUP: Record<SlashItem['group'], MessageKey> = {
  basic: 'desktop.slash.group.basic',
  list: 'desktop.slash.group.list',
  content: 'desktop.slash.group.content',
  ai: 'desktop.slash.group.ai',
}

/**
 * The AI lifecycle for one request. Nothing reaches the document before
 * Accept: while generating or in review the editor is read-only, so the range
 * captured at the start is still the range the answer applies to, and there
 * is no proposed text in the document for autosave to write.
 */
type AIState =
  | { phase: 'idle' }
  | { phase: 'prompt'; from: number; to: number; section: boolean }
  | { phase: 'generating'; from: number; to: number; request: AIRequest }
  | { phase: 'review'; from: number; to: number; request: AIRequest; op: EditOp; original: string }
  | { phase: 'error'; from: number; to: number; request: AIRequest; message: string }

export function NoteEditor({
  value,
  onChange,
  onWriteWithAI,
  onEditor,
}: {
  value: string
  onChange: (markdown: string) => void
  /** Open the document composer (a new document written by AI). */
  onWriteWithAI: () => void
  /** The live editor, for the AI side panel; null once it is torn down. */
  onEditor?: (editor: Editor | null) => void
}) {
  // Callbacks change identity on every keystroke in the parent; reading them
  // through refs keeps the editor from being rebuilt underneath the cursor.
  const emit = useRef(onChange)
  emit.current = onChange
  const compose = useRef(onWriteWithAI)
  compose.current = onWriteWithAI

  const [ai, setAI] = useState<AIState>({ phase: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  // The slash plugin is built once and calls back through this, so it always
  // reaches the current render rather than the first one.
  const runRef = useRef<(request: AIRequest, from: number, to: number) => Promise<void>>(async () => {})

  const [slash, setSlash] = useState<null | { props: SuggestionProps<SlashItem>; index: number }>(null)
  const slashRef = useRef(slash)
  slashRef.current = slash

  // The plugin is built once; it reaches React through this object.
  const bridge = useRef<SlashBridge>({
    open: (props) => setSlash((prev) => ({ props, index: prev && prev.props.query === props.query ? prev.index : 0 })),
    close: () => setSlash(null),
    key: (event) => {
      const s = slashRef.current
      if (!s) return false
      const n = s.props.items.length
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!n) return true
        const step = event.key === 'ArrowDown' ? 1 : -1
        setSlash({ ...s, index: (s.index + step + n) % n })
        return true
      }
      if (event.key === 'Enter') {
        const item = s.props.items[s.index]
        if (item) s.props.command(item)
        return Boolean(item)
      }
      if (event.key === 'Escape') {
        setSlash(null)
        return true
      }
      return false
    },
    ai: (editor, kind) => {
      if (kind === 'create') return compose.current()
      const { from, to } = editor.state.selection
      if (kind === 'continue') return void runRef.current({ kind: 'action', action: 'continue', ctx: contextOf(editor, from, to) }, from, to)
      if (kind === 'summarize') return void runRef.current({ kind: 'action', action: 'summarize', ctx: contextOf(editor, from, to) }, from, to)
      setAI({ phase: 'prompt', from, to, section: kind === 'section' })
    },
  })

  const editor = useEditor({
    extensions: [
      ...baseExtensions({ codeBlock: ViewedCodeBlock }),
      Placeholder.configure({
        placeholder: ({ editor: e, node }) =>
          e.isEmpty
            ? t('desktop.editor.emptyPlaceholder')
            : node.type.name === 'heading'
              ? t('desktop.editor.headingPlaceholder')
              : t('desktop.editor.blockPlaceholder'),
      }),
      SlashCommand.configure({ bridge: bridge.current }),
    ],
    content: value,
    contentType: 'markdown',
    // A parse that changes nothing is not an edit: only transactions the user
    // made reach `onUpdate`, so opening a note never marks it dirty.
    // Trimmed: Tiptap keeps an empty paragraph after a trailing heading or
    // list so the cursor has somewhere to go; the file should not carry it.
    onUpdate: ({ editor: e }) => emit.current(e.getMarkdown().trimEnd()),
    editorProps: {
      attributes: { class: DOCUMENT },
      handleKeyDown: (view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
          const { from, to } = view.state.selection
          setAI({ phase: 'prompt', from, to, section: false })
          return true
        }
        return false
      },
    },
  })

  const isEmpty = useEditorState({ editor, selector: ({ editor: e }) => e?.isEmpty ?? true })

  // Leaving the note (or closing the app window) stops the request; its
  // answer would belong to a document that is no longer on screen.
  useEffect(() => () => abortRef.current?.abort(), [])

  const publish = useRef(onEditor)
  publish.current = onEditor
  useEffect(() => {
    publish.current?.(editor)
    return () => publish.current?.(null)
  }, [editor])

  async function run(request: AIRequest, from: number, to: number): Promise<void> {
    if (!editor) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    editor.setEditable(false, false)
    setAI({ phase: 'generating', from, to, request })
    try {
      const client = await configuredClient()
      const op = await runEditorAI(client, request, ctrl.signal)
      if (ctrl.signal.aborted) return
      setAI({ phase: 'review', from, to, request, op, original: request.ctx.selection })
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) return
      setAI({ phase: 'error', from, to, request, message: (e as Error).message })
    }
  }

  runRef.current = run

  function close(): void {
    abortRef.current?.abort()
    editor?.setEditable(true, false)
    setAI({ phase: 'idle' })
    editor?.commands.focus()
  }

  function accept(below: boolean): void {
    if (!editor || ai.phase !== 'review') return
    editor.setEditable(true, false)
    applyEdit(editor, ai.op, ai.from, ai.to, below)
    setAI({ phase: 'idle' })
  }

  function openAsk(): void {
    if (!editor) return
    const { from, to } = editor.state.selection
    setAI({ phase: 'prompt', from, to, section: false })
  }

  return (
    // The body is the page, not a box on it; it grows with the document, so the
    // action bar stays underneath it.
    <div className="relative min-h-[300px] flex-[1_0_auto] select-text">
      {editor && (
        <BubbleMenu
          editor={editor}
          className={cn(POPOVER, 'flex items-center gap-0.5 p-[3px]')}
          shouldShow={({ editor: e, from, to }) => from !== to && e.isEditable && !e.isActive('codeBlock')}
        >
          <SelectionToolbar editor={editor} onAsk={openAsk} />
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {editor && isEmpty && ai.phase === 'idle' && (
        <div className="-mt-9">
          <Button type="button" variant="outline" size="sm" onClick={() => compose.current()}>
            <Sparkles className="text-primary" /> {t('desktop.ai.writeWithAI')}
          </Button>
        </div>
      )}
      {slash && <SlashMenu state={slash} onPick={(i) => slash.props.command(slash.props.items[i])} />}
      {editor && ai.phase !== 'idle' && (
        <AIPanel
          editor={editor}
          state={ai}
          onRun={(request) => void run(request, ai.from, ai.to)}
          onAccept={accept}
          onRetry={() => (ai.phase === 'review' || ai.phase === 'error') && void run(ai.request, ai.from, ai.to)}
          onClose={close}
        />
      )}
    </div>
  )
}

function SelectionToolbar({ editor, onAsk }: { editor: Editor; onAsk: () => void }) {
  const [linking, setLinking] = useState(false)
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
    }),
  })
  if (linking) {
    return (
      <input
        className="h-7 w-[260px] bg-transparent px-2 text-foreground outline-none placeholder:text-muted-foreground"
        autoFocus
        defaultValue={active.href}
        placeholder={t('desktop.editor.linkPlaceholder')}
        aria-label={t('desktop.editor.link')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setLinking(false)
          if (e.key !== 'Enter') return
          e.preventDefault()
          const href = e.currentTarget.value.trim()
          const chain = editor.chain().focus().extendMarkRange('link')
          if (href) chain.setLink({ href }).run()
          else chain.unsetLink().run()
          setLinking(false)
        }}
        onBlur={() => setLinking(false)}
      />
    )
  }
  const tool = (on: boolean, label: string, Icon: LucideIcon, run: () => void) => (
    <Tip label={label}>
      <button
        type="button"
        className={cn('grid h-7 min-w-7 place-items-center rounded-[5px] px-[7px] hover:bg-muted', on && 'bg-muted text-primary')}
        aria-label={label}
        aria-pressed={on}
        onClick={run}
      >
        <Icon className="size-3.5" />
      </button>
    </Tip>
  )
  return (
    <>
      {tool(active.bold, t('desktop.editor.bold'), Bold, () => editor.chain().focus().toggleBold().run())}
      {tool(active.italic, t('desktop.editor.italic'), Italic, () => editor.chain().focus().toggleItalic().run())}
      {tool(active.strike, t('desktop.editor.strike'), Strikethrough, () => editor.chain().focus().toggleStrike().run())}
      {tool(active.code, t('desktop.editor.code'), Code, () => editor.chain().focus().toggleCode().run())}
      {tool(active.link, t('desktop.editor.link'), Link, () => setLinking(true))}
      <span className="mx-[3px] h-[18px] w-px bg-border" />
      <button type="button" className="flex h-7 items-center gap-[5px] rounded-[5px] px-[7px] text-[13px] hover:bg-muted" onClick={onAsk}>
        <Sparkles className={SPARK} aria-hidden="true" /> {t('desktop.ai.ask')}
      </button>
    </>
  )
}

/** One row of a pick list: the slash menu's and the inline AI menu's. */
const CHOICE = 'flex h-[30px] w-full items-center gap-2 rounded-[5px] px-2 text-left text-[13px] text-foreground'
const ACTIONS_ROW = 'flex flex-wrap gap-1.5 px-1 pb-1 pt-0.5'

function SlashMenu({
  state,
  onPick,
}: {
  state: { props: SuggestionProps<SlashItem>; index: number }
  onPick: (index: number) => void
}) {
  const rect = state.props.clientRect?.()
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [state.index])
  if (!rect) return null
  const { items } = state.props
  const below = rect.bottom + 320 < window.innerHeight
  return (
    <div
      ref={list}
      className={cn(POPOVER, 'fixed z-40 max-h-[min(340px,50vh)] w-60 overflow-y-auto p-1')}
      role="listbox"
      style={below ? { top: rect.bottom + 6, left: rect.left } : { bottom: window.innerHeight - rect.top + 6, left: rect.left }}
    >
      {items.length === 0 && <div className="p-2 text-[12.5px] text-muted-foreground">{t('desktop.slash.noMatch')}</div>}
      {items.map((item, i) => (
        <div key={item.id}>
          {(i === 0 || items[i - 1].group !== item.group) && (
            <div className="px-2 pb-[3px] pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t(SLASH_GROUP[item.group])}</div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={i === state.index}
            className={cn(CHOICE, i === state.index && 'bg-muted')}
            // mousedown, not click: a click would blur the editor first and
            // end the suggestion before the command could run.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(i)
            }}
          >
            {(() => {
              const Icon = SLASH_ICON[item.id]
              return Icon ? (
                <Icon className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
              ) : (
                <Sparkles className={SPARK} aria-hidden="true" />
              )
            })()}
            {t(item.label)}
          </button>
        </div>
      ))}
    </div>
  )
}

function AIPanel({
  editor,
  state,
  onRun,
  onAccept,
  onRetry,
  onClose,
}: {
  editor: Editor
  state: Exclude<AIState, { phase: 'idle' }>
  onRun: (request: AIRequest) => void
  onAccept: (below: boolean) => void
  onRetry: () => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const hasSelection = state.from !== state.to
  const ctx = () => contextOf(editor, state.from, state.to)

  const actions = state.phase === 'prompt' && state.section ? [] : hasSelection ? SELECTION_ACTIONS : CURSOR_ACTIONS
  const q = text.trim().toLowerCase()
  const matches = actions.filter((a) => !q || t(ACTION_LABEL[a]).toLowerCase().includes(q))
  type Choice = { key: string; label: string; request: () => AIRequest }
  const choices: Choice[] = [
    ...(q ? [{ key: 'custom', label: text.trim(), request: (): AIRequest => ({ kind: 'custom', instruction: text.trim(), ctx: ctx() }) }] : []),
    ...matches.map((a) => ({ key: a, label: t(ACTION_LABEL[a]), request: (): AIRequest => ({ kind: 'action', action: a, ctx: ctx() }) })),
  ]

  // Anchor under the end of the range; fixed, so the scrolling pane does not clip it.
  let top = 120
  let left = 120
  try {
    const at = editor.view.coordsAtPos(Math.min(state.to, editor.state.doc.content.size))
    top = Math.min(at.bottom + 8, window.innerHeight - 260)
    left = Math.min(at.left, window.innerWidth - 440)
  } catch {
    /* a position the view cannot map keeps the fallback */
  }

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (state.phase === 'prompt' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && choices.length) {
      e.preventDefault()
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length)
    } else if (state.phase === 'prompt' && e.key === 'Enter' && choices[index]) {
      e.preventDefault()
      onRun(choices[index].request())
    }
  }

  return (
    <div
      className={cn(POPOVER, 'fixed z-40 max-h-[min(460px,70vh)] w-[420px] overflow-y-auto p-1.5')}
      style={{ top, left }}
      onKeyDown={onKey}
      role="dialog"
      aria-label={t('desktop.ai.ask')}
    >
      {state.phase === 'prompt' && (
        <>
          <div className="flex items-center gap-2 px-1.5 py-0.5">
            <Sparkles className={SPARK} aria-hidden="true" />
            <input
              autoFocus
              className="h-8 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              value={text}
              placeholder={t(state.section ? 'desktop.ai.sectionPlaceholder' : hasSelection ? 'desktop.ai.editPlaceholder' : 'desktop.ai.writePlaceholder')}
              onChange={(e) => {
                setText(e.target.value)
                setIndex(0)
              }}
            />
          </div>
          {choices.length > 0 && (
            <div className="mt-1 border-t pt-1" role="listbox">
              {choices.map((c, i) => (
                <button
                  key={c.key}
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  className={cn(CHOICE, i === index && 'bg-muted')}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => onRun(c.request())}
                >
                  {c.key === 'custom' ? t('desktop.ai.customInstruction', { text: c.label }) : c.label}
                </button>
              ))}
            </div>
          )}
          <p className="mx-2 mb-0.5 mt-1.5 text-[11.5px] text-muted-foreground">{t(hasSelection ? 'desktop.ai.scopeSelection' : 'desktop.ai.scopeDocument')}</p>
        </>
      )}
      {state.phase === 'generating' && (
        <div className="flex items-center gap-2 px-1.5 py-1">
          <Sparkles className={cn(SPARK, 'animate-pulse motion-reduce:animate-none')} aria-hidden="true" />
          <span className="flex-1 text-muted-foreground">{t('desktop.ai.writing')}</span>
          <Button type="button" variant="outline" size="xs" autoFocus onClick={onClose}>
            <Square className="fill-current" />
            {t('desktop.ai.stop')}
          </Button>
        </div>
      )}
      {state.phase === 'error' && (
        <div role="alert">
          <p className="mx-1.5 mb-2 mt-1 text-[12.5px] text-destructive">{state.message}</p>
          <div className={ACTIONS_ROW}>
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              <RotateCcw />
              {t('desktop.ai.retry')}
            </Button>
            <Button type="button" variant="outline" size="xs" autoFocus onClick={onClose}>
              <X />
              {t('desktop.ai.close')}
            </Button>
          </div>
        </div>
      )}
      {state.phase === 'review' && (
        <div>
          {state.op.op === 'replaceDocument' && <p className="mx-1.5 my-1 text-xs text-muted-foreground">{t('desktop.ai.reviewDocument')}</p>}
          {state.op.op === 'replace' && state.original && (
            <div
              className={cn(PREVIEW, 'mb-1.5 max-h-[140px] overflow-y-auto bg-sunken text-muted-foreground line-through')} dangerouslySetInnerHTML={{ __html: markdownToHTML(editor, state.original) }} />
          )}
          <div
            className={cn(PREVIEW, 'mb-1.5 max-h-[260px] overflow-y-auto bg-primary/9')} dangerouslySetInnerHTML={{ __html: markdownToHTML(editor, state.op.markdown) }} />
          <div className={ACTIONS_ROW}>
            <Button type="button" size="xs" autoFocus onClick={() => onAccept(false)}>
              {t(
                state.op.op === 'replace'
                  ? 'desktop.ai.replace'
                  : state.op.op === 'append'
                    ? 'desktop.ai.append'
                    : state.op.op === 'replaceDocument'
                      ? 'desktop.ai.acceptAll'
                      : 'desktop.ai.insert',
              )}
            </Button>
            {state.op.op === 'replace' && (
              <Button type="button" variant="outline" size="xs" onClick={() => onAccept(true)}>
                {t('desktop.ai.insertBelow')}
              </Button>
            )}
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              <RotateCcw />
              {t('desktop.ai.retry')}
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={onClose}>
              {t(state.op.op === 'replaceDocument' ? 'desktop.ai.rejectAll' : 'desktop.ai.reject')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
