import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { useLedger } from '../store'
import { isSecretFinding, maskSecret } from '../secrets'
import { SecretValue } from './SecretValue'

function SecretNode({ node }: NodeViewProps) {
  const { findings } = useLedger()
  const finding = findings.find(item => item.id === node.attrs.findingId && item.caseId === node.attrs.caseId && isSecretFinding(item))
  return <NodeViewWrapper as="span" className="notebook-secret-node" contentEditable={false}>
    {finding ? <SecretValue key={`${finding.id}:${finding.version}`} identity={finding.id} value={finding.value!} /> : <span className="secret-unavailable">{maskSecret()}</span>}
  </NodeViewWrapper>
}

export const NotebookSecret = Node.create({
  name: 'notebookSecret',
  group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes() { return { findingId: { default: '' }, caseId: { default: '' } } },
  parseHTML() { return [{ tag: 'span[data-notebook-secret]', getAttrs: element => ({ findingId: element.getAttribute('data-notebook-secret'), caseId: element.getAttribute('data-case-id') }) }] },
  renderHTML({ node, HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-notebook-secret': node.attrs.findingId, 'data-case-id': node.attrs.caseId }), maskSecret()] },
  renderMarkdown(node) { return `[${maskSecret()}](/cases/${encodeURIComponent(node.attrs?.caseId ?? '')}/findings/${encodeURIComponent(node.attrs?.findingId ?? '')} "asset-ledger-secret:v1")` },
  addNodeView() { return ReactNodeViewRenderer(SecretNode) },
})
