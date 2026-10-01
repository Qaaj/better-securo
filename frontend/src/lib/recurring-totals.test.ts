import { describe, expect, it } from 'vitest'
import type { RecurringTransaction } from '@/types'
import { computeRecurringTotals } from './recurring-totals'

function item(over: Partial<RecurringTransaction>): RecurringTransaction {
  return {
    id: 'x', description: 'x', amount: 100, currency: 'EUR', type: 'debit',
    frequency: 'monthly', is_active: true, amount_primary: null,
    ...over,
  } as RecurringTransaction
}

describe('computeRecurringTotals', () => {
  it('sums monthly and yearly items separately and normalises both', () => {
    const t = computeRecurringTotals(
      [item({ amount: 100 }), item({ amount: 50 }), item({ amount: 1200, frequency: 'yearly' })],
      'EUR',
    )
    expect(t.monthly).toBe(150)
    expect(t.yearly).toBe(1200)
    expect(t.perYear).toBe(150 * 12 + 1200)
    expect(t.perMonth).toBe((150 * 12 + 1200) / 12)
  })

  it('ignores income and inactive items', () => {
    const t = computeRecurringTotals(
      [item({ type: 'credit', amount: 999 }), item({ is_active: false, amount: 999 }), item({ amount: 10 })],
      'EUR',
    )
    expect(t.monthly).toBe(10)
  })

  it('converts foreign currencies through amount_primary and skips what it cannot convert', () => {
    const t = computeRecurringTotals(
      [
        item({ amount: 10, currency: 'USD', amount_primary: 9 }),
        item({ amount: 10, currency: 'CAD', amount_primary: null }),
      ],
      'EUR',
    )
    expect(t.monthly).toBe(9)
    expect(t.skipped).toBe(1)
  })

  it('normalises other frequencies to a year', () => {
    const t = computeRecurringTotals([item({ amount: 10, frequency: 'weekly' })], 'EUR')
    expect(t.perYear).toBe(520)
    expect(t.monthly).toBe(0)
  })
})
