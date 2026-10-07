import { PER_YEAR } from '@/lib/recurring-totals'
import type { AssetContract } from '@/types'

export const CONTRACT_KINDS = ['energy', 'gas', 'water', 'internet', 'insurance', 'tax', 'condo', 'mortgage', 'maintenance', 'other'] as const
export const DOCUMENT_KINDS = ['contract', 'insurance', 'deed', 'energy_certificate', 'invoice', 'manual', 'survey', 'other'] as const

/** Ends within this many days counts as "ending soon"; a notice deadline within `NOTICE_SOON` is flagged on its own. */
const ENDING_SOON = 90
const NOTICE_SOON = 30

export type ContractStatus =
  | { kind: 'open' }
  | { kind: 'ok'; daysLeft: number }
  | { kind: 'ending'; daysLeft: number }
  | { kind: 'notice'; noticeBy: string; daysToNotice: number; daysLeft: number }
  | { kind: 'expired'; daysAgo: number }

/** Where a contract stands today: expired, a notice deadline coming, ending soon, fine, or without an end. */
export function contractStatus(contract: Pick<AssetContract, 'days_left' | 'notice_by'>, today: Date = new Date()): ContractStatus {
  if (contract.days_left == null) return { kind: 'open' }
  if (contract.days_left < 0) return { kind: 'expired', daysAgo: -contract.days_left }
  if (contract.notice_by) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const deadline = new Date(contract.notice_by + 'T00:00:00')
    const daysToNotice = Math.round((deadline.getTime() - start.getTime()) / 86_400_000)
    if (daysToNotice >= 0 && daysToNotice <= NOTICE_SOON) return { kind: 'notice', noticeBy: contract.notice_by, daysToNotice, daysLeft: contract.days_left }
  }
  if (contract.days_left <= ENDING_SOON) return { kind: 'ending', daysLeft: contract.days_left }
  return { kind: 'ok', daysLeft: contract.days_left }
}

export interface RunningCosts {
  perMonth: number
  perYear: number
  /** Contracts that have a recurring item and so a cost. */
  costed: number
  /** Contracts without one, whose cost is not in the total. */
  uncosted: number
  /** Linked items that had no amount in the display currency. */
  skipped: number
}

/** What the linked recurring items cost, in the display currency. Inactive items and income are not counted. */
export function runningCosts(contracts: Pick<AssetContract, 'recurring'>[], displayCurrency: string): RunningCosts {
  const result: RunningCosts = { perMonth: 0, perYear: 0, costed: 0, uncosted: 0, skipped: 0 }
  for (const { recurring } of contracts) {
    if (!recurring) {
      result.uncosted += 1
      continue
    }
    if (!recurring.is_active) continue
    const amount = recurring.currency === displayCurrency ? Number(recurring.amount) : recurring.amount_primary
    const perYear = PER_YEAR[recurring.frequency]
    if (amount == null || perYear == null) {
      result.skipped += 1
      continue
    }
    result.costed += 1
    result.perYear += amount * perYear
  }
  result.perMonth = result.perYear / 12
  return result
}
