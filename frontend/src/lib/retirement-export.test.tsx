import { describe, expect, it } from 'vitest'
import i18n from '@/lib/i18n'
import { buildExportCsv, buildExportJson, type ExportExtras } from './retirement-export'
import { projectRetirement, type ProjectionAsset } from './retirement-projection'
import { DEFAULT_SIM, bufferSweep, simulate, sweep } from './retirement-simulation'
import type { FullReportInput } from './retirement-full-report'

const t = i18n.t.bind(i18n) as unknown as FullReportInput['t']
const fund: ProjectionAsset = { id: 'f', name: 'Index, fund', value: 200_000, drawable: true, growthPercent: 5, costBasis: 100_000, gainsTaxPercent: 10, sellOrder: 1 }
const house: ProjectionAsset = { id: 'h', name: 'House', value: 300_000, drawable: false, growthPercent: 2, fixedMonthly: 800, rentTaxPercent: 0 }
const extras: ExportExtras = {
  defaultTaxPercent: { income: 20, yield: 15, rent: 0, gains: 25 },
  incomeLines: [{ label: 'Pension', monthly: 1500, counted: true, risesWithInflation: true, taxRatePercent: 5 }],
  costLines: [{ label: 'Insurance', monthly: 90, counted: true, risesWithInflation: true, lastYear: 2035 }],
}

async function input(withSim: boolean): Promise<FullReportInput> {
  const assumptions = { horizonYears: 8, inflationPercent: 2, incomeIndexed: true, taxGainsPercent: 25, bufferYears: 1, sellStrategy: 'ordered' as const }
  const base = { recurringIncomeMonthly: 0, outgoingMonthly: 2_000, assets: [fund, house], assumptions, whatIfs: [] }
  const scenario = projectRetirement(base)
  const params = { ...DEFAULT_SIM, runs: 60 }
  const types = { f: 'investment', h: 'real_estate' }
  return {
    t, currency: 'EUR', locale: 'en-US', now: new Date('2026-10-04'), assumptions, whatIfs: [], scenario, baseline: scenario,
    assets: [fund, house], fixedLines: [], endedLines: [], taxLines: [{ label: 'Index, fund', kind: 'gains', rate: 10 }],
    living: { monthly: 1800, inflates: true },
    simulation: withSim
      ? { params, result: simulate(base, params, types), grid: await sweep(base, params, types, 30), buffers: await bufferSweep(base, params, types, 30), behaviour: [{ name: 'Index, fund', riskClass: 'stocks' }], runsPerCell: 30 }
      : null,
  }
}

describe('JSON export', () => {
  it('carries every setting and the results', async () => {
    const doc = JSON.parse(buildExportJson(await input(true), extras))
    expect(doc.about.currency).toBe('EUR')
    expect(doc.settings.horizonYears).toBe(8)
    expect(doc.settings.cashBufferYears).toBe(1)
    expect(doc.settings.livingAndTravel).toEqual({ monthly: 1800, risesWithInflation: true })
    expect(doc.settings.tax.defaultRatesPercent.gains).toBe(25)
    expect(doc.settings.tax.ratesSetPerLine).toEqual([{ line: 'Index, fund', kind: 'gains', ratePercent: 10 }])
    expect(doc.settings.drawdown.sellStrategy).toContain('order')
    expect(doc.recurring.costs[0]).toMatchObject({ label: 'Insurance', lastYear: 2035 })
    expect(doc.assets[0]).toMatchObject({ name: 'Index, fund', sellFrom: true, sellOrder: 1, costBasis: 100000, taxRatesPercent: { gains: 10 } })
    expect(doc.projection.years).toHaveLength(8)
    expect(doc.projection.years[0].year).toBe(2026)
    expect(doc.stressTest.settings.crashChancePercentPerYear).toBe(8)
    expect(doc.stressTest.results.chanceTheMoneyLasts).toBeGreaterThanOrEqual(0)
    expect(doc.stressTest.results.todaysMoney.assetsYouSellFromByYear).toHaveLength(8)
    expect(doc.stressTest.resilienceGrid.cells.length).toBeGreaterThan(0)
    expect(doc.stressTest.cashBufferComparison.cells.length).toBe(5)
  })

  it('leaves the stress test out when it was not run', async () => {
    expect(JSON.parse(buildExportJson(await input(false), extras)).stressTest).toBeNull()
  })
})

describe('CSV export', () => {
  it('has a header, a row per year and quotes names with commas', async () => {
    const csv = buildExportCsv(await input(true))
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[0]).toContain('tax_gains')
    expect(lines[0]).toContain('"value: Index, fund"')
    expect(lines[0]).toContain('sim_share_run_out')
    expect(lines[1].startsWith('2026,')).toBe(true)
  })

  it('has no simulation columns without a stress test', async () => {
    expect((buildExportCsv(await input(false)).split('\n')[0])).not.toContain('sim_')
  })
})
