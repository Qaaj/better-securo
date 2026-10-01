import { describe, expect, it } from 'vitest'
import i18n from '@/lib/i18n'
import { projectRetirement, type ProjectionAsset, type WhatIf } from './retirement-projection'
import { buildReport, chartSvg, describeWhatIf, reportToHtml, reportToMarkdown } from './retirement-report'

const t = i18n.t.bind(i18n) as unknown as Parameters<typeof buildReport>[0]['t']

const assets: ProjectionAsset[] = [
  { id: 'etf', name: 'ETF | World', value: 100_000, drawable: true, growthPercent: 5, yieldPercent: 2, sellOrder: 1 },
  { id: 'btc', name: 'Bitcoin', value: 50_000, drawable: true, growthPercent: 0, sellOrder: 2 },
  { id: 'flat', name: '<b>Flat</b>', value: 300_000, drawable: false, growthPercent: 2, fixedMonthly: 1_000, fixedFlat: true },
  { id: 'later', name: 'Inheritance', value: 40_000, drawable: true, temporary: true, startYear: 2, growthPercent: 1 },
]
const whatIfs: WhatIf[] = [
  { id: '1', kind: 'expense', label: 'Baby', monthly: 800, fromYear: 1, inflates: false },
  { id: '2', kind: 'sell', label: 'Sell flat', assetId: 'flat', year: 5, feesPercent: 8 },
]

function report(withWhatIfs: boolean) {
  const assumptions = { horizonYears: 4, inflationPercent: 2, incomeIndexed: true, drawdownStartYear: 1, drawdownEndYear: 3, sellStrategy: 'ordered' as const }
  const input = { recurringIncomeMonthly: 500, outgoingMonthly: 2_000, assets, assumptions }
  return buildReport({
    t, currency: 'EUR', locale: 'en-US', now: new Date(2027, 0, 15), assumptions,
    whatIfs: withWhatIfs ? whatIfs : [],
    scenario: projectRetirement({ ...input, whatIfs: withWhatIfs ? whatIfs : [] }),
    baseline: projectRetirement({ ...input, whatIfs: [] }),
    assets, fixedLines: [{ label: 'Mortgage', monthly: 1_270 }],
  })
}

describe('buildReport', () => {
  it('summarises the plan, its assumptions and its what-ifs in words', () => {
    const r = report(true)
    expect(r.title).toBe('Retirement plan')
    expect(r.subtitle).toContain('All amounts in EUR')
    expect(r.summary.map((s) => s.label)).toEqual(expect.arrayContaining(['Runway', 'Runway without what-ifs', 'Net worth today']))
    expect(r.assumptions.find((a) => a.label === 'Inflation')?.value).toBe('2%')
    expect(r.assumptions.find((a) => a.label === 'Drawdown starts')?.value).toBe('2028')
    expect(r.assumptions.find((a) => a.label === 'Drawdown ends')?.value).toBe('2030')
    expect(r.subtitle).toContain('January 15, 2027')
    expect(r.whatIfs[0]).toContain('Baby')
    expect(r.whatIfs[0]).toContain('stays the same')
    expect(r.fixed).toEqual(['Mortgage (€1,270/mo)'])
  })

  it('has a row per year and a column per asset, those sold from first', () => {
    const r = report(false)
    expect(r.years.rows).toHaveLength(4)
    expect(r.years.rows[0][0]).toBe('2027')
    expect(r.years.rows[0][1]).toBe('Saving') // before the drawdown start
    const headers = r.years.headers
    expect(headers.indexOf('ETF | World')).toBeLessThan(headers.indexOf('Total'))
    expect(headers.indexOf('Total')).toBeLessThan(headers.indexOf('<b>Flat</b>'))
    expect(r.years.rows.every((row) => row.length === headers.length)).toBe(true)
  })

  it('marks a temporary asset and lists the sell order only when selling in order', () => {
    const r = report(false)
    const later = r.assets.rows.find((row) => row[0].startsWith('Inheritance'))!
    expect(later[0]).toContain('temporary 2029')
    expect(r.assets.rows.find((row) => row[0] === 'Bitcoin')![6]).toBe('2')
  })

  it('only carries a baseline line when there are what-ifs', () => {
    expect(report(true).chart.baseline).not.toBeNull()
    expect(report(false).chart.baseline).toBeNull()
  })
})

describe('reportToMarkdown', () => {
  it('writes headed sections and escapes pipes in table cells', () => {
    const md = reportToMarkdown(report(true))
    expect(md).toMatch(/^# Retirement plan\n/)
    for (const h of ['## Summary', '## Assumptions', '## What if…', '## Assets', '## Year by year']) expect(md).toContain(h)
    expect(md).toContain('ETF \\| World')
    expect(md).toContain('- **Runway:**')
    expect(md).toMatch(/\| Year \| Phase \|/)
    expect(md).toContain('## Amounts that stay the same')
  })

  it('says so when there are no what-ifs', () => {
    expect(reportToMarkdown(report(false))).toMatch(/## What if…\n\n- None/)
  })
})

describe('reportToHtml', () => {
  it('is a standalone page with the chart and both tables, and escapes names', () => {
    const html = reportToHtml(report(true))
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<svg')
    expect(html).toContain('<polyline')
    expect(html.match(/<table/g)).toHaveLength(2)
    expect(html).toContain('&lt;b&gt;Flat&lt;/b&gt;')
    expect(html).not.toContain('<b>Flat</b>')
    expect(html).toContain('@page { size: A4 landscape')
  })
})

describe('chartSvg', () => {
  it('draws the scenario and, when given, a dashed baseline', () => {
    const labels = { scenario: 'Plan', baseline: 'Baseline' }
    const one = chartSvg({ labels: ['2027', '2028', '2029'], scenario: [3, 2, 1], baseline: null }, labels)
    expect(one.match(/<polyline/g)).toHaveLength(1)
    const two = chartSvg({ labels: ['2027', '2028', '2029'], scenario: [3, 2, 1], baseline: [3, 3, 3] }, labels)
    expect(two.match(/<polyline/g)).toHaveLength(2)
    expect(two).toContain('stroke-dasharray')
  })

  it('does not break on an empty or all-zero series', () => {
    expect(() => chartSvg({ labels: ['2027'], scenario: [0], baseline: null }, { scenario: 'a', baseline: 'b' })).not.toThrow()
  })
})

describe('describeWhatIf', () => {
  it('describes each kind', () => {
    expect(describeWhatIf(t, { id: 'a', kind: 'oneoff', label: 'x', amount: -5_000, year: 2 }, 2027)).toContain('2029')
    expect(describeWhatIf(t, { id: 'b', kind: 'sell', label: 'x', assetId: 'a', year: 1, feesPercent: 7 }, 2027)).toContain('2028')
  })
})
