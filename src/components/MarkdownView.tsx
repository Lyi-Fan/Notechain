import { useContext, useMemo, useState, type ReactNode } from 'react'
import { FileDocumentContext } from './FileDocumentContext'
import { writeClipboardText } from '../platform'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { readLinkFields } from '../notebook-links'
import { headingSlug } from '../notes'
import { ManagedImageView } from './ManagedImage'
import { SecretValue } from './SecretValue'
import { useLedger } from '../store'
import { isSecretFinding } from '../secrets'
import { remarkImageEmbeds } from '../image-markdown'

interface MarkdownViewProps {
  content: string
  onInternalLink?: (href: string) => void
}

interface MarkdownNode { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] }

function markdownText(node: MarkdownNode): string {
  if (node.type === 'text') return node.value ?? ''
  return node.children?.map(markdownText).join('') ?? ''
}

// This executes on each parsed Markdown tree, outside React rendering. That
// keeps duplicate heading IDs stable under StrictMode's render replay.
function rehypeHeadingIds() {
  return (tree: MarkdownNode) => {
    const counts = new Map<string, number>()
    const visit = (node: MarkdownNode) => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName ?? '')) {
        const slug = headingSlug(markdownText(node))
        const count = counts.get(slug) ?? 0
        counts.set(slug, count + 1)
        node.properties = { ...node.properties, id: count ? `${slug}-${count}` : slug }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false)
  const text = String(children ?? '').replace(/\n$/, '')
  const copy = async () => {
    try {
      await writeClipboardText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { /* Clipboard may be unavailable in an embedded webview. */ }
  }
  return (
    <div className="code-block">
      <button className="code-copy" type="button" onClick={copy} title="复制代码">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      <code className={className}>{children}</code>
    </div>
  )
}

// Keep GFM rendering useful for the ledger's internal links while allowing
// only explicitly safe URL schemes. Raw HTML, scripts and data/javascript
// URLs remain stripped by rehype-sanitize.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, img: [...(defaultSchema.attributes?.img ?? []), 'dataWikiImage', 'width', 'height'] },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'asset', 'case'],
    src: ['http', 'https'],
  },
}

export function MarkdownView({ content, onInternalLink }: MarkdownViewProps) {
  const file = useContext(FileDocumentContext)
  const { findings } = useLedger()
  const secrets = useMemo(() => new Map(findings.filter(isSecretFinding).map(finding => [`/cases/${finding.caseId}/findings/${finding.id}`, finding])), [findings])
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkImageEmbeds]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema], rehypeHeadingIds]}
        components={{
          code({ className, children, ...props }) {
            const isInline = !className && !String(children ?? '').includes('\n')
            return isInline ? <code className="inline-code" {...props}>{children}</code> : <CodeBlock className={className}>{children}</CodeBlock>
          },
          a({ href, children, title, ...props }) {
            const secret = secrets.get(href?.split('#')[0] ?? '')
            if (secret) return <SecretValue identity={secret.id} value={secret.value!} />
            const fields = readLinkFields(title)
            const tooltip = fields ? fields.originalTitle : title
            const fileTarget = href && file?.resolveFileLink(href)
            const internal = fileTarget || href?.startsWith('asset://') || href?.startsWith('case://') || href?.startsWith('/cases/') || href?.startsWith('/notebooks/') || href?.startsWith('#')
            if (internal) {
              return <a href={href} title={tooltip} {...props} onClick={(event) => { event.preventDefault(); if (href) onInternalLink?.(fileTarget ? fileTarget.href : href) }}>{children}</a>
            }
            return <a href={href} title={tooltip} {...props} target="_blank" rel="noreferrer"><span>{children}</span><ExternalLink size={12} aria-hidden="true" /></a>
          },
          img({ src, alt, title, className, width, height, node }) {
            return <ManagedImageView src={src} alt={alt} title={title} className={className} width={width} height={height} wiki={!!node?.properties?.dataWikiImage} />
          },
        }}
      >
        {content || '_暂无记录_'}
      </ReactMarkdown>
    </div>
  )
}
