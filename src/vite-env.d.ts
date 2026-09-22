/// <reference types="vite/client" />

interface DesktopBridge {
  manageNotch?: () => Promise<void>
  imageUrl?: (src: string) => string
  platform: string
  minimize: () => void
  maximize: () => void
  close: () => void
  manageBrowser?: () => Promise<void>
  importImage?: (input: { bytes: Uint8Array; name: string }) => Promise<{ src: string; name: string }>
  chooseImages?: () => Promise<Array<{ src: string; name: string }>>
  readImage?: (src: string) => Promise<{ bytes: Uint8Array; mime: string }>
  exportPdf?: (input: { title: string; html: string }) => Promise<{ cancelled: boolean; path?: string }>
  onBrowserRequest?: (handler: (request: { id: string; method: string; payload: unknown }) => void) => () => void
  replyBrowser?: (reply: { id: string; value?: unknown; error?: { status: number; message: string } }) => void
}

interface Window {
  __ledgerTest?: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>; flush: () => Promise<void>; ledger?: unknown; navigate?: (path: string) => void; timings?: Record<string, Record<string, number>> }
  assetLedgerDesktop?: DesktopBridge
}
