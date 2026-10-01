import type { RecurringTransaction } from '@/types'
import { PER_YEAR, inDisplayCurrency } from './recurring-totals'

export interface RetirementLine {
  item: RecurringTransaction
  /** What the item amounts to in a month, in the display currency. */
  monthly: number
}

export interface RetirementSummary {
  /** Every active credit, whether or not it is counted. */
  income: RetirementLine[]
  /** Every active debit. All of them count. */
  outgoing: RetirementLine[]
  incomeMonthly: number
  outgoingMonthly: number
  /** Share of the outgoings the counted income covers, 0..n (1 = fully covered). */
  coverage: number | null
  /** Counted income minus outgoings, per month. Negative = shortfall. */
  surplusMonthly: number
  /** Active items left out because they had no amount in the display currency. */
  skipped: number
}

/** An item's amount normalised to a month, or null if it cannot be known. */
export function monthlyEquivalent(rt: RecurringTransaction, displayCurrency: string): number | null {
  const amount = inDisplayCurrency(rt, displayCurrency)
  const perYear = PER_YEAR[rt.frequency]
  if (amount == null || perYear == null) return null
  return (amount * perYear) / 12
}

/**
 * Passive income against outgoings, from the recurring items.
 * All active credits are income unless their id is in `excludedIncomeIds`;
 * all active debits are outgoings.
 */
export function computeRetirement(
  items: RecurringTransaction[],
  displayCurrency: string,
  excludedIncomeIds: ReadonlySet<string>,
): RetirementSummary {
  const income: RetirementLine[] = []
  const outgoing: RetirementLine[] = []
  let skipped = 0
  for (const item of items) {
    if (!item.is_active) continue
    const monthly = monthlyEquivalent(item, displayCurrency)
    if (monthly == null) {
      skipped += 1
      continue
    }
    ;(item.type === 'credit' ? income : outgoing).push({ item, monthly })
  }
  income.sort((a, b) => b.monthly - a.monthly)
  outgoing.sort((a, b) => b.monthly - a.monthly)

  const incomeMonthly = income
    .filter((l) => !excludedIncomeIds.has(l.item.id))
    .reduce((sum, l) => sum + l.monthly, 0)
  const outgoingMonthly = outgoing.reduce((sum, l) => sum + l.monthly, 0)
  return {
    income,
    outgoing,
    incomeMonthly,
    outgoingMonthly,
    coverage: outgoingMonthly > 0 ? incomeMonthly / outgoingMonthly : null,
    surplusMonthly: incomeMonthly - outgoingMonthly,
    skipped,
  }
}
