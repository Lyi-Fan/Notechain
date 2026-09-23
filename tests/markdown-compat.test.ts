import test from 'node:test'
import assert from 'node:assert/strict'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { createNotebookMarkdown } from '../src/notebook-markdown'
import { CompatibleImage } from '../src/image-markdown'
import { NotebookBold, NotebookInlineCode, NotebookItalic, NotebookStrike, inlineMarkdownMatch, inlineMarkdownAtCursor } from '../src/markdown-formatting'
import { protectMarkdownRoundTrip } from '../src/markdown-serialization'

const extension = createNotebookMarkdown()
const parser = protectMarkdownRoundTrip(new MarkdownManager({ ...extension.options, extensions: [StarterKit.configure({ bold:false, italic:false, code:false, strike:false }), NotebookBold, NotebookItalic, NotebookStrike, NotebookInlineCode, CompatibleImage, TableKit, TaskList, TaskItem] }))
for (const source of [
  '中文**加粗**，*斜体*，***同时加粗斜体***，****加粗****，~~删除~~。',
  '`代码`、``含有 ` 的代码``、`` `首尾` ``、` **不应变粗** `、`  两端空格  `。',
  '**`加粗代码`**、[``带 ` 的代码链接``](https://example.test/reference)、*`斜体代码`*。',
  '# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n---\n\n> 引用\n>\n> - 引用里的列表\n',
  '- 一级\n  - 二级\n    - 三级\n\n1. 顺序\n2. 顺序\n\n- [ ] 待办\n- [x] 完成\n',
  '| 左 | 右 |\n| :--- | ---: |\n| **加粗** | `代码` |\n',
  '```js\nconst text = "**literal**";\n```\n\n[链接](https://example.test/a "标题")\n\n反斜杠 \\*原样\\*。',
  '![[Pasted image 20260922114737.png]]\n\n![[附件/图片.png|320x180]]\n\n![[image.png|替代文字]]',
  '![说明](<附件/含 空格.png>)\n\n![说明](./附件/含 空格.png)\n\n`![[不解析.png]]`',
  String.raw`![1785287884999](C:\Archive\报告.assets\1785287884999.png)`,
]) test('Markdown round trip: ' + source.slice(0, 40), () => {
  const parsed = parser.parse(source), markdown = parser.serialize(parsed)
  assert.deepEqual(parser.parse(markdown), parsed)
  if (source.includes('![[Pasted')) assert(markdown.includes('![[Pasted image 20260922114737.png]]'))
})

test('typing recognizes Chinese-adjacent and multi-delimiter formats without premature conversion', () => {
  for (const source of ['前**中文**', '***双重***', '****加粗****', '``a`b``', '~~删除~~']) assert(inlineMarkdownMatch(source), source)
  for (const source of ['**', '****', '``', '****加粗**', '``a`', '``a`b`', '**外层 *内层*', '\\**原样**']) assert.equal(inlineMarkdownMatch(source), null, source)
})

test('typing inside pre-existing pairs recognizes the complete inline span', () => {
  for (const [source, cursor] of [['`hi`', 3], ['**中文**', 4], ['***hi***', 5], ['****hi****', 6], ['前 `hi` 后', 5]] as const) {
    assert(inlineMarkdownAtCursor(source, cursor), source)
  }
  for (const [source, cursor] of [['`hi', 3], ['\\`hi`', 4], ['****', 2], ['**hi*', 3], ['正常文字', 2]] as const) {
    assert.equal(inlineMarkdownAtCursor(source, cursor), null, source)
  }
})

test('CommonMark and GFM syntax matrix keeps every supported construct', () => {
  const cases = [
    ['heading', '# 标题\n\n###### 六级', ['heading']],
    ['emphasis', '**粗体** *斜体* ***两者*** ****四星**** ~~删除~~', ['bold', 'italic', 'strike']],
    ['inline code', '`a`、``a`b``', ['code']],
    ['fenced code', '```ts\nconst a = 1\n```', ['codeBlock']],
    ['blockquote', '> 引用\n>\n> - 项目', ['blockquote']],
    ['lists', '- 无序\n  - 嵌套\n\n1. 有序\n2. 第二项', ['bulletList', 'orderedList']],
    ['tasks', '- [ ] 待办\n- [x] 完成', ['taskList', 'taskItem']],
    ['table', '| 名称 | 值 |\n| --- | ---: |\n| a | 1 |', ['table', 'tableRow']],
    ['links', '[文档](https://example.test "标题")\n\n<https://example.test>', ['link']],
    ['image', '![说明](<附件/含 空格.png>)', ['image']],
    ['break and rule', '第一行  \n第二行\n\n---', ['hardBreak', 'horizontalRule']],
    ['escaped punctuation', '\\*原样\\* \\# 不是标题', ['paragraph']],
  ] as const
  for (const [name, source, types] of cases) {
    const parsed = parser.parse(source)
    const found = new Set<string>(), visit = (node: any) => { if (node?.type) found.add(node.type); node?.marks?.forEach((mark: any) => found.add(mark.type)); node?.content?.forEach(visit) }
    visit(parsed)
    for (const type of types) assert(found.has(type), `${name} contains ${type}`)
    assert.deepEqual(parser.parse(parser.serialize(parsed)), parsed, `${name} round trips`)
  }
})
