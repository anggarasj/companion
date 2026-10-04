// How rendered markdown looks, as utility classes on the element that holds
// it. Tiptap and `markdownToHTML` produce plain tags, and Tailwind's preflight
// strips every default from them — lists lose their bullets, headings their
// size — so each one is restored here, not left to the browser.

/** The document itself: on `.ProseMirror`, through Tiptap's editorProps. */
export const DOCUMENT = [
  'pb-12 pt-1 text-[15px] leading-[1.7] text-foreground outline-none',
  '[&[contenteditable=false]]:cursor-default',
  // Document rhythm, not form rhythm: blocks need room to read as blocks.
  '[&>*+*]:mt-[0.55em] [&>:first-child]:mt-0 [&_p]:m-0',
  '[&_:is(h1,h2,h3)]:mb-[0.25em] [&_:is(h1,h2,h3)]:mt-[1.3em] [&_:is(h1,h2,h3)]:font-semibold [&_:is(h1,h2,h3)]:leading-[1.3] [&_:is(h1,h2,h3)]:tracking-[-0.01em]',
  '[&_h1]:text-[1.75em] [&_h2]:text-[1.35em] [&_h3]:text-[1.12em]',
  '[&_:is(ul,ol)]:m-0 [&_:is(ul,ol)]:pl-[1.5em] [&_ul]:list-disc [&_ol]:list-decimal [&_li+li]:mt-[0.15em] [&_li>p]:m-0',
  '[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-[0.2em]',
  '[&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start [&_ul[data-type=taskList]_li]:gap-2',
  '[&_ul[data-type=taskList]_li>label]:mt-[0.3em] [&_ul[data-type=taskList]_li>label]:select-none [&_ul[data-type=taskList]_li>div]:flex-1',
  '[&_li[data-checked=true]>div]:text-muted-foreground [&_li[data-checked=true]>div]:line-through',
  '[&_input[type=checkbox]]:accent-primary',
  '[&_blockquote]:m-0 [&_blockquote]:border-l-[3px] [&_blockquote]:pl-[0.9em] [&_blockquote]:text-muted-foreground',
  '[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-[5px] [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.88em]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-sunken [&_pre]:px-3.5 [&_pre]:py-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[13px]',
  '[&_a]:text-info [&_a]:underline [&_a]:underline-offset-2',
  '[&_hr]:my-[1.2em] [&_hr]:border-border',
  '[&_img]:inline [&_img]:max-w-full [&_img]:rounded-sm',
  '[&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse',
  '[&_:is(th,td)]:border [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-[5px] [&_:is(th,td)]:text-left [&_:is(th,td)]:align-top',
  '[&_th]:bg-muted [&_th]:font-semibold [&_.selectedCell]:bg-primary/12',
  // The hint on the empty block under the cursor — what advertises "/".
  '[&_.is-empty]:before:pointer-events-none [&_.is-empty]:before:float-left [&_.is-empty]:before:h-0 [&_.is-empty]:before:text-muted-foreground/60 [&_.is-empty]:before:content-[attr(data-placeholder)]',
].join(' ')

/** An AI proposal before it is accepted: the document's look, a size smaller. */
export const PREVIEW = [
  'select-text rounded-[5px] px-2.5 py-2 text-[13.5px] leading-[1.6]',
  '[&>*]:m-0 [&>*+*]:mt-[0.5em]',
  '[&_:is(h1,h2,h3)]:font-semibold [&_h1]:text-[1.35em] [&_h2]:text-[1.18em] [&_h3]:text-[1.05em]',
  '[&_:is(ul,ol)]:pl-[1.3em] [&_ul]:list-disc [&_ol]:list-decimal',
  '[&_a]:pointer-events-none [&_a]:text-info',
  '[&_table]:border-collapse [&_:is(th,td)]:border [&_:is(th,td)]:px-1.5 [&_:is(th,td)]:py-[3px]',
  '[&_code]:font-mono [&_code]:text-[0.9em]',
].join(' ')
