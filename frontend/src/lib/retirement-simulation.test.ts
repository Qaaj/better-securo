import { describe, expect, it } from 'vitest'
import { projectRetirement, type ProjectionInput } from './retirement-projection'
import { BUFFER_YEARS, DEFAULT_SIM, bufferSweep, defaultRiskClass, makeRng, riskClassOf, scaleSpending, simulate, type SimParams } from './retirement-simulation'

function plan(over: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    recurringIncomeMonthly: 0,
    outgoingMonthly: 3000,
    assets: [{ id: 'a', name: 'Stocks', value: 1_000_000, drawable: true, growthPercent: 5 }],
    assumptions: { horizonYears: 30, inflationPercent: 2, incomeIndexed: true },
    whatIfs: [],
    ...over,
  }
}

const calm: SimParams = { ...DEFAULT_SIM, runs: 300, volatilityScale: 0, crashChancePercent: 0, inflationSpread: 0, spikeChancePercent: 0, classes: { a: 'stocks' } }

describe('retirement simulation', () => {
  it('is repeatable for the same seed and differs between seeds', () => {
    const noisy = { ...DEFAULT_SIM, runs: 200, classes: { a: 'stocks' as const } }
    expect(simulate(plan(), noisy)).toEqual(simulate(plan(), noisy))
    const rich = plan({ assets: [{ id: 'a', name: 'Stocks', value: 3_000_000, drawable: true, growthPercent: 5 }] })
    expect(simulate(rich, { ...noisy, seed: 2 }).nominal.medianEnd).not.toBe(simulate(rich, noisy).nominal.medianEnd)
  })

  it('matches the plain projection when nothing is random', () => {
    const result = simulate(plan(), calm)
    const straight = projectRetirement(plan())
    expect(result.successRate).toBe(straight.runwayYears === null ? 1 : 0)
    expect(result.nominal.medianEnd).toBeCloseTo(straight.rows[29].drawable, 0)
    expect(result.nominal.bands[29].p10).toBeCloseTo(result.nominal.bands[29].p90, 6)
  })

  it('succeeds less often when crashes are likely and when spending is higher', () => {
    const tight = plan({ outgoingMonthly: 4500 })
    const safe = simulate(tight, { ...calm, volatilityScale: 1, crashChancePercent: 0 })
    const rough = simulate(tight, { ...calm, volatilityScale: 1, crashChancePercent: 20 })
    expect(rough.successRate).toBeLessThan(safe.successRate)
    const more = simulate(scaleSpending(tight, 1.4), { ...calm, volatilityScale: 1 })
    expect(more.successRate).toBeLessThanOrEqual(safe.successRate)
  })

  it('does not shock assets treated as fixed', () => {
    const fixed = simulate(plan(), { ...DEFAULT_SIM, runs: 100, crashChancePercent: 50, classes: { a: 'fixed' }, inflationSpread: 0, spikeChancePercent: 0 })
    expect(fixed.nominal.bands[29].p10).toBeCloseTo(fixed.nominal.bands[29].p90, 6)
  })

  it('a crash early hurts more than the same crash late', () => {
    const rng = () => 0
    void rng
    const early = projectRetirement(plan({ market: { inflationPercent: Array(30).fill(2), growthPercent: (_a, y) => (y === 1 ? -35 : 5) } }))
    const late = projectRetirement(plan({ market: { inflationPercent: Array(30).fill(2), growthPercent: (_a, y) => (y === 25 ? -35 : 5) } }))
    expect(early.rows[29].drawable).toBeLessThan(late.rows[29].drawable)
  })

  it('compounds a simulated inflation path into costs', () => {
    const base = projectRetirement(plan())
    const hot = projectRetirement(plan({ market: { inflationPercent: Array(30).fill(6), growthPercent: () => undefined } }))
    expect(hot.rows[10].outgoing).toBeGreaterThan(base.rows[10].outgoing)
  })

  it('has a seeded generator in [0, 1)', () => {
    const rng = makeRng(7)
    const values = Array.from({ length: 1000 }, rng)
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...values)).toBeLessThan(1)
  })

  it('treats investments as stocks and unknown things as fixed', () => {
    expect(defaultRiskClass('investment')).toBe('stocks')
    expect(defaultRiskClass('real_estate')).toBe('property')
    expect(defaultRiskClass('vehicle')).toBe('fixed')
  })

  it('scales planned costs, including the spending what-if', () => {
    const scaled = scaleSpending(
      plan({ outgoingFlatMonthly: 100, whatIfs: [{ id: '1', kind: 'spend', label: 's', monthly: 2000, fromYear: 5 }] }),
      2,
    )
    expect(scaled.outgoingMonthly).toBe(6000)
    expect(scaled.outgoingFlatMonthly).toBe(200)
    expect(scaled.whatIfs[0]).toMatchObject({ monthly: 4000 })
  })

  it("reports outcomes in today's money below the future-money ones when prices rise", () => {
    const result = simulate(plan(), { ...calm, runs: 100 })
    expect(result.real.medianEnd).toBeLessThan(result.nominal.medianEnd)
    expect(result.real.medianEnd).toBeCloseTo(result.nominal.medianEnd / 1.02 ** 30, 0)
  })

  it('compares cash buffers on the same futures', async () => {
    const tight = plan({ outgoingMonthly: 4000 })
    const cells = await bufferSweep(tight, { ...DEFAULT_SIM, runs: 100, classes: { a: 'stocks' } }, {}, 100)
    expect(cells.map((c) => c.years)).toEqual(BUFFER_YEARS)
    expect(cells.every((c) => c.successRate >= 0 && c.successRate <= 1)).toBe(true)
  })

  it('uses the class a hypothetical asset was given, so it moves like stocks instead of staying fixed', () => {
    const input = (riskClass?: string) => plan({ assets: [{ id: 't', name: 'More stocks', value: 1_000_000, drawable: true, growthPercent: 5, temporary: true, riskClass }] })
    const noisy = { ...DEFAULT_SIM, runs: 200, inflationSpread: 0, spikeChancePercent: 0 }
    const asStocks = simulate(input('stocks'), noisy)
    const untyped = simulate(input(), noisy)
    expect(asStocks.nominal.bands[29].p10).toBeLessThan(asStocks.nominal.bands[29].p90)
    expect(untyped.nominal.bands[29].p10).toBeCloseTo(untyped.nominal.bands[29].p90, 6)
    expect(riskClassOf({ id: 't', name: 't', value: 1, drawable: true, riskClass: 'bonds' }, noisy, {})).toBe('bonds')
    // What is set in the stress test wins.
    expect(riskClassOf({ id: 't', name: 't', value: 1, drawable: true, riskClass: 'bonds' }, { ...noisy, classes: { t: 'cash' } }, {})).toBe('cash')
  })
})
