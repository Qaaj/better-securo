/** Stands in for Securo's API client: reads the JSON files the exporter writes next to the site. */
import type { VlcvxBreakdown, VlcvxRound, VlcvxRoundDetail, VlcvxSummary, VlcvxSync } from '@/types'

const BASE = `${import.meta.env.BASE_URL}data/`

async function read<T>(path: string): Promise<T> {
  const response = await fetch(BASE + path, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response.json()
}

const details: Record<string, Promise<Record<string, VlcvxRoundDetail>>> = {}

export const vlcvx = {
  summary: (): Promise<VlcvxSummary> => read('summary.json'),
  // The data is refreshed on the server on a timer; there is nothing to start from here.
  refresh: async (): Promise<VlcvxSync> => ({ state: 'idle', started_at: null, finished_at: null, error: null, done: 0, total: 0 }),
  rounds: (protocol: string): Promise<VlcvxRound[]> => read(`rounds/${protocol}.json`),
  round: async (protocol: string, round: number): Promise<VlcvxRoundDetail> => {
    details[protocol] ??= read(`details/${protocol}.json`)
    const found = (await details[protocol])[String(round)]
    if (!found) throw new Error(`round ${round} not found`)
    return found
  },
  breakdown: (protocol: string): Promise<VlcvxBreakdown> => read(`breakdown/${protocol}.json`),
}
