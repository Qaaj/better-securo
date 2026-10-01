import { describe, expect, it } from 'vitest'
import {
  defaultDrawable,
  projectRetirement,
  type Assumptions,
  type ProjectionAsset,
  type ProjectionInput,
  type WhatIf,
} from './retirement-projection'

const flat: Assumptions = { horizonYears: 20, inflationPercent: 0, incomeIndexed: true }
const pool = (value: number, extra: Partial<ProjectionAsset> = {}): ProjectionAsset => ({ id: 'p', name: 'pool', value, drawable: true, ...extra })

type RunOver = Omit<Partial<ProjectionInput>, 'assumptions'> & { assumptions?: Partial<Assumptions> }

function run(over: RunOver) {
  return projectRetirement({
    recurringIncomeMonthly: 0,
    outgoingMonthly: 0,
    assets: [],
    whatIfs: [],
    ...over,
    assumptions: { ...flat, ...over.assumptions },
  })
}

describe('projectRetirement', () => {
  it('lasts exactly as long as the money divided by the yearly shortfall', () => {
    const p = run({ assets: [pool(120_000)], outgoingMonthly: 1_000 })
    expect(p.runwayYears).toBeCloseTo(10)
    expect(p.rows[9].drawable).toBeCloseTo(0)
    expect(p.rows[10].unfunded).toBeCloseTo(12_000)
  })

  it('never runs out when income covers the outgoings', () => {
    const p = run({ assets: [pool(1_000)], outgoingMonthly: 1_000, recurringIncomeMonthly: 1_200 })
    expect(p.runwayYears).toBeNull()
    expect(p.rows[19].drawable).toBeCloseTo(1_000 + 20 * 2_400)
  })

  it('shortens the runway when outgoings inflate and income does not', () => {
    const base = run({ assets: [pool(300_000)], outgoingMonthly: 1_000, assumptions: { horizonYears: 60 } })
    const inflated = run({ assets: [pool(300_000)], outgoingMonthly: 1_000, assumptions: { horizonYears: 60, inflationPercent: 3, incomeIndexed: false } })
    expect(inflated.runwayYears!).toBeLessThan(base.runwayYears!)
  })

  it('indexes income with inflation when asked to', () => {
    const indexed = run({ recurringIncomeMonthly: 1_000, outgoingMonthly: 1_000, assets: [pool(0)], assumptions: { inflationPercent: 5 } })
    expect(indexed.runwayYears).toBeNull()
    const fixed = run({ recurringIncomeMonthly: 1_000, outgoingMonthly: 1_000, assets: [pool(5_000)], assumptions: { inflationPercent: 5, incomeIndexed: false } })
    expect(fixed.runwayYears).not.toBeNull()
  })

  it('grows each asset at its own rate', () => {
    const p = run({ assets: [pool(100_000, { growthPercent: 10 })], assumptions: { horizonYears: 2 } })
    expect(p.rows[1].drawable).toBeCloseTo(121_000)
  })

  it('pays out a yield from the value, which shrinks as it is drawn', () => {
    const p = run({ assets: [pool(100_000, { yieldPercent: 5 })], assumptions: { horizonYears: 1 } })
    expect(p.rows[0].income).toBeCloseTo(5_000)
    expect(p.rows[0].drawable).toBeCloseTo(105_000)
  })

  it('treats a planned sale as income that leaves the holding', () => {
    const p = run({ assets: [pool(100_000, { sellPercent: 4 })], outgoingMonthly: 500, assumptions: { horizonYears: 1 } })
    expect(p.rows[0].income).toBeCloseTo(4_000)
    expect(p.rows[0].drawable).toBeCloseTo(100_000 - 6_000 + 4_000 - 4_000) // sold 4k, paid 6k outgoings, 4k covered by the sale
  })

  it('keeps liabilities and non-drawable property out of the pool but in net worth', () => {
    const p = run({
      assets: [pool(50_000), { id: 'h', name: 'house', value: 400_000, drawable: false, growthPercent: 10 }, { id: 'l', name: 'loan', value: -100_000, drawable: false }],
      assumptions: { horizonYears: 1 },
    })
    expect(p.drawableNow).toBe(50_000)
    expect(p.netWorthNow).toBe(350_000)
    expect(p.rows[0].netWorth).toBeCloseTo(50_000 + 440_000 - 100_000)
  })

  it('grows assets at different rates side by side', () => {
    const p = run({
      assets: [pool(100_000, { growthPercent: 10 }), { id: 'q', name: 'q', value: 100_000, drawable: true, growthPercent: 0 }],
      assumptions: { horizonYears: 1 },
    })
    expect(p.rows[0].drawable).toBeCloseTo(210_000)
  })

  it('collects a surplus in cash when there is nothing drawable', () => {
    const p = run({ recurringIncomeMonthly: 500, assets: [], assumptions: { horizonYears: 3 } })
    expect(p.rows[2].drawable).toBeCloseTo(18_000)
  })

  it('splits a draw pro rata across the drawable assets', () => {
    const p = run({
      assets: [pool(75_000), { id: 'q', name: 'q', value: 25_000, drawable: true }],
      outgoingMonthly: 1_000, assumptions: { horizonYears: 1 },
    })
    expect(p.rows[0].drawable).toBeCloseTo(88_000)
  })
})

