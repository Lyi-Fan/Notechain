import assert from 'node:assert/strict'
import test from 'node:test'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table'
import { marked } from 'marked'
import { createNotebookMarkdown } from '../src/notebook-markdown'

function manager() {
  const extension = createNotebookMarkdown()
  return new MarkdownManager({ ...extension.options, extensions: [StarterKit, TaskList, TaskItem, TableKit] })
}

test('successive notebook parsers do not accumulate global or previous-editor tokenizers', () => {
  const original = marked.defaults.extensions
  const first = manager()
  const firstRules = first.instance.defaults.extensions
  const sizes = { inline: firstRules?.inline?.length, block: firstRules?.block?.length }
  assert.ok((sizes.block ?? 0) > 0)
  for (let i = 0; i < 200; i++) {
    const next = manager()
    assert.notEqual(next.instance, first.instance)
    assert.equal(next.instance.defaults.extensions?.inline?.length, sizes.inline)
    assert.equal(next.instance.defaults.extensions?.block?.length, sizes.block)
  }
  assert.equal(firstRules?.inline?.length, sizes.inline)
  assert.equal(firstRules?.block?.length, sizes.block)
  assert.equal(marked.defaults.extensions, original)
})

test('isolated parsers retain task, table, link, and Chinese Markdown round trips', () => {
  const parser = manager()
  const source = '## 中文笔记\n\n- [x] 完成\n- [ ] 待办\n\n| 名称 | 值 |\n| :--- | ---: |\n| 测试 | 42 |\n\n[关联](asset://synthetic "source metadata")\n\n**加粗**和`代码`\n'
  const parsed = parser.parse(source)
  const markdown = parser.serialize(parsed)
  assert.match(markdown, /中文笔记/)
  assert.match(markdown, /\[x\] 完成/)
  assert.match(markdown, /\[ \] 待办/)
  assert.match(markdown, /asset:\/\/synthetic/)
  assert.match(markdown, /source metadata/)
  assert.deepEqual(parser.parse(markdown), parsed)
})
