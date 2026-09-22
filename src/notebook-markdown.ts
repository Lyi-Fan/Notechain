import { Markdown } from '@tiptap/markdown'
import { Marked, type marked } from 'marked'

export function createNotebookMarkdown() {
  // Tiptap 3.31 types this as the callable singleton, but uses the Marked instance API.
  // Each editor must own its tokenizers; the global singleton retains old managers.
  return Markdown.configure({
    marked: new Marked() as unknown as typeof marked,
    markedOptions: { gfm: true, breaks: true },
  })
}
