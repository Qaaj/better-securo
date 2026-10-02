/**
 * Keeps the Retirement tab's saved plans and switches on the server, so they
 * follow the workspace to any browser or address. The browser's local storage
 * stays the working copy the components read and write; this module copies it
 * to the server after changes (debounced) and, on opening the page, brings the
 * server's copy down.
 */
import { retirementState } from '@/lib/api'

export const PREFIX = 'retirement:'
export const SCENARIOS_KEY = 'retirement:scenarios'
const DEBOUNCE_MS = 800

type Store = Record<string, unknown>

/** Everything the Retirement tab keeps, as parsed values. */
export function collectLocal(storage: Storage = window.localStorage): Store {
  const out: Store = {}
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key || !key.startsWith(PREFIX)) continue
    try {
      out[key] = JSON.parse(storage.getItem(key) ?? 'null')
    } catch {
      // Not ours to repair; leave an unreadable value out.
    }
  }
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The server's copy wins, except that saved plans only found here are kept, so
 * plans made in a browser that never synced are not lost.
 */
export function mergeStores(local: Store, remote: Store): Store {
  const merged: Store = { ...local, ...remote }
  const localPlans = local[SCENARIOS_KEY]
  const remotePlans = remote[SCENARIOS_KEY]
  if (isObject(localPlans) && isObject(remotePlans)) merged[SCENARIOS_KEY] = { ...localPlans, ...remotePlans }
  return merged
}

function sameStore(a: Store, b: Store): boolean {
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort())
}

let timer: ReturnType<typeof setTimeout> | undefined
let enabled = false

/** Copy the local state to the server shortly after the last change. */
export function scheduleSync(): void {
  if (!enabled) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    retirementState.put(collectLocal()).catch(() => {
      // Offline or signed out: the local copy still works and the next change retries.
    })
  }, DEBOUNCE_MS)
}

/**
 * Bring the server's copy down on opening the page. Returns when local storage
 * holds the merged state; a failing server just leaves the local copy as it is.
 */
export async function loadFromServer(storage: Storage = window.localStorage): Promise<void> {
  try {
    const remote = (await retirementState.get()).data ?? {}
    const local = collectLocal(storage)
    const merged = mergeStores(local, remote)
    for (const [key, value] of Object.entries(merged)) {
      try {
        storage.setItem(key, JSON.stringify(value))
      } catch {
        // Blocked storage: the page still works from the server copy next time.
      }
    }
    enabled = true
    if (Object.keys(merged).length > 0 && !sameStore(merged, remote)) {
      await retirementState.put(merged)
    }
  } catch {
    enabled = true
  }
}
