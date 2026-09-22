import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useLedger } from './store'
import { ledgerStorage } from './native-storage'
import { flushEditors } from './file-notebooks'

const STORAGE_KEY = 'asset-ledger-reading-history-v1'
const MAX_ENTRIES = 80

type ReadingHistory = { entries: string[]; index: number }

interface NavigationContextValue {
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
}

const NavigationContext = createContext<NavigationContextValue | null>(null)

const routeOf = ({ pathname, search, hash }: { pathname: string; search: string; hash: string }) => `${pathname}${search}${hash}`
const isInternalRoute = (route: string) => (route === '/' || route.startsWith('/cases/') || route === '/notebooks' || route.startsWith('/notebooks/')) && !route.startsWith('//') && !route.includes('\\')
const browserHistoryIndex = () => {
  const index = (window.history.state as { idx?: unknown } | null)?.idx
  return typeof index === 'number' ? index : null
}

function loadHistory(): ReadingHistory | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY) ?? ledgerStorage.getItem(STORAGE_KEY)
    if (!value) return null
    const parsed = JSON.parse(value) as ReadingHistory
    if (!Array.isArray(parsed.entries) || !parsed.entries.every((entry) => typeof entry === 'string') || !Number.isInteger(parsed.index)) return null
    if (parsed.index < 0 || parsed.index >= parsed.entries.length) return null
    const activeBeforeTrim = parsed.entries.slice(0, parsed.index + 1).filter(isInternalRoute).length - 1
    const validEntries = parsed.entries.filter(isInternalRoute)
    if (!validEntries.length || activeBeforeTrim < 0) return null
    const omitted = Math.max(0, validEntries.length - MAX_ENTRIES)
    const entries = validEntries.slice(omitted)
    const index = activeBeforeTrim - omitted
    if (index < 0 || index >= entries.length) return null
    return { entries, index }
  } catch {
    return null
  }
}

function persistHistory(history: ReadingHistory) {
  try {
    const serialized = JSON.stringify(history)
    sessionStorage.setItem(STORAGE_KEY, serialized)
    ledgerStorage.setItem(STORAGE_KEY, serialized)
  } catch {
    // Navigation still works when storage is unavailable.
  }
}

export function ReadingNavigationProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const { state, cases, assets } = useLedger()
  const currentRoute = routeOf(location)
  const pendingIndex = useRef<number | null>(null)
  const nativeIndexByReadingIndex = useRef(new Map<number, { route: string; nativeIndex: number }>())
  const initialized = useRef(false)
  const [history, setHistory] = useState<ReadingHistory>(() => {
    const saved = loadHistory()
    const last = state.lastLocation
    const lastCase = last && cases.find((item) => item.id === last.caseId && item.status !== 'archived')
    const lastAssetExists = Boolean(last?.assetId && lastCase?.assetIds.includes(last.assetId) && assets.some((asset) => asset.id === last.assetId && !asset.deletedAt))
    const fallback = lastAssetExists ? `/cases/${last!.caseId}/assets/${last!.assetId}` : null

    if (saved) {
      const match = saved.entries.lastIndexOf(currentRoute)
      if (match >= 0) return { ...saved, index: match }
      const entries = [...saved.entries.slice(0, saved.index + 1), currentRoute].slice(-MAX_ENTRIES)
      return { entries, index: entries.length - 1 }
    }
    if (fallback && fallback !== currentRoute) return { entries: [fallback, currentRoute], index: 1 }
    return { entries: [currentRoute], index: 0 }
  })

  useEffect(() => { persistHistory(history) }, [history])

  useEffect(() => {
    if (history.entries[history.index] !== currentRoute) return
    const nativeIndex = browserHistoryIndex()
    if (nativeIndex !== null) nativeIndexByReadingIndex.current.set(history.index, { route: currentRoute, nativeIndex })
  }, [currentRoute, history])

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      return
    }
    const requestedIndex = pendingIndex.current
    pendingIndex.current = null
    const currentNativeIndex = browserHistoryIndex()
    setHistory((current) => {
      if (requestedIndex !== null && current.entries[requestedIndex] === currentRoute) {
        return requestedIndex === current.index ? current : { ...current, index: requestedIndex }
      }
      if (current.entries[current.index] === currentRoute) return current
      if (navigationType === 'POP') {
        const matches = current.entries.map((entry, index) => entry === currentRoute ? index : -1).filter((index) => index >= 0)
        if (matches.length) {
          const nativeMatch = currentNativeIndex === null ? undefined : matches.find((candidate) => {
            const binding = nativeIndexByReadingIndex.current.get(candidate)
            return binding?.route === currentRoute && binding.nativeIndex === currentNativeIndex
          })
          const index = nativeMatch ?? matches.reduce((closest, candidate) => Math.abs(candidate - current.index) < Math.abs(closest - current.index) ? candidate : closest)
          return { ...current, index }
        }
      }
      const untrimmedEntries = [...current.entries.slice(0, current.index + 1), currentRoute]
      const entries = untrimmedEntries.slice(-MAX_ENTRIES)
      return { entries, index: entries.length - 1 }
    })
  }, [currentRoute, navigationType])

  const goTo = useCallback((index: number) => {
    const target = history.entries[index]
    if (!target) return
    void flushEditors(true).then(() => {
    pendingIndex.current = index
    const currentNativeIndex = browserHistoryIndex()
    const targetBinding = nativeIndexByReadingIndex.current.get(index)
    if (currentNativeIndex !== null && targetBinding?.route === target) {
      navigate(targetBinding.nativeIndex - currentNativeIndex)
    } else {
      navigate(target)
    }
    })
  }, [history.entries, navigate])

  const value = useMemo<NavigationContextValue>(() => ({
    canGoBack: history.index > 0,
    canGoForward: history.index < history.entries.length - 1,
    goBack: () => goTo(history.index - 1),
    goForward: () => goTo(history.index + 1),
  }), [goTo, history.index, history.entries.length])

  if (window.__ledgerTest) window.__ledgerTest.navigate = (path) => navigate(path)
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export function useReadingNavigation() {
  const context = useContext(NavigationContext)
  if (!context) throw new Error('useReadingNavigation must be used inside ReadingNavigationProvider')
  return context
}
