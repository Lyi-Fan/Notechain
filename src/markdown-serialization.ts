import { Extension, type JSONContent } from '@tiptap/core'
import type { MarkdownManager } from '@tiptap/markdown'

export function codeSpan(text: string) {
  const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) ? ' ' : ''
  return fence + pad + text + pad + fence
}

const CodeLiteral = Extension.create({
  name: 'notechainCodeLiteral',
  renderMarkdown(node, helpers) {
    const code = codeSpan(String(node.attrs?.text ?? ''))
    if (!node.attrs?.marks?.length) return code
    const placeholder = '\uE100NotechainCodeToken\uE101'
    return helpers.renderChildren([{ type: 'text', text: placeholder, marks: node.attrs.marks }]).replace(placeholder, code)
  },
})

function normalize(node: JSONContent): JSONContent {
  return { ...node, ...(node.marks ? { marks: [...new Map(node.marks.map(mark => [mark.type, mark])).values()] } : {}), ...(node.content ? { content: node.content.map(normalize) } : {}) }
}
function forSerialization(node: JSONContent): JSONContent {
  if (!node.content) return node
  const content: JSONContent[] = []
  for (const child of node.content) {
    if (child.type === 'text' && child.marks?.some(mark => mark.type === 'code')) {
      const marks = child.marks.filter(mark => mark.type !== 'code')
      const previous = content.at(-1)
      if (previous?.type === CodeLiteral.name && JSON.stringify(previous.attrs?.marks) === JSON.stringify(marks)) previous.attrs!.text += child.text ?? ''
      else content.push({ type: CodeLiteral.name, attrs: { text: child.text ?? '', marks }, marks })
    } else content.push(forSerialization(child))
  }
  return { ...node, content }
}

export function protectMarkdownRoundTrip(manager: MarkdownManager) {
  // Tiptap infers mark delimiters using placeholder text, which cannot choose
  // a fence based on real code contents. A serialization-only token can.
  manager.registerExtension(CodeLiteral)
  const serialize = manager.serialize.bind(manager), parse = manager.parse.bind(manager)
  manager.serialize = content => serialize(Array.isArray(content) ? content.map(forSerialization) : forSerialization(content))
  manager.parse = source => normalize(parse(source))
  return manager
}
