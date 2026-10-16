import { describe, expect, it } from 'vitest'
import { PERIODS_PER_YEAR, alignPeriods, backtest, cumulative, mean, percentile, periodIndex, project, trailing } from './vlcvx'
import type { VlcvxRound } from '@/types'

const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000).toISOString()
const round = (n: number, ends: number, rate: number | null, total = 1000): VlcvxRound => ({
  round: n, ends_at: day(ends), total_amount_dollars: total, dollar_per_vl: rate, scores_total: null, proposal: null, vote_source: null, has_detail: false, bribe_count: 0,
})

describe('periods', () => {
  it('lines up rounds of different protocols that end in the same two weeks and adds what a holder earns', () => {
    const byProtocol = {
      'cvx-crv': [round(1, 0, 0.02), round(2, 14, 0.03), round(3, 28, 0.04)],
      'cvx-fxn': [round(1, 1, 0.005), round(2, 15, 0.006)],
    }
    const both = alignPeriods(byProtocol, ['cvx-crv', 'cvx-fxn'])
    expect(both.map((p) => Number(p.rate.toFixed(3)))).toEqual([0.025, 0.036, 0.04])
    expect(both[0].parts).toEqual({ 'cvx-crv': 0.02, 'cvx-fxn': 0.005 })
    expect(alignPeriods(byProtocol, ['cvx-crv']).map((p) => p.rate)).toEqual([0.02, 0.03, 0.04])
    expect(both.map((p) => p.index)).toEqual([...both.map((p) => p.index)].sort((a, b) => a - b))
  })

  it('leaves out rounds with no end or no rate', () => {
    const rounds = [round(1, 0, null), { ...round(2, 14, 0.01), ends_at: null }, round(3, 28, 0.02)]
    expect(alignPeriods({ a: rounds }, ['a']).map((p) => p.rate)).toEqual([0.02])
  })

  it('indexes by two-week slot', () => {
    expect(periodIndex(day(14)) - periodIndex(day(0))).toBe(1)
    expect(periodIndex(day(13)) - periodIndex(day(0))).toBeLessThanOrEqual(1)
  })
})

describe('payouts', () => {
  const periods = alignPeriods({ a: Array.from({ length: 30 }, (_, i) => round(i + 1, i * 14, 0.01 * ((i % 3) + 1))) }, ['a'])

  it('runs a total and a trailing sum', () => {
    expect(cumulative(periods).at(-1)!.total).toBeCloseTo(periods.reduce((s, p) => s + p.rate, 0))
    expect(trailing(periods, 3)).toBeCloseTo(periods.slice(-3).reduce((s, p) => s + p.rate, 0))
  })

  it('works out what holding would have paid, and the yield when a price is given', () => {
    const b = backtest(periods, 26, 10_000, 2)
    expect(b.periods).toBe(26)
    expect(b.dollars).toBeCloseTo(b.perVl * 10_000)
    expect(b.perYear).toBeCloseTo(b.perPeriod * PERIODS_PER_YEAR)
    expect(b.apr).toBeCloseTo(b.perYear / (10_000 * 2))
    expect(backtest(periods, 26, 10_000, null).apr).toBeNull()
    expect(backtest([], 26, 1, 1).dollars).toBe(0)
  })

  it('knows its percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentile([10, 20], 25)).toBe(12.5)
    expect(percentile([], 50)).toBe(0)
    expect(mean([2, 4])).toBe(3)
  })
})

describe('projection', () => {
  const steady = alignPeriods({ a: Array.from({ length: 12 }, (_, i) => round(i + 1, i * 14, 0.02)) }, ['a'])
  const jumpy = alignPeriods({ a: Array.from({ length: 12 }, (_, i) => round(i + 1, i * 14, i % 2 ? 0.05 : 0.005)) }, ['a'])

  it('collects exactly the average when every period paid the same', () => {
    const p = project(steady, { lookback: 12, horizon: 26, amount: 1000, price: null })!
    expect(p.total.p10).toBeCloseTo(26 * 20)
    expect(p.total.p90).toBeCloseTo(26 * 20)
    expect(p.perYear.p50).toBeCloseTo(520)
    expect(p.apr).toBeNull()
  })

  it('spreads out when payouts jump about, around the average, and is repeatable for a seed', () => {
    const a = project(jumpy, { lookback: 12, horizon: 26, amount: 1000, price: 4, seed: 9 })!
    const b = project(jumpy, { lookback: 12, horizon: 26, amount: 1000, price: 4, seed: 9 })!
    expect(a).toEqual(b)
    expect(a.total.p10).toBeLessThan(a.total.p90)
    expect(a.total.mean).toBeGreaterThan(a.total.p10)
    expect(a.total.mean).toBeLessThan(a.total.p90)
    expect(a.fan).toHaveLength(26)
    expect(a.fan[25].p50).toBeCloseTo(a.total.p50)
    expect(a.fan[0].p10).toBeLessThanOrEqual(a.fan[0].p90)
    expect(a.apr!.p50).toBeCloseTo(a.perYear.p50 / (1000 * 4))
  })

  it('only draws from the latest lookback and gives nothing without data', () => {
    const p = project(jumpy, { lookback: 2, horizon: 4, amount: 1, price: null })!
    expect(p.sample).toHaveLength(2)
    expect(project([], { lookback: 5, horizon: 5, amount: 1, price: null })).toBeNull()
  })
})
