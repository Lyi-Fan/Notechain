import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeSanitize from 'rehype-sanitize'

export function notePrintHtml(title: string, markdown: string) {
  return renderToStaticMarkup(<article><h1>{title}</h1><ReactMarkdown
    remarkPlugins={[remarkGfm, remarkBreaks]}
    rehypePlugins={[rehypeSanitize]}
    components={{ img({ src, alt }) {
      if (!src || !/^\/attachments\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(src)) {
        throw new Error('请先将外链或本机路径的图片导入笔记，再导出 PDF')
      }
      return <img src={`asset-ledger://app${src}`} alt={alt ?? ''} />
    } }}
  >{markdown}</ReactMarkdown></article>)
}
