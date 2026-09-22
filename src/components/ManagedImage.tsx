import { useContext, useEffect, useState, type ComponentPropsWithoutRef } from 'react'
import { FileDocumentContext } from './FileDocumentContext'
import Image from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { resolveImage } from '../images'

type ImageState = { status: 'loading' } | { status: 'ready'; url: string; revoke?: () => void } | { status: 'error' }

function ResolvedImage({ src, alt, title, className }: Pick<ComponentPropsWithoutRef<'img'>, 'src' | 'alt' | 'title' | 'className'>) {
  const file = useContext(FileDocumentContext)
  const [state, setState] = useState<ImageState>({ status: 'loading' })
  useEffect(() => {
    let disposed = false
    let revoke: (() => void) | undefined
    setState({ status: 'loading' })
    const request = file ? file.resolveImage(src ?? '') : resolveImage(src ?? '')
    request.then((result) => {
      revoke = result.revoke
      if (disposed) { revoke?.(); return }
      setState({ status: 'ready', ...result })
    }).catch(() => { if (!disposed) setState({ status: 'error' }) })
    return () => { disposed = true; revoke?.() }
  }, [src, file])
  if (state.status === 'error') return <span role="status" className="managed-image-error">图片无法显示，请重新导入</span>
  if (state.status === 'loading') return <span role="status" className="managed-image-loading">正在载入图片…</span>
  return <img src={state.url} alt={alt ?? ''} title={title} className={className} loading="lazy" decoding="async" onError={() => setState({ status: 'error' })} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
}

function ManagedImageNodeView({ node }: NodeViewProps) {
  return <NodeViewWrapper as="figure" className="managed-image" contentEditable={false} style={{ margin: '12px 0', maxWidth: '100%' }}>
    <ResolvedImage src={String(node.attrs.src ?? '')} alt={node.attrs.alt ?? ''} title={node.attrs.title ?? undefined} />
  </NodeViewWrapper>
}

export const ManagedImage = Image.extend({
  addNodeView() { return ReactNodeViewRenderer(ManagedImageNodeView) },
}).configure({ allowBase64: false })

export function ManagedImageView({ src, alt, title, className }: ComponentPropsWithoutRef<'img'>) {
  return <ResolvedImage src={src} alt={alt} title={title} className={className} />
}