describe('what-ifs', () => {
  const baseline = { assets: [pool(240_000)], outgoingMonthly: 1_000 }

  it('applies a monthly expense only while it is active', () => {
    const w: WhatIf[] = [{ id: '1', kind: 'expense', label: 'baby', monthly: 500, fromYear: 2, toYear: 3 }]
    const p = run({ ...baseline, whatIfs: w })
    expect(p.rows[1].outgoing).toBeCloseTo(12_000)
    expect(p.rows[2].outgoing).toBeCloseTo(18_000)
    expect(p.rows[4].outgoing).toBeCloseTo(12_000)
  })

  it('adds a monthly income and a signed one-off', () => {
    const p = run({
      ...baseline,
      whatIfs: [
        { id: '1', kind: 'income', label: 'job', monthly: 1_000, fromYear: 0 },
        { id: '2', kind: 'oneoff', label: 'car', amount: -30_000, year: 1 },
      ],
    })
    expect(p.rows[0].netFlow).toBeCloseTo(0)
    expect(p.rows[1].drawable).toBeCloseTo(210_000)
  })

  it('selling an asset moves its value into the pool and stops its rent', () => {
    const assets: ProjectionAsset[] = [
      pool(100_000),
      { id: 'flat', name: 'flat', value: 300_000, drawable: false, fixedMonthly: 1_000 },
    ]
    const without = run({ assets, outgoingMonthly: 1_000, assumptions: { horizonYears: 3 } })
    const sold = run({
      assets, outgoingMonthly: 1_000, assumptions: { horizonYears: 3 },
      whatIfs: [{ id: 's', kind: 'sell', label: 'sell flat', assetId: 'flat', year: 1, feesPercent: 10 }],
    })
    expect(without.rows[2].drawable).toBeCloseTo(100_000) // rent covers the outgoings
    expect(sold.rows[0].drawable).toBeCloseTo(100_000)
    // year 1: 270k proceeds in, no rent, 12k out
    expect(sold.rows[1].drawable).toBeCloseTo(100_000 + 270_000 - 12_000)
    expect(sold.rows[2].netFlow).toBeCloseTo(-12_000)
    expect(sold.rows[1].netWorth).toBeCloseTo(sold.rows[1].drawable)
  })
})

describe('defaultDrawable', () => {
  it('excludes property, vehicles and liabilities', () => {
    expect(defaultDrawable('crypto', 10)).toBe(true)
    expect(defaultDrawable('etf', 10)).toBe(true)
    expect(defaultDrawable('real_estate', 10)).toBe(false)
    expect(defaultDrawable('vehicle', 10)).toBe(false)
    expect(defaultDrawable('other', -5)).toBe(false)
  })
})

