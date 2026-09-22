import { getMarkRange, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { linkAttributes, readLinkFields } from './notebook-links'

export interface Explanation { id: string; title: string; content: string }
export const explanationHref = (id: string) => '#notechain-explanation-' + id
export function explanationsIn(editor: Editor | null): Explanation[] {
  const records = new Map<string, Explanation>()
  editor?.state.doc.descendants((node, pos) => {
    const mark = node.marks.find(mark => mark.type === editor.schema.marks.link)
    const explanation = readLinkFields(mark?.attrs.title)?.explanation
    if (!explanation || records.has(explanation.id)) return
    const range = getMarkRange(editor.state.doc.resolve(pos), mark!.type, mark!.attrs)
    if (range) records.set(explanation.id, { ...explanation, title: editor.state.doc.textBetween(range.from, range.to) })
  })
  return [...records.values()]
}
export function updateExplanation(editor: Editor, id: string, content: string | null) {
  if (editor.isDestroyed) throw new Error('原笔记已关闭')
  if (content && content.length > 256000) throw new Error('单个扩展解释不能超过 256,000 字符')
  const transaction = closeHistory(editor.state.tr); let found = false
  editor.state.doc.descendants((node, pos) => {
    const mark = node.marks.find(mark => mark.type === editor.schema.marks.link)
    const fields = readLinkFields(mark?.attrs.title)
    if (fields?.explanation?.id !== id) return
    found = true
    if (content === null) transaction.removeMark(pos, pos + node.nodeSize, mark!.type)
    else transaction.addMark(pos, pos + node.nodeSize, mark!.type.create({ ...mark!.attrs, ...linkAttributes(mark!.attrs.href, { ...fields, explanation: { id, content } }) }))
  })
  if (!found) throw new Error('解释已从原笔记移除')
  editor.view.dispatch(transaction)
}
