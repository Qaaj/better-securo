import { describe, expect, it } from 'vitest'
import { contractStatus, runningCosts } from './asset-contracts'
import type { AssetContract } from '@/types'

const today = new Date(2026, 9, 7)

describe('contractStatus', () => {
  it('has no countdown without an end date', () => {
    expect(contractStatus({ days_left: null, notice_by: null }, today)).toEqual({ kind: 'open' })
  })

  it('flags an expired contract, an upcoming notice deadline and one ending soon, in that order of urgency', () => {
    expect(contractStatus({ days_left: -3, notice_by: null }, today)).toEqual({ kind: 'expired', daysAgo: 3 })
    expect(contractStatus({ days_left: 40, notice_by: '2026-10-20' }, today)).toMatchObject({ kind: 'notice', daysToNotice: 13 })
    expect(contractStatus({ days_left: 60, notice_by: '2026-12-01' }, today)).toEqual({ kind: 'ending', daysLeft: 60 })
    expect(contractStatus({ days_left: 400, notice_by: '2027-10-01' }, today)).toEqual({ kind: 'ok', daysLeft: 400 })
  })

  it('does not nag about a notice deadline that has passed', () => {
    expect(contractStatus({ days_left: 20, notice_by: '2026-09-30' }, today)).toEqual({ kind: 'ending', daysLeft: 20 })
  })
})

const item = (amount: number, frequency: string, over: Partial<NonNullable<AssetContract['recurring']>> = {}) =>
  ({ recurring: { id: 'r', description: 'x', amount, currency: 'EUR', frequency, is_active: true, amount_primary: amount, ...over } })

describe('runningCosts', () => {
  it('adds up the linked items as a month and a year', () => {
    const costs = runningCosts([item(100, 'monthly'), item(1200, 'yearly'), { recurring: null }], 'EUR')
    expect(costs.perYear).toBe(2400)
    expect(costs.perMonth).toBe(200)
    expect(costs).toMatchObject({ costed: 2, uncosted: 1, skipped: 0 })
  })

  it('uses the converted amount for another currency, skips what cannot be converted and ignores inactive items', () => {
    const costs = runningCosts(
      [item(10, 'monthly', { currency: 'USD', amount_primary: 9 }), item(10, 'monthly', { currency: 'CAD', amount_primary: null }), item(50, 'monthly', { is_active: false })],
      'EUR',
    )
    expect(costs.perYear).toBe(108)
    expect(costs).toMatchObject({ costed: 1, skipped: 1 })
  })
})
