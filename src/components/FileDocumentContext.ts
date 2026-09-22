import { createContext } from 'react'
import type { LinkTarget } from '../notebook-links'

export const FileDocumentContext = createContext<null | {
  title: string
  restoredDraft: boolean
  linkChoices: () => { id: string; title: string; value: string; href: string; caseId?: string }[]
  onDraft: (content: string) => void
  resolveLink: (value: string) => LinkTarget | null
  openLink: (value: string) => boolean
  importImage: (file: File) => Promise<{ src: string; name: string }>
  resolveImage: (src: string) => Promise<{ url: string; revoke?: () => void }>
}>(null)
