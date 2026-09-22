import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { browserContext, type BrowserCapture } from '../browser-capture'
import { useLedger } from '../store'
import { flushNative, ledgerStorage } from '../native-storage'

interface TrayAccess {
  notch?: (method: string, payload: Record<string, unknown>) => Promise<unknown>
  list: (offset: number, limit: number) => unknown
  capture: (input: BrowserCapture) => string
  remove: (id: string) => void
}

export function BrowserCaptureBridge({ tray }: { tray: TrayAccess }) {
  const ledger = useLedger()
  const { pathname } = useLocation()
  const current = useRef<string | null>(null)
  const data = useRef({ ledger, tray })
  data.current = { ledger, tray }
  useEffect(() => {
    const match = pathname.match(/^\/cases\/([^/]+)/)
    if (match) {
      current.current = decodeURIComponent(match[1])
      try { ledgerStorage.setItem('asset-ledger-browser-case-v1', current.current) } catch { /* Route remains available during this session. */ }
    } else if (!current.current) {
      try { current.current = ledgerStorage.getItem('asset-ledger-browser-case-v1') } catch { /* Fall back to reading history. */ }
    }
  }, [pathname])
  useEffect(() => {
    const bridge = window.assetLedgerDesktop
    return bridge?.onBrowserRequest?.(async (request) => {
      try {
        const { ledger: latest, tray: transfer } = data.current
        let value: unknown
        if (request.method === 'architecture') {
          const { architectureRequest } = await import('../architecture/api')
          value = await architectureRequest(latest, request.payload)
        } else if (request.method.startsWith('notch-') && transfer.notch) {
          value = await transfer.notch(request.method.slice(6), request.payload as Record<string, unknown>)
        } else if (request.method === 'context') {
          // A popup may request context before the route effect has caught up.
          const route = window.location.pathname.match(/^\/cases\/([^/]+)/)
          value = browserContext(latest.state, route ? decodeURIComponent(route[1]) : current.current)
        }
        else if (request.method === 'tray') {
          const { offset, limit } = request.payload as { offset: number; limit: number }
          value = transfer.list(offset, limit)
        } else if (request.method === 'capture') {
          const input = request.payload as BrowserCapture
          flushSync(() => { value = { ok: true, id: input.mode === 'asset' ? latest.captureBrowserAsset(input) : transfer.capture(input), kind: input.mode } })
        } else if (request.method === 'tray-remove') {
          flushSync(() => transfer.remove((request.payload as { id: string }).id))
          value = { ok: true }
        } else throw new Error('Unsupported request')
        await flushNative()
        bridge.replyBrowser?.({ id: request.id, value })
      } catch (error) {
        const known = error as { status?: number; message?: string }
        bridge.replyBrowser?.({ id: request.id, error: { status: known.status ?? 503, message: known.status ? known.message ?? '收集失败' : '本地保存失败，请检查可用存储空间' } })
      }
    })
  }, [])
  return null
}
