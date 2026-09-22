import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createEmptyState } from './data'
import type { AppState, AssetRecord, CaseRecord, FindingRecord, LastLocation, ReadingState, RelationRecord, TargetRecord, TaskRecord } from './types'

import { createSnapshotWriter, loadSnapshot } from './persistence'
import { captureAsset, type BrowserCapture } from './browser-capture'
import { maskSecret } from './secrets'
import { createNativeWriter, flushNative, nativeInitialState, nativeInvoke } from './native-storage'
import { captureTextSource, type TextCapture, type TransferClip } from './transfer-reference'
import { applyGraphPatch } from './architecture/operations'
import type { NoteFacts } from './architecture/model'

type BodyKind = 'assets' | 'cases' | 'findings'

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const stamp = () => new Date().toISOString()
const loadState = (): AppState => {
  if (nativeInvoke) return nativeInitialState ?? createEmptyState()
  try {
    const saved = loadSnapshot(localStorage)
    if (saved) return saved
  } catch {
    // Corrupt local state should never prevent the app from opening.
  }
  return createEmptyState()
}

interface LedgerContextValue {
  applyArchitecture: (caseId: string, patch: unknown, facts?: Map<string, NoteFacts>) => { revision: number; replayed: boolean }
  getState: () => AppState
  captureText: (input: TextCapture) => TransferClip
  retainBody: (kind: BodyKind, id: string) => () => void
  state: AppState
  cases: CaseRecord[]
  assets: AssetRecord[]
  targets: TargetRecord[]
  findings: FindingRecord[]
  tasks: TaskRecord[]
  relations: AppState['relations']
  addCase: (input: Pick<CaseRecord, 'name' | 'code' | 'summary' | 'priority' | 'tags'>) => string
  updateCase: (id: string, patch: Partial<CaseRecord>) => void
  addTarget: (input: Pick<TargetRecord, 'name' | 'kind' | 'identifier' | 'note'>, caseId?: string) => string
  updateTarget: (id: string, patch: Partial<Pick<TargetRecord, 'name'>>) => void
  setCategoryDeleted: (caseId: string, targetId: string, deleted: boolean) => void
  addAsset: (input: Omit<AssetRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'relationIds' | 'findingIds'>) => string
  updateAsset: (id: string, patch: Partial<AssetRecord>) => void
  softDeleteAsset: (id: string) => void
  addFinding: (input: Omit<FindingRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'maskedValue'>) => string
  updateFinding: (id: string, patch: Partial<FindingRecord>) => void
  addRelation: (input: Omit<RelationRecord, 'id'>) => string
  removeRelation: (id: string) => void
  updateTask: (id: string, patch: Partial<TaskRecord>) => void
  setReadingState: (reading: ReadingState) => void
  setLastLocation: (location: LastLocation | null) => void
  setTheme: (theme: AppState['theme']) => void
  captureBrowserAsset: (input: BrowserCapture) => string
}

const LedgerContext = createContext<LedgerContextValue | null>(null)

