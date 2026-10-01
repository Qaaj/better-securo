import { describe, expect, it } from 'vitest'
import type { Asset, RecurringTransaction } from '@/types'
import { computeRetirement, monthlyEquivalent } from './retirement'

function item(over: Partial<RecurringTransaction>): RecurringTransaction {
  return {
    id: Math.random().toString(36), description: 'x', amount: 100, currency: 'EUR', type: 'debit',
    frequency: 'monthly', is_active: true, amount_primary: null,
    ...over,
  } as RecurringTransaction
}

function asset(over: Partial<Asset>): Asset {
  return {
    id: Math.random().toString(36), name: 'a', currency: 'EUR', group_id: null,
    current_value: 100000, current_value_primary: 100000, is_archived: false, sell_date: null,
    income_mode: null, income_rate: null, income_amount: null, income_frequency: null, sell_percent_per_year: null,
    ...over,
  } as Asset
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

describe('computeRetirement with recurring items', () => {
  const rent = item({ id: 'rent', type: 'credit', amount: 2000 })
  const solar = item({ id: 'solar', type: 'credit', amount: 1200, frequency: 'yearly' })
  const living = item({ id: 'living', amount: 4000 })

  it('counts every credit by default and every debit as outgoing', () => {
    const s = computeRetirement([rent, solar, living], [], 'EUR', new Set())
    expect(s.incomeMonthly).toBe(2100)
    expect(s.outgoingMonthly).toBe(4000)
    expect(s.coverage).toBeCloseTo(0.525)
    expect(s.surplusMonthly).toBe(-1900)
  })

  it('leaves an excluded credit out of the total but still lists it', () => {
    const s = computeRetirement([rent, solar, living], [], 'EUR', new Set(['rent']))
    expect(s.incomeMonthly).toBe(100)
    expect(s.income).toHaveLength(2)
  })

  it('ignores inactive items and skips what it cannot convert', () => {
    const s = computeRetirement(
      [rent, item({ is_active: false, type: 'credit', amount: 999 }), item({ currency: 'CAD', type: 'credit' })],
      [], 'EUR', new Set(),
    )
    expect(s.incomeMonthly).toBe(2000)
    expect(s.skipped).toBe(1)
  })

  it('has no coverage without outgoings', () => {
    expect(computeRetirement([rent], [], 'EUR', new Set()).coverage).toBeNull()
  })
})

describe('computeRetirement with assets', () => {
  it('turns a yield into monthly income from the value', () => {
    const s = computeRetirement([], [asset({ income_mode: 'yield', income_rate: 3.6 })], 'EUR', new Set())
    expect(s.incomeMonthly).toBeCloseTo(300)
  })

  it('turns a fixed rental into monthly income', () => {
    const s = computeRetirement(
      [], [asset({ income_mode: 'fixed', income_amount: 2100, income_frequency: 'monthly' })], 'EUR', new Set(),
    )
    expect(s.incomeMonthly).toBe(2100)
    const yearly = computeRetirement(
      [], [asset({ income_mode: 'fixed', income_amount: 1200, income_frequency: 'yearly' })], 'EUR', new Set(),
    )
    expect(yearly.incomeMonthly).toBe(100)
  })

  it('counts planned sales as a share of the value a year', () => {
    const s = computeRetirement([], [asset({ sell_percent_per_year: 4 })], 'EUR', new Set())
    expect(s.incomeMonthly).toBeCloseTo((100000 * 0.04) / 12)
    expect(s.income[0].kind).toBe('asset-sale')
  })

  it('includes ungrouped assets as well as grouped ones', () => {
    const s = computeRetirement(
      [],
      [
        asset({ id: 'u', group_id: null, income_mode: 'yield', income_rate: 1.2 }),
        asset({ id: 'g', group_id: 'wallet', income_mode: 'yield', income_rate: 1.2 }),
      ],
      'EUR', new Set(),
    )
    expect(s.income.map((l) => l.id).sort()).toEqual(['asset:g:income', 'asset:u:income'])
  })

  it('converts a foreign-currency fixed income through the asset value pair', () => {
    const s = computeRetirement(
      [],
      [asset({ currency: 'CAD', current_value: 100000, current_value_primary: 62000, income_mode: 'fixed', income_amount: 1000, income_frequency: 'monthly' })],
      'EUR', new Set(),
    )
    expect(s.incomeMonthly).toBeCloseTo(620)
  })

  it('skips archived and sold assets, and lets a deselected asset line out', () => {
    const live = asset({ id: 'live', income_mode: 'yield', income_rate: 12 })
    const s = computeRetirement(
      [],
      [live, asset({ is_archived: true, income_mode: 'yield', income_rate: 12 }), asset({ sell_date: '2026-01-01', income_mode: 'yield', income_rate: 12 })],
      'EUR', new Set(['asset:live:income']),
    )
    expect(s.income).toHaveLength(1)
    expect(s.incomeMonthly).toBe(0)
  })

  it('counts an asset without a usable value as skipped', () => {
    const s = computeRetirement([], [asset({ currency: 'CAD', current_value: null, current_value_primary: null, income_mode: 'yield', income_rate: 3 })], 'EUR', new Set())
    expect(s.skipped).toBe(1)
  })
})