describe('drawdown years', () => {
  it('saves surpluses and ignores shortfalls until the start year', () => {
    const p = run({
      assets: [pool(100_000)], outgoingMonthly: 1_000, recurringIncomeMonthly: 0,
      assumptions: { drawdownStartYear: 3, horizonYears: 6 },
    })
    expect(p.rows[0].phase).toBe('saving')
    expect(p.rows[2].drawable).toBeCloseTo(100_000) // shortfalls before the start are assumed paid from earnings
    expect(p.rows[3].phase).toBe('drawdown')
    expect(p.rows[3].drawable).toBeCloseTo(88_000)
  })

  it('still saves a surplus before the start year', () => {
    const p = run({
      assets: [pool(10_000)], outgoingMonthly: 1_000, recurringIncomeMonthly: 1_500,
      assumptions: { drawdownStartYear: 2, horizonYears: 3 },
    })
    expect(p.rows[1].drawable).toBeCloseTo(10_000 + 2 * 6_000)
  })

  it('counts the runway from now, including the saving years', () => {
    const p = run({
      assets: [pool(120_000)], outgoingMonthly: 1_000,
      assumptions: { drawdownStartYear: 5, horizonYears: 30 },
    })
    expect(p.runwayYears).toBeCloseTo(15)
  })

  it('reports what is left when the drawdown ends and marks the years after it', () => {
    const p = run({
      assets: [pool(120_000)], outgoingMonthly: 1_000,
      assumptions: { drawdownEndYear: 4, horizonYears: 8 },
    })
    expect(p.leftAtEnd).toBeCloseTo(120_000 - 5 * 12_000)
    expect(p.rows[4].phase).toBe('drawdown')
    expect(p.rows[5].phase).toBe('after')
  })

  it('has no left-at-end figure without an end year', () => {
    expect(run({ assets: [pool(1)] }).leftAtEnd).toBeNull()
  })
})

describe('selling order', () => {
  const assets: ProjectionAsset[] = [
    { id: 'a', name: 'bonds', value: 10_000, drawable: true, sellOrder: 1 },
    { id: 'b', name: 'etf', value: 100_000, drawable: true, sellOrder: 2 },
    { id: 'c', name: 'crypto', value: 100_000, drawable: true },
  ]

  it('sells the first asset down before touching the next', () => {
    const p = run({ assets, outgoingMonthly: 1_000, assumptions: { sellStrategy: 'ordered', horizonYears: 2 } })
    expect(p.rows[0].byAsset.a ?? 0).toBeCloseTo(0) // 12k need, bonds only had 10k (emptied assets are left out)
    expect(p.rows[0].drawn.a).toBeCloseTo(10_000)
    expect(p.rows[0].drawn.b).toBeCloseTo(2_000)
    expect(p.rows[0].byAsset.c).toBeCloseTo(100_000) // unset order sells last
  })

  it('spreads the draw in proportion when no order is asked for', () => {
    const p = run({ assets, outgoingMonthly: 1_000, assumptions: { horizonYears: 1 } })
    expect(p.rows[0].drawn.b).toBeCloseTo(p.rows[0].drawn.c)
  })

  it('reports each asset at the end of every year', () => {
    const p = run({ assets, assumptions: { horizonYears: 1 } })
    expect(Object.values(p.rows[0].byAsset).reduce((x, y) => x + y, 0)).toBeCloseTo(p.rows[0].drawable)
  })
})

describe('fixed spending', () => {
  it('replaces the recurring outgoings from its year', () => {
    const p = run({
      assets: [pool(500_000)], outgoingMonthly: 8_000,
      whatIfs: [{ id: 's', kind: 'spend', label: 'frugal', monthly: 4_000, fromYear: 2 }],
      assumptions: { horizonYears: 4 },
    })
    expect(p.rows[1].outgoing).toBeCloseTo(96_000)
    expect(p.rows[2].outgoing).toBeCloseTo(48_000)
  })
})

describe('assets that arrive later', () => {
  it('are not part of today but join the pool from their year, then grow', () => {
    const p = run({
      assets: [pool(100_000), { id: 'later', name: 'inheritance', value: 50_000, drawable: true, startYear: 2, growthPercent: 10 }],
      assumptions: { horizonYears: 4 },
    })
    expect(p.drawableNow).toBe(100_000)
    expect(p.rows[1].drawable).toBeCloseTo(100_000)
    expect(p.rows[1].byAsset.later).toBeUndefined()
    expect(p.rows[2].byAsset.later).toBeCloseTo(55_000) // arrives, then grows 10% that year
    expect(p.rows[3].byAsset.later).toBeCloseTo(60_500)
  })

  it('pay their yield only once they exist', () => {
    const p = run({
      assets: [{ id: 'b', name: 'bonds', value: 100_000, drawable: true, startYear: 1, yieldPercent: 5 }],
      assumptions: { horizonYears: 3 },
    })
    expect(p.rows[0].assetIncome).toBe(0)
    expect(p.rows[1].assetIncome).toBeCloseTo(5_000)
  })

  it('extend the runway from the year they arrive', () => {
    const without = run({ assets: [pool(24_000)], outgoingMonthly: 1_000, assumptions: { horizonYears: 10 } })
    const withLater = run({
      assets: [pool(24_000), { id: 'l', name: 'later', value: 24_000, drawable: true, startYear: 1 }],
      outgoingMonthly: 1_000, assumptions: { horizonYears: 10 },
    })
    expect(without.runwayYears).toBeCloseTo(2)
    expect(withLater.runwayYears).toBeCloseTo(4)
  })
})