export function LedgerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(loadState)
  const latestState = useRef(state)
  latestState.current = state
  const bodyPins = useRef(new Map<string, number>())
  const bodyRequests = useRef(new Map<string, Promise<void>>())
  const bodyCache = useRef<string[]>([])
  const writer = useRef<ReturnType<typeof createSnapshotWriter>>()
  if (!writer.current) writer.current = nativeInvoke ? createNativeWriter() : createSnapshotWriter({ setItem: (key, value) => localStorage.setItem(key, value) })
  const [storageError, setStorageError] = useState(false)
  const [nativeError, setNativeError] = useState('')

  const retainBody = useCallback((kind: BodyKind, id: string) => {
    if (!nativeInvoke || !id) return () => {}
    const key = `${kind}:${id}`
    bodyPins.current.set(key, (bodyPins.current.get(key) ?? 0) + 1)
    bodyCache.current = [key, ...bodyCache.current.filter(item => item !== key)]
    const record = latestState.current[kind].find(item => item.id === id)
    if (window.__ledgerTest) {
      window.__ledgerTest.timings ??= {}
      window.__ledgerTest.timings[key] = { retained: performance.now(), cached: record?._bodyPending ? 0 : 1 }
    }
    if (record?._bodyPending && !bodyRequests.current.has(key)) {
      const request = flushNative().then(() => {
        const timing = window.__ledgerTest?.timings?.[key]
        if (timing) timing.flushed = performance.now()
        return nativeInvoke!<string | null>('read_body', { kind, id })
      }).then(body => {
        const timing = window.__ledgerTest?.timings?.[key]
        if (timing) timing.received = performance.now()
        if (!bodyCache.current.includes(key) && !bodyPins.current.get(key)) return
        setState(current => ({ ...current, [kind]: current[kind].map(item => item.id === id && item._bodyPending ? { ...item, noteMarkdown: body ?? undefined, _bodyPending: undefined } : item) }))
      }).catch(() => { setNativeError('正文读取失败，请重新打开这篇笔记。') }).finally(() => { bodyRequests.current.delete(key) })
      bodyRequests.current.set(key, request)
    }
    return () => {
      const pins = (bodyPins.current.get(key) ?? 1) - 1
      if (pins > 0) bodyPins.current.set(key, pins)
      else bodyPins.current.delete(key)
      const evicted = bodyCache.current.filter((item, index) => index >= 8 && !bodyPins.current.get(item))
      if (!evicted.length) return
      bodyCache.current = bodyCache.current.filter(item => !evicted.includes(item))
      void flushNative().then(() => setState(current => {
        const next = { ...current }
        for (const kind of ['assets', 'cases', 'findings'] as const) {
          Object.assign(next, { [kind]: current[kind].map(item => {
            if (!evicted.includes(`${kind}:${item.id}`) || bodyPins.current.get(`${kind}:${item.id}`) || item.noteMarkdown === undefined) return item
            const { noteMarkdown: _body, ...metadata } = item
            return { ...metadata, _bodyPending: true }
          }) })
        }
        return next
      })).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const failed = () => setStorageError(true)
    const saved = () => setStorageError(false)
    const nativeFailed = (event: Event) => setNativeError(String((event as CustomEvent).detail))
    window.addEventListener('ledger-storage-error', failed)
    window.addEventListener('ledger-storage-saved', saved)
    window.addEventListener('ledger-native-error', nativeFailed)
    if (nativeInvoke) void flushNative().then(() => nativeInvoke!<{ bridgeError?: string }>('client_ready')).then(result => { if (result.bridgeError) setNativeError(result.bridgeError) }).catch(failed)
    return () => { window.removeEventListener('ledger-storage-error', failed); window.removeEventListener('ledger-storage-saved', saved); window.removeEventListener('ledger-native-error', nativeFailed) }
  }, [])

  useEffect(() => {
    writer.current!.writeContent(state)
    writer.current!.writeActivity(state)
  }, [state])
  useEffect(() => { document.documentElement.dataset.theme = state.theme }, [state.theme])

  const addCase = useCallback((input: Pick<CaseRecord, 'name' | 'code' | 'summary' | 'priority' | 'tags'>) => {
    const id = uid('case')
    const time = stamp()
    const record: CaseRecord = {
      ...input, id, status: 'planning', progress: 0, targetIds: [], assetIds: [], findingIds: [], taskIds: [], timeline: [], createdAt: time, updatedAt: time,
    }
    setState((current) => ({ ...current, cases: [record, ...current.cases] }))
    return id
  }, [])

  const updateCase = useCallback((id: string, patch: Partial<CaseRecord>) => {
    setState((current) => ({ ...current, cases: current.cases.map((item) => item.id === id ? { ...item, ...patch, updatedAt: stamp() } : item) }))
  }, [])

  const addTarget = useCallback((input: Pick<TargetRecord, 'name' | 'kind' | 'identifier' | 'note'>, caseId?: string) => {
    const id = uid('tgt')
    setState((current) => ({
      ...current,
      targets: [...current.targets, { ...input, id }],
      cases: caseId ? current.cases.map((item) => item.id === caseId ? { ...item, targetIds: [...item.targetIds, id], updatedAt: stamp() } : item) : current.cases,
    }))
    return id
  }, [])

  const addAsset = useCallback((input: Omit<AssetRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'relationIds' | 'findingIds'>) => {
    const id = uid('ast')
    const time = stamp()
    const record: AssetRecord = { ...input, id, relationIds: [], findingIds: [], createdAt: time, updatedAt: time, version: 1 }
    setState((current) => ({
      ...current,
      assets: [record, ...current.assets],
      cases: current.cases.map((item) => item.id === input.caseId ? { ...item, assetIds: [id, ...item.assetIds], updatedAt: time } : item),
    }))
    return id
  }, [])

  const updateTarget = useCallback((id: string, patch: Partial<Pick<TargetRecord, 'name'>>) => {
    setState((current) => ({ ...current,
      targets: current.targets.map((target) => target.id === id ? { ...target, ...patch } : target),
      cases: current.cases.map((item) => item.targetIds.includes(id) ? { ...item, updatedAt: stamp() } : item),
    }))
  }, [])

  // Category deletion is case-local. Keep asset associations for restoration
  // and for other cases that reference the same target or asset.
  const setCategoryDeleted = useCallback((caseId: string, targetId: string, deleted: boolean) => {
    setState((current) => ({ ...current, cases: current.cases.map((item) => item.id !== caseId ? item : {
      ...item,
      targetIds: deleted ? item.targetIds.filter((id) => id !== targetId) : [...new Set([...item.targetIds, targetId])],
      deletedTargetIds: deleted ? [...new Set([...(item.deletedTargetIds ?? []), targetId])] : (item.deletedTargetIds ?? []).filter((id) => id !== targetId),
      updatedAt: stamp(),
    }) }))
  }, [])

  const updateAsset = useCallback((id: string, patch: Partial<AssetRecord>) => {
    const time = stamp()
    setState((current) => ({
      ...current,
      assets: current.assets.map((item) => item.id === id ? { ...item, ...patch, version: item.version + 1, updatedAt: time } : item),
      cases: current.cases.map((item) => item.assetIds.includes(id) ? { ...item, updatedAt: time } : item),
    }))
  }, [])

  const softDeleteAsset = useCallback((id: string) => updateAsset(id, { deletedAt: stamp() }), [updateAsset])

  const addFinding = useCallback((input: Omit<FindingRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'maskedValue'>) => {
    const id = uid('fnd')
    const time = stamp()
    const record: FindingRecord = { ...input, id, maskedValue: input.value ? maskSecret(input.value) : undefined, createdAt: time, updatedAt: time, version: 1 }
    setState((current) => ({
      ...current,
      findings: [record, ...current.findings],
      assets: current.assets.map((asset) => asset.id === input.sourceAssetId ? { ...asset, findingIds: [id, ...asset.findingIds], updatedAt: time } : asset),
      cases: current.cases.map((item) => item.id === input.caseId ? { ...item, findingIds: [id, ...item.findingIds], updatedAt: time } : item),
    }))
    return id
  }, [])

  const updateFinding = useCallback((id: string, patch: Partial<FindingRecord>) => {
    const time = stamp()
    setState((current) => ({ ...current, findings: current.findings.map((item) => item.id === id ? { ...item, ...patch, maskedValue: Object.prototype.hasOwnProperty.call(patch, 'value') ? (patch.value ? maskSecret(patch.value) : undefined) : item.maskedValue, version: item.version + 1, updatedAt: time } : item) }))
  }, [])

  const addRelation = useCallback((input: Omit<RelationRecord, 'id'>) => {
    const id = uid('rel')
    const record: RelationRecord = { ...input, id }
    setState((current) => ({
      ...current,
      relations: [record, ...current.relations],
      assets: current.assets.map((asset) => {
        if (asset.id !== input.sourceId && asset.id !== input.targetId) return asset
        return asset.relationIds.includes(id) ? asset : { ...asset, relationIds: [id, ...asset.relationIds], updatedAt: stamp() }
      }),
    }))
    return id
  }, [])

  const removeRelation = useCallback((id: string) => {
    setState((current) => {
      const relation = current.relations.find((item) => item.id === id)
      if (!relation) return current
      return {
        ...current,
        relations: current.relations.filter((item) => item.id !== id),
        assets: current.assets.map((asset) => asset.relationIds.includes(id) ? { ...asset, relationIds: asset.relationIds.filter((item) => item !== id), updatedAt: stamp() } : asset),
      }
    })
  }, [])

  const updateTask = useCallback((id: string, patch: Partial<TaskRecord>) => setState((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === id ? { ...item, ...patch } : item) })), [])

  const setReadingState = useCallback((reading: ReadingState) => setState((current) => {
    const next = { ...current, reading: { ...current.reading, [reading.assetId]: reading } }
    // Closing/navigation must flush reading without serializing every note.
    writer.current!.writeActivity(next)
    return next
  }), [])
  const setLastLocation = useCallback((lastLocation: LastLocation | null) => setState((current) => {
    const next = { ...current, lastLocation }
    writer.current!.writeActivity(next)
    return next
  }), [])
  const setTheme = useCallback((theme: AppState['theme']) => setState((current) => ({ ...current, theme })), [])
  const getState = useCallback(() => latestState.current, [])
  const applyArchitecture = useCallback((caseId: string, patch: unknown, facts?: Map<string, NoteFacts>) => {
    const result = applyGraphPatch(latestState.current, caseId, patch, facts)
    writer.current!.writeContent(result.state, true)
    latestState.current = result.state
    setState(result.state)
    return { revision: result.revision, replayed: result.replayed }
  }, [])
  const captureBrowserAsset = useCallback((input: BrowserCapture) => {
    const captured = captureAsset(state, input)
    // A capture acknowledgement means persisted, not merely scheduled in React.
    writer.current!.writeContent(captured.state, true)
    setState(captured.state)
    return captured.id
  }, [state])
  const captureText = useCallback((input: TextCapture) => {
    const captured = captureTextSource(latestState.current, input)
    writer.current!.writeContent(captured.state, true)
    setState(captured.state)
    return captured.clip
  }, [])

  const cases = useMemo(() => state.cases.filter((item) => !item.deletedAt), [state.cases])
  const assets = useMemo(() => state.assets.filter((item) => !item.deletedAt), [state.assets])

  const value = useMemo<LedgerContextValue>(() => ({
    applyArchitecture, getState,
    captureText,
    retainBody,
    state,
    cases,
    assets,
    targets: state.targets,
    findings: state.findings,
    tasks: state.tasks,
    relations: state.relations,
    addCase, updateCase, addTarget, updateTarget, setCategoryDeleted, addAsset, updateAsset, softDeleteAsset, addFinding, updateFinding, addRelation, removeRelation, updateTask, setReadingState, setLastLocation, setTheme, captureBrowserAsset,
  }), [state, cases, assets, addCase, updateCase, addTarget, updateTarget, setCategoryDeleted, addAsset, updateAsset, softDeleteAsset, addFinding, updateFinding, addRelation, removeRelation, updateTask, setReadingState, setLastLocation, setTheme, captureBrowserAsset, applyArchitecture, getState])

  if (window.__ledgerTest) window.__ledgerTest.ledger = value
  return <LedgerContext.Provider value={value}>{children}{storageError && <div className="notebook-toast" role="alert">本地保存失败，最新修改尚未保存。<button onClick={() => { void flushNative().catch(() => {}) }}>重试保存</button></div>}{nativeError && <div className="notebook-toast" role="alert" onClick={() => setNativeError('')}>{nativeError}</div>}</LedgerContext.Provider>
}

export function useLedger() {
  const context = useContext(LedgerContext)
  if (!context) throw new Error('useLedger must be used inside LedgerProvider')
  return context
}

export { maskSecret }

export function useNoteReady(kind: BodyKind, id: string) {
  const { state, retainBody } = useLedger()
  useEffect(() => retainBody(kind, id), [kind, id, retainBody])
  const ready = !state[kind].find(item => item.id === id)?._bodyPending
  const timing = window.__ledgerTest?.timings?.[`${kind}:${id}`]
  if (ready && timing && timing.ready === undefined) timing.ready = performance.now()
  return ready
}
