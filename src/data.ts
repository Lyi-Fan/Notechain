import type { AppState } from './types'

export const createEmptyState = (): AppState => ({
  cases: [], targets: [], assets: [], findings: [], tasks: [], relations: [],
  reading: {}, lastLocation: null, theme: 'light',
})