describe('what inflation applies to', () => {
  const costs = { assets: [pool(1_000_000)], assumptions: { inflationPercent: 10, horizonYears: 3 } }

  it('keeps a flat outgoing the same while the rest rises', () => {
    const p = run({ ...costs, outgoingMonthly: 1_000, outgoingFlatMonthly: 500 })
    expect(p.rows[0].outgoing).toBeCloseTo(12_000 + 6_000)
    expect(p.rows[2].outgoing).toBeCloseTo(12_000 * 1.21 + 6_000)
  })

  it('keeps a flat income the same, and a flat rental', () => {
    const p = run({
      assets: [pool(0), { id: 'r', name: 'rent', value: 100, drawable: false, fixedMonthly: 1_000, fixedFlat: true }],
      recurringIncomeFlatMonthly: 500, recurringIncomeMonthly: 200,
      assumptions: { inflationPercent: 10, horizonYears: 3, incomeIndexed: true },
    })
    expect(p.rows[2].income).toBeCloseTo(200 * 12 * 1.21 + 500 * 12 + 1_000 * 12)
    const indexed = run({
      assets: [pool(0), { id: 'r', name: 'rent', value: 100, drawable: false, fixedMonthly: 1_000 }],
      assumptions: { inflationPercent: 10, horizonYears: 3, incomeIndexed: true },
    })
    expect(indexed.rows[2].income).toBeCloseTo(1_000 * 12 * 1.21)
  })

  it('lengthens the runway when the biggest cost is fixed', () => {
    const inflating = run({ assets: [pool(300_000)], outgoingMonthly: 1_000, assumptions: { inflationPercent: 4, horizonYears: 60 } })
    const fixed = run({ assets: [pool(300_000)], outgoingFlatMonthly: 1_000, assumptions: { inflationPercent: 4, horizonYears: 60 } })
    expect(fixed.runwayYears!).toBeGreaterThan(inflating.runwayYears!)
  })

  it('a fixed spend replaces both kinds of outgoing', () => {
    const p = run({
      ...costs, outgoingMonthly: 1_000, outgoingFlatMonthly: 500,
      whatIfs: [{ id: 's', kind: 'spend', label: 'x', monthly: 2_000, fromYear: 1 }],
    })
    expect(p.rows[1].outgoing).toBeCloseTo(2_000 * 12 * 1.1)
  })
})

describe('what-if amounts and inflation', () => {
  const base = { assets: [pool(1_000_000)], assumptions: { inflationPercent: 10, horizonYears: 3 } }

  it('lets an extra cost rise with inflation by default and stay the same when asked', () => {
    const rising = run({ ...base, whatIfs: [{ id: '1', kind: 'expense', label: 'x', monthly: 1_000, fromYear: 0 }] })
    const fixed = run({ ...base, whatIfs: [{ id: '1', kind: 'expense', label: 'x', monthly: 1_000, fromYear: 0, inflates: false }] })
    expect(rising.rows[2].outgoing).toBeCloseTo(12_000 * 1.21)
    expect(fixed.rows[2].outgoing).toBeCloseTo(12_000)
  })

  it('does the same for an extra income', () => {
    const rising = run({ ...base, whatIfs: [{ id: '1', kind: 'income', label: 'x', monthly: 1_000, fromYear: 0 }] })
    const fixed = run({ ...base, whatIfs: [{ id: '1', kind: 'income', label: 'x', monthly: 1_000, fromYear: 0, inflates: false }] })
    expect(rising.rows[2].income).toBeCloseTo(12_000 * 1.21)
    expect(fixed.rows[2].income).toBeCloseTo(12_000)
  })

  it('and for a fixed spend, which stays the same when it should not inflate', () => {
    const fixed = run({ ...base, outgoingMonthly: 500, whatIfs: [{ id: 's', kind: 'spend', label: 'x', monthly: 2_000, fromYear: 1, inflates: false }] })
    expect(fixed.rows[1].outgoing).toBeCloseTo(24_000)
    expect(fixed.rows[2].outgoing).toBeCloseTo(24_000)
  })
})
