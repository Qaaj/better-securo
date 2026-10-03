import { describe, expect, it } from 'vitest'
import i18n from '@/lib/i18n'
import { buildFullReportHtml } from './retirement-full-report'
import { projectRetirement, type ProjectionAsset } from './retirement-projection'
import { DEFAULT_SIM, bufferSweep, simulate, sweep } from './retirement-simulation'

const t = i18n.t.bind(i18n) as unknown as (key: string, options?: Record<string, unknown>) => string

const stocks: ProjectionAsset = { id: 's', name: 'Index fund', value: 200_000, drawable: true, growthPercent: 5, costBasis: 100_000 }
const house: ProjectionAsset = { id: 'h', name: 'House', value: 300_000, drawable: false, growthPercent: 2 }

async function report(withSim: boolean) {
  const assumptions = { horizonYears: 12, inflationPercent: 2, incomeIndexed: true, taxGainsPercent: 20, drawdownStartYear: 0 }
  const base = { recurringIncomeMonthly: 0, outgoingMonthly: 2_000, assets: [stocks, house], assumptions, whatIfs: [] }
  const scenario = projectRetirement(base)
  const types = { s: 'investment', h: 'real_estate' }
  const params = { ...DEFAULT_SIM, runs: 100 }
  const simulation = withSim
    ? {
        params,
        result: simulate(base, params, types),
        grid: await sweep(base, params, types, 50),
        buffers: await bufferSweep(base, params, types, 50),
        behaviour: [{ name: 'Index fund', riskClass: 'stocks' }],
        runsPerCell: 50,
      }
    : null
  return buildFullReportHtml({
    t,
    currency: 'EUR',
    locale: 'en-US',
    now: new Date('2026-10-03'),
    assumptions,
    whatIfs: [],
    scenario,
    baseline: scenario,
    assets: [stocks, house],
    fixedLines: [],
    endedLines: [{ label: 'Loan', year: 2030 }],
    simulation,
  })
}

describe('full retirement report', () => {
  it('has every section, the sold-off breakdown and the other assets', async () => {
    const html = await report(true)
    for (const id of ['summary', 'projection', 'settings', 'sold', 'others', 'simulation', 'years']) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('Assets sold off')
    expect(html).toContain('Index fund')
    expect(html).toContain('House')
    expect(html).toContain('Loan: counts until the end of 2030')
    expect(html).toContain('Where is it resilient?')
    expect(html).toContain('What is a cash buffer worth?')
    expect(html).toContain('<svg')
  })

  it('works without the stress test and escapes text', async () => {
    const html = await report(false)
    expect(html).toContain('The stress test was not included.')
    expect(html).not.toContain('<script')
  })
})
