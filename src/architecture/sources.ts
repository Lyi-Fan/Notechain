import type { AppState } from '../types'
import { flushNative, nativeInvoke } from '../native-storage'
import { extractFacts, graphAssets, type NoteFacts } from './model'
import { assetMarkdown } from '../notes'

const cache = new Map<string, { version: number; signature?: string; facts: NoteFacts }>()
function signature(text?: string) {
  let hash = 2166136261
  for (let i = 0; i < (text?.length ?? 0); i++) hash = Math.imul(hash ^ text!.charCodeAt(i), 16777619)
  return `${text?.length ?? -1}:${hash >>> 0}`
}
export async function graphFacts(state: AppState, caseId: string): Promise<Map<string, NoteFacts>> {
  const result = new Map<string, NoteFacts>()
  await flushNative()
  for (const asset of graphAssets(state, caseId)) {
    const previous = cache.get(asset.id)
    if (previous?.version === asset.version && (asset._bodyPending || previous.signature === signature(asset.noteMarkdown))) {
      result.set(asset.id, previous.facts); continue
    }
    // Read one body at a time, retain only extracted identifiers, never hydrate the whole editor cache.
    const body = asset._bodyPending && nativeInvoke ? await nativeInvoke<string | null>('read_body', { kind: 'assets', id: asset.id }) : asset.noteMarkdown
    const facts = extractFacts(body ?? assetMarkdown(asset))
    cache.delete(asset.id)
    cache.set(asset.id, { version: asset.version, facts, ...(asset._bodyPending ? {} : { signature: signature(asset.noteMarkdown) }) })
    while (cache.size > 2000) cache.delete(cache.keys().next().value!)
    result.set(asset.id, facts)
  }
  return result
}
