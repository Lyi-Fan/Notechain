import { configureNative, flushNative, nativeInvoke } from './native-storage'
import { flushNoteFiles } from './file-notebooks'

export function desktopBridge() { return window.assetLedgerDesktop }

export async function writeClipboardText(text: string) {
  if (nativeInvoke) await nativeInvoke('write_clipboard', { text })
  else await navigator.clipboard.writeText(text)
}

export async function openExternalUrl(url: string) {
  if (nativeInvoke) await nativeInvoke('open_external', { url })
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export async function initializePlatform() {
  if (!('__TAURI_INTERNALS__' in window)) return
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  configureNative(invoke, await invoke('load_index'))
  const runtime = await invoke<{ qa: boolean; platform: string }>('runtime_info')
  const isMac = runtime.platform === 'macos'
  if (runtime.qa) window.__ledgerTest = { invoke, flush: async () => { await flushNoteFiles(); await flushNative() } }
  const report = (work: Promise<unknown>) => { void work.catch((failure) => { window.dispatchEvent(new CustomEvent('ledger-native-error', { detail: String(failure) })) }) }
  const handlers = new Set<(request: { id: string; method: string; payload: unknown }) => void>()
  await listen<{ id: string; method: string; payload: unknown }>('ledger-browser-request', ({ payload }) => { for (const handler of handlers) handler(payload) })
  const close = async (quit = !isMac) => {
    window.dispatchEvent(new Event('ledger-flush-editors'))
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    await new Promise(resolve => setTimeout(resolve, 0))
    await flushNoteFiles()
    await flushNative()
    if (quit) await invoke('finish_quit')
    else await invoke('window_action', { action: 'close' })
  }
  await listen<{ quit: boolean }>('ledger-close', ({ payload }) => report(close(payload.quit)))
  if (isMac) await listen<{ enabled: boolean }>('ledger-notch-status', ({ payload }) => {
    document.documentElement.dataset.notchConnected = String(payload.enabled)
  })
  window.assetLedgerDesktop = {
    platform: isMac ? 'darwin' : 'win32',
    manageNotch: isMac ? async () => {
      try {
        const state = await invoke<{ enabled: boolean }>('notch_status')
        await invoke('notch_connect', { enabled: !state.enabled })
        document.documentElement.dataset.notchConnected = String(!state.enabled)
      } catch (error) { window.dispatchEvent(new CustomEvent('ledger-native-error', { detail: String(error) })) }
    } : undefined,
    imageUrl: (src) => convertFileSrc(src.slice('/attachments/'.length), 'ledger-image'),
    minimize: () => report(invoke('window_action', { action: 'minimize' })),
    maximize: () => report(invoke('window_action', { action: 'maximize' })),
    close: () => report(close()),
    manageBrowser: async () => { try { await invoke('manage_browser') } catch (failure) { window.dispatchEvent(new CustomEvent('ledger-native-error', { detail: String(failure) })) } },
    importImage: ({ bytes, name }) => invoke('import_image', { bytes: Array.from(bytes), name }),
    chooseImages: () => invoke('choose_images'),
    readImage: async (src) => {
      const result = await invoke<{ base64: string; mime: string }>('read_image', { src })
      return { bytes: Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)), mime: result.mime }
    },
    exportPdf: (input) => invoke('export_pdf', input),
    onBrowserRequest: (handler) => { handlers.add(handler); return () => { handlers.delete(handler) } },
    replyBrowser: (reply) => report(invoke('reply_browser', { reply })),
  }
  document.documentElement.dataset.platform = isMac ? 'mac' : 'windows'
  // Keep background capture IPC responsive without animating an invisible window.
  const paused = new Set<Animation>()
  const pauseHiddenAnimations = () => {
    for (const animation of paused) if (animation.playState === 'idle' || animation.playState === 'finished') paused.delete(animation)
    for (const animation of document.getAnimations()) if (animation.playState === 'running') { animation.pause(); paused.add(animation) }
  }
  const animationObserver = new MutationObserver(() => { if (document.hidden) pauseHiddenAnimations() })
  const visibility = () => {
    if (document.hidden) { pauseHiddenAnimations(); animationObserver.observe(document.documentElement, { childList: true, subtree: true }) }
    else { animationObserver.disconnect(); for (const animation of paused) if (animation.playState === 'paused') animation.play(); paused.clear() }
  }
  document.addEventListener('visibilitychange', visibility)
  visibility()
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null
    if (link?.target === '_blank' && /^(https?:|mailto:)/.test(link.href)) {
      event.preventDefault(); report(invoke('open_external', { url: link.href }))
    }
  })
}
