import { SCENARIOS_KEY } from '@/lib/retirement-model'
import { scheduleSync } from '@/lib/retirement-sync'

export * from '@/lib/retirement-model'
export { SCENARIOS_KEY }

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback
  } catch {
    return fallback
  }
}

export function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Blocked storage: the plan just does not persist.
  }
  scheduleSync()
}
