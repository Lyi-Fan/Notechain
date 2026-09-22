import { Markdown } from '@tiptap/markdown'
import { Marked, type marked } from 'marked'
import { protectMarkdownRoundTrip } from './markdown-serialization'

const NotebookMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event)
    if (this.editor.markdown) protectMarkdownRoundTrip(this.editor.markdown)
  },
})

export function createNotebookMarkdown() {
  // Tiptap 3.31 types this as the callable singleton, but uses the Marked instance API.
  // Each editor must own its tokenizers; the global singleton retains old managers.
  return NotebookMarkdown.configure({
    marked: new Marked() as unknown as typeof marked,
    markedOptions: { gfm: true, breaks: true },
  })
}
