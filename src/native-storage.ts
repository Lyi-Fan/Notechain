import type { AppState } from './types'

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
type Operation = { key: string; value: string } | { kind: string; id: string; record?: unknown; position?: number; delete?: boolean }
export let nativeInvoke: Invoke | undefined
export let nativeInitialState: AppState | null = null
const preferences = new Map<string, string>()
let pending: Operation[] = []
let running: Promise<void> | undefined
let error: unknown

export function configureNative(invoke: Invoke, initial: { state: AppState | null; kv: Record<string, string> }) {
  nativeInvoke = invoke
  nativeInitialState = initial.state
  for (const [key, value] of Object.entries(initial.kv)) preferences.set(key, value)
}

export function enqueueNative(operations: Operation[]) {
  pending.push(...operations)
  if (!running) void flushNative().catch(() => {})
}

export async function flushNative(): Promise<void> {
  if (!nativeInvoke) return
  if (running) { await running; if (pending.length) await flushNative(); return }
  running = (async () => {
    while (pending.length) {
      const batch = pending.splice(0)
      try {
        await nativeInvoke!('save_changes', { operations: batch })
        error = undefined
        window.dispatchEvent(new Event('ledger-storage-saved'))
      } catch (failure) {
        pending.unshift(...batch)
        error = failure
        window.dispatchEvent(new CustomEvent('ledger-storage-error', { detail: String(failure) }))
        throw failure
      }
    }
  })()
  try { await running } finally { running = undefined; if (pending.length && !error) void flushNative().catch(() => {}) }
  if (error) throw error
}

export const ledgerStorage = {
  getItem(key: string): string | null { return nativeInvoke ? preferences.get(key) ?? null : localStorage.getItem(key) },
  setItem(key: string, value: string) {
    if (!nativeInvoke) { localStorage.setItem(key, value); return }
    preferences.set(key, value)
    enqueueNative([{ key, value }])
  },
}

const kinds = ['cases', 'assets', 'targets', 'findings', 'tasks', 'relations'] as const
function cacheTransition(before: object, after: object) {
  const a = before as Record<string, unknown>, b = after as Record<string, unknown>
  if (Boolean(a._bodyPending) === Boolean(b._bodyPending)) return false
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(key => key === 'noteMarkdown' || key === '_bodyPending' || a[key] === b[key])
}
export function createNativeWriter() {
  let previous = nativeInitialState
  let activity = previous ? JSON.stringify({ reading: previous.reading, lastLocation: previous.lastLocation }) : ''
  return {
    writeContent(next: AppState, _strict = false) {
      const operations: Operation[] = []
      for (const kind of kinds) {
        if (next[kind] === previous?.[kind]) continue
        const old = new Map(previous?.[kind].map((record, position) => [record.id, { record, position }]))
        next[kind].forEach((record, position) => {
          const saved = old.get(record.id)
          if (position !== saved?.position || (record !== saved?.record && (!saved || !cacheTransition(saved.record, record)))) operations.push({ kind, id: record.id, record, position })
          old.delete(record.id)
        })
        for (const id of old.keys()) operations.push({ kind, id, delete: true })
      }
      if (next.theme !== previous?.theme) operations.push({ key: 'theme', value: next.theme })
      previous = next
      if (operations.length) enqueueNative(operations)
    },
    writeActivity(next: Pick<AppState, 'reading' | 'lastLocation'>) {
      const value = JSON.stringify({ reading: next.reading, lastLocation: next.lastLocation })
      if (value !== activity) { activity = value; enqueueNative([{ key: 'activity', value }]) }
    },
  }
}
