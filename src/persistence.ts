import type { AppState } from './types'

export const CONTENT_KEY = 'asset-ledger-state-v1'
export const ACTIVITY_KEY = 'asset-ledger-activity-v1'
type Activity = Pick<AppState, 'reading' | 'lastLocation'>

export function loadSnapshot(storage: Storage): AppState | null {
  const content = storage.getItem(CONTENT_KEY)
  if (!content) return null
  const state = JSON.parse(content) as AppState
  // The original v1 snapshot remains readable; activity is a small overlay.
  try {
    const raw = storage.getItem(ACTIVITY_KEY)
    if (raw) {
      const activity = JSON.parse(raw) as Activity
      if (activity.reading && typeof activity.reading === 'object' && !Array.isArray(activity.reading)) {
        state.reading = { ...state.reading, ...activity.reading }
        if ('lastLocation' in activity) state.lastLocation = activity.lastLocation
      }
    }
  } catch { /* A damaged activity record must not discard the user's notes. */ }
  return state
}

export function createSnapshotWriter(storage: Pick<Storage, 'setItem'>) {
  let content: AppState | undefined
  let activity: Activity | undefined
  const reportFailure = () => {
    // Never log note contents or secrets when storage is full/unavailable.
    window.dispatchEvent(new Event('ledger-storage-error'))
  }
  return {
    writeContent(next: AppState, strict = false) {
      if (content && content.assets === next.assets && content.cases === next.cases &&
          content.targets === next.targets && content.findings === next.findings &&
          content.tasks === next.tasks && content.relations === next.relations && content.theme === next.theme) return
      try {
        storage.setItem(CONTENT_KEY, JSON.stringify(next))
        content = next
      } catch (error) { reportFailure(); if (strict) throw error }
    },
    writeActivity(next: Activity) {
      if (activity?.reading === next.reading && activity?.lastLocation === next.lastLocation) return
      try {
        storage.setItem(ACTIVITY_KEY, JSON.stringify({ reading: next.reading, lastLocation: next.lastLocation }))
        activity = { reading: next.reading, lastLocation: next.lastLocation }
      } catch { reportFailure() }
    },
  }
}
