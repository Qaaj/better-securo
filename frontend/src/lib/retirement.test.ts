import { describe, expect, it } from 'vitest'
import type { RecurringTransaction } from '@/types'
import { computeRetirement, monthlyEquivalent } from './retirement'

function item(over: Partial<RecurringTransaction>): RecurringTransaction {
  return {
    id: Math.random().toString(36), description: 'x', amount: 100, currency: 'EUR', type: 'debit',
    frequency: 'monthly', is_active: true, amount_primary: null,
    ...over,
  } as RecurringTransaction
}

describe('monthlyEquivalent', () => {
  it('normalises each frequency to a month', () => {
    expect(monthlyEquivalent(item({ amount: 1200, frequency: 'yearly' }), 'EUR')).toBe(100)
    expect(monthlyEquivalent(item({ amount: 300, frequency: 'quarterly' }), 'EUR')).toBe(100)
    expect(monthlyEquivalent(item({ amount: 100 }), 'EUR')).toBe(100)
  })

  it('uses the converted amount for a foreign currency and gives up without one', () => {
    expect(monthlyEquivalent(item({ amount: 100, currency: 'CAD', amount_primary: 62 }), 'EUR')).toBe(62)
    expect(monthlyEquivalent(item({ amount: 100, currency: 'CAD' }), 'EUR')).toBeNull()
  })
})

describe('computeRetirement', () => {
  const rent = item({ id: 'rent', type: 'credit', amount: 2000 })
  const solar = item({ id: 'solar', type: 'credit', amount: 1200, frequency: 'yearly' })
  const living = item({ id: 'living', amount: 4000 })

  it('counts every credit by default and every debit as outgoing', () => {
    const s = computeRetirement([rent, solar, living], 'EUR', new Set())
    expect(s.incomeMonthly).toBe(2100)
    expect(s.outgoingMonthly).toBe(4000)
    expect(s.coverage).toBeCloseTo(0.525)
    expect(s.surplusMonthly).toBe(-1900)
  })

  it('leaves an excluded credit out of the income total but still lists it', () => {
    const s = computeRetirement([rent, solar, living], 'EUR', new Set(['rent']))
    expect(s.incomeMonthly).toBe(100)
    expect(s.income).toHaveLength(2)
  })

  it('ignores inactive items and skips what it cannot convert', () => {
    const s = computeRetirement(
      [rent, item({ is_active: false, type: 'credit', amount: 999 }), item({ currency: 'CAD', type: 'credit' })],
      'EUR',
      new Set(),
    )
    expect(s.incomeMonthly).toBe(2000)
    expect(s.skipped).toBe(1)
  })

  it('has no coverage without outgoings', () => {
    expect(computeRetirement([rent], 'EUR', new Set()).coverage).toBeNull()
  })
})
