import Image from '@tiptap/extension-image'

export function parseImageEmbed(source: string) {
  const wiki = /^!\[\[([^\r\n]+?)\]\]/.exec(source)
  if (wiki) {
    const [target, option] = wiki[1].split('|')
    const href = target.replace(/#outline$/, '')
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(href)) return
    const size = option && /^(\d+)(?:x(\d+))?$/.exec(option)
    return { type: 'image', raw: wiki[0], href, text: size ? '' : option ?? '', title: '', wiki: true,
      width: size ? Math.min(30000, Number(size[1])) : null, height: size?.[2] ? Math.min(30000, Number(size[2])) : null }
  }
  const angle = /^!\[([^\]\r\n]*)\]\(<([^<>\r\n]+)>(?:\s+"([^"\r\n]*)")?\)/.exec(source)
  if (angle && angle[2].includes('\\')) return { type: 'image', raw: angle[0], href: angle[2], text: angle[1], title: angle[3] ?? '', wiki: false, width: null, height: null, preserveSource: true }
  // Typora also permits spaces in a bare local image destination.
  const spaced = /^!\[([^\]\r\n]*)\]\(([^"<>\r\n]+?\.(?:png|jpe?g|gif|webp))(?:\s+"([^"\r\n]*)")?\)/i.exec(source)
  if (spaced && /[\s\\]/.test(spaced[2])) return { type: 'image', raw: spaced[0], href: spaced[2], text: spaced[1], title: spaced[3] ?? '', wiki: false, width: null, height: null, preserveSource: spaced[2].includes('\\') }
}

export const CompatibleImage = Image.extend({
  addAttributes() { return { ...this.parent?.(), originalSyntax: { default: null, rendered: false, parseHTML: () => null }, wiki: { default: false, rendered: false, parseHTML: () => false } } },
  markdownTokenizer: { name: 'image', level: 'inline', start: source => source.indexOf('!['), tokenize: source => parseImageEmbed(source) },
  parseMarkdown(token, helpers) {
    return helpers.createNode('image', { src: token.href, alt: token.text, title: token.title || null,
      width: token.width ?? null, height: token.height ?? null, wiki: !!token.wiki, originalSyntax: token.wiki || token.preserveSource ? token.raw : null })
  },
  renderMarkdown(node) {
    if (node.attrs?.originalSyntax) return node.attrs.originalSyntax
    const src = String(node.attrs?.src ?? '').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/[\r\n]/g, '%0A')
    const alt = String(node.attrs?.alt ?? '').replace(/[\\\[\]]/g, '\\$&')
    const title = String(node.attrs?.title ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const dimension = (value: unknown) => typeof value === 'number' || typeof value === 'string' ? (/^\d{1,5}(?:%)?$/.test(String(value)) ? String(value) : '') : ''
    const width = dimension(node.attrs?.width), height = dimension(node.attrs?.height)
    if (width || height) {
      const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `<img src="${escape(String(node.attrs?.src ?? ''))}" alt="${escape(String(node.attrs?.alt ?? ''))}"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`
    }
    return `![${alt}](<${src}>${title ? ` "${title}"` : ''})`
  },
})

interface MarkdownNode { type: string; value?: string; url?: string; alt?: string; data?: unknown; children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }
export function remarkImageEmbeds() {
  return (tree: MarkdownNode, file?: { value?: unknown }) => {
    const source = String(file?.value ?? '')
    const visit = (node: MarkdownNode) => {
      if (!node.children || ['code', 'inlineCode', 'html'].includes(node.type)) return
      node.children = node.children.flatMap(child => {
        if (child.type === 'image' && child.position?.start.offset !== undefined && child.position.end.offset !== undefined) {
          const token = parseImageEmbed(source.slice(child.position.start.offset, child.position.end.offset))
          if (token && 'preserveSource' in token && token.preserveSource) child.url = token.href
        }
        if (child.type === 'html' && child.value && typeof DOMParser !== 'undefined') {
          const body = new DOMParser().parseFromString(child.value, 'text/html').body
          if (body.children.length === 1 && body.firstElementChild?.tagName === 'IMG' && !body.textContent?.trim()) {
            const image = body.firstElementChild
            return [{ type: 'image', url: image.getAttribute('src') ?? '', alt: image.getAttribute('alt') ?? '', data: { hProperties: { width: image.getAttribute('width'), height: image.getAttribute('height') } } }]
          }
        }
        if (child.type !== 'text' || !child.value?.includes('![')) { visit(child); return [child] }
        const original = child.position?.start.offset !== undefined && child.position.end.offset !== undefined
          ? source.slice(child.position.start.offset, child.position.end.offset) : ''
        const wikiReferences = [...original.matchAll(/!\[\[[^\r\n]+?\]\]/g)].map(match => parseImageEmbed(match[0]))
        const result: MarkdownNode[] = []; let text = child.value, consumed = 0
        for (let offset = 0; offset < text.length; offset++) {
          const token = parseImageEmbed(text.slice(offset))
          if (!token) continue
          const originalWiki = token.wiki ? wikiReferences.shift() : undefined
          const reference = originalWiki?.wiki ? originalWiki : token
          if (offset > consumed) result.push({ type: 'text', value: text.slice(consumed, offset) })
          result.push({ type: 'image', url: reference.href, alt: reference.text, data: { hProperties: { 'data-wiki-image': reference.wiki, width: reference.width, height: reference.height } } })
          offset += token.raw.length - 1; consumed = offset + 1
        }
        if (consumed < text.length) result.push({ type: 'text', value: text.slice(consumed) })
        return result
      })
    }
    visit(tree)
  }
}

export function remarkLocalImagePaths() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === 'image' && /^(?:[a-z]:[\\/]|file:)/i.test(node.url ?? '')) {
        const data = node.data as { hProperties?: Record<string, unknown> } | undefined
        node.data = { ...data, hProperties: { ...data?.hProperties, dataLocalImage: node.url } }
        // Keep the file reference out of browser URL handling; native resolution validates it.
        node.url = '#notechain-local-image'
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
