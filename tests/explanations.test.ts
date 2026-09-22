import test from 'node:test'
import assert from 'node:assert/strict'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { NotebookLink } from '../src/components/NotebookLinkAnnotation'
import { createNotebookMarkdown } from '../src/notebook-markdown'
import { linkAttributes, readLinkFields } from '../src/notebook-links'
import { explanationHref } from '../src/explanations'

test('an explanation travels inside the same Markdown note without a separate article', () => {
  const markdown = createNotebookMarkdown()
  const manager = new MarkdownManager({ ...markdown.options, extensions:[StarterKit.configure({link:false}),NotebookLink] })
  const content = '## 幂等性\n\n重复提交同一个请求，不会重复创建订单。\n\n`requestId` 用来识别同一次操作。'
  const attrs = linkAttributes(explanationHref('idempotence'), {annotation:'幂等性',explanation:{id:'idempotence',content}})
  const document = { type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'幂等性',marks:[{type:'link',attrs}]}]}] }
  const saved = manager.serialize(document), restored = manager.parse(saved)
  const mark = restored.content![0].content![0].marks![0]
  assert.equal(readLinkFields(mark.attrs!.title)?.explanation?.content,content)
  assert(!saved.includes('/cases/') && !saved.includes('/notebooks/'))
})

test('transfer identity survives link metadata round trips and invalid explanations are ignored', () => {
  assert.equal(readLinkFields(linkAttributes('/notebooks/book?file=A.md',{annotation:'A',transferId:'clip-1'}).title)?.transferId,'clip-1')
  const invalid = linkAttributes('#x',{annotation:'x',explanation:{id:'../bad',content:'x'}})
  assert.equal(readLinkFields(invalid.title)?.explanation,undefined)
})
