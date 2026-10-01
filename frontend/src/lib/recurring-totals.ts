import type { RecurringTransaction } from '@/types'

// How many times each frequency charges per year.
export const PER_YEAR: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  yearly: 1,
}

export interface RecurringTotals {
  /** Sum of the active monthly-frequency expenses. */
  monthly: number
  /** Sum of the active yearly-frequency expenses. */
  yearly: number
  /** Every active expense normalised to a month (yearly / 12, weekly * 52 / 12, ...). */
  perMonth: number
  /** Every active expense normalised to a year. */
  perYear: number
  /** Active expenses that had no amount in the display currency and were left out. */
  skipped: number
}

/** The amount in the display currency, or null when it can't be known. */
export function inDisplayCurrency(rt: RecurringTransaction, displayCurrency: string): number | null {
  if (rt.currency === displayCurrency) return Number(rt.amount)
  if (rt.amount_primary != null) return Number(rt.amount_primary)
  return null
}

/** Totals of the active expense items, in the display currency. Income is not counted. */
export function computeRecurringTotals(
  items: RecurringTransaction[],
  displayCurrency: string,
): RecurringTotals {
  const totals: RecurringTotals = { monthly: 0, yearly: 0, perMonth: 0, perYear: 0, skipped: 0 }
  for (const rt of items) {
    if (!rt.is_active || rt.type !== 'debit') continue
    const amount = inDisplayCurrency(rt, displayCurrency)
    const perYear = PER_YEAR[rt.frequency]
    if (amount == null || perYear == null) {
      totals.skipped += 1
      continue
    }
    if (rt.frequency === 'monthly') totals.monthly += amount
    if (rt.frequency === 'yearly') totals.yearly += amount
    totals.perYear += amount * perYear
  }
  totals.perMonth = totals.perYear / 12
  return totals
}
