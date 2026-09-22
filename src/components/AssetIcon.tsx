import { Globe2, Network, Server, FileCode2, PanelsTopLeft } from 'lucide-react'
import type { AssetKind } from '../types'

const icons = { url: PanelsTopLeft, domain: Globe2, ip: Network, service: Server, endpoint: FileCode2 }

export function AssetIcon({ kind, size = 18 }: { kind: AssetKind; size?: number }) {
  const Icon = icons[kind]
  return <Icon size={size} strokeWidth={1.7} aria-hidden="true" />
}
