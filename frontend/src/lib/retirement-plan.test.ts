import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN, buildProjectionInputs, type Plan } from './retirement-plan'
import type { Asset, RecurringTransaction } from '@/types'

const item = (id: string, type: 'debit' | 'credit', amount: number): RecurringTransaction =>
  ({ id, description: id, type, amount, currency: 'EUR', amount_primary: amount, frequency: 'monthly', is_active: true }) as unknown as RecurringTransaction

const asset = { id: 'a1', name: 'Fund', type: 'investment', currency: 'EUR', current_value: 1000, current_value_primary: 1000, purchase_price: 400, is_archived: false, sell_date: null } as unknown as Asset

const plan = (over: Partial<Plan> = {}): Plan => ({ ...DEFAULT_PLAN, ...over })
const none = new Set<string>()

describe('buildProjectionInputs', () => {
  it('counts every line while none has an end year', () => {
    const { base } = buildProjectionInputs(plan(), [item('rent', 'debit', 500), item('pay', 'credit', 200)], [], 'EUR', none, 2026)
    expect(base.outgoingMonthly).toBe(500)
    expect(base.recurringIncomeMonthly).toBe(200)
    expect(base.timed).toEqual([])
  })

  it('moves a line with an end year out of the totals and into its own', () => {
    const { base } = buildProjectionInputs(
      plan({ lineEnd: { mortgage: 2031 }, flat: ['mortgage'] }),
      [item('mortgage', 'debit', 1000), item('food', 'debit', 300)],
      [],
      'EUR',
      none,
      2026,
    )
    expect(base.outgoingMonthly).toBe(300)
    expect(base.timed).toEqual([{ id: 'mortgage', kind: 'expense', label: 'mortgage', monthly: 1000, fromYear: 0, toYear: 5, inflates: false }])
  })

  it('passes the purchase price on as the cost basis and the tax-free choice', () => {
    const { projectionAssets } = buildProjectionInputs(plan({ taxFree: { a1: true } }), [], [asset], 'EUR', none, 2026)
    expect(projectionAssets[0]).toMatchObject({ costBasis: 400, taxFree: true })
  })

  it('adds a living and travel figure to the costs, rising or fixed', () => {
    const rising = buildProjectionInputs(plan({ living: { monthly: 2000, inflates: true } }), [item('rent', 'debit', 500)], [], 'EUR', none, 2026)
    expect(rising.base.outgoingMonthly).toBe(2500)
    expect(rising.base.outgoingFlatMonthly).toBe(0)
    const fixed = buildProjectionInputs(plan({ living: { monthly: 2000, inflates: false } }), [item('rent', 'debit', 500)], [], 'EUR', none, 2026)
    expect(fixed.base.outgoingMonthly).toBe(500)
    expect(fixed.base.outgoingFlatMonthly).toBe(2000)
  })

  it('adds nothing when it is empty or zero', () => {
    const none0 = buildProjectionInputs(plan({ living: { monthly: 0, inflates: true } }), [item('rent', 'debit', 500)], [], 'EUR', none, 2026)
    expect(none0.base.outgoingMonthly).toBe(500)
  })

  it('passes a hypothetical asset\'s type on to the stress test', () => {
    const { projectionAssets } = buildProjectionInputs(
      plan({ tempAssets: [{ id: 't1', name: 'More bonds', value: 50_000, growthPercent: 3, yieldPercent: 0, riskClass: 'bonds' }] }),
      [], [], 'EUR', none, 2026,
    )
    expect(projectionAssets[0]).toMatchObject({ name: 'More bonds', temporary: true, riskClass: 'bonds' })
  })
})
