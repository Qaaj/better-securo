import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { run, type EngineRequest } from './server-entry'

const asset = (over: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Fund', type: 'investment', currency: 'EUR', current_value: 120_000, current_value_primary: null, is_archived: false, sell_date: null,
  growth_type: null, growth_rate: null, growth_frequency: null, income_mode: null, income_rate: null, income_amount: null, income_frequency: null,
  sell_percent_per_year: null, purchase_price: null, ...over,
})
const item = (over: Record<string, unknown> = {}) => ({ id: 'r1', description: 'Rent', amount: 500, currency: 'EUR', type: 'debit', frequency: 'monthly', is_active: true, amount_primary: 500, ...over })

const base = (over: Partial<EngineRequest> = {}): EngineRequest =>
  ({ op: 'projection', currency: 'EUR', thisYear: 2026, items: [], assets: [asset()] as never, excluded: [], plan: { assumptions: { horizonYears: 30, inflationPercent: 0, incomeIndexed: true } }, ...over }) as EngineRequest

const answer = (req: EngineRequest) => JSON.parse(run(JSON.stringify(req)))

describe('retirement engine entry', () => {
  it('runs the projection on a request and returns the runway and a table', () => {
    const r = answer(base({ overrides: { livingMonthly: 1_000 } }))
    expect(r.summary.runwayYears).toBe(10)
    expect(r.years).toHaveLength(30)
    expect(r.years[0]).toMatchObject({ year: 2026, soldTotal: 12_000 })
    expect(r.assets[0]).toMatchObject({ name: 'Fund', value: 120_000, sellFrom: true })
  })

  it('counts recurring costs and lets overrides change one run', () => {
    const plain = answer(base({ items: [item()] as never }))
    expect(plain.summary.runwayYears).toBe(20)
    const tighter = answer(base({ items: [item()] as never, overrides: { livingMonthly: 500 } }))
    expect(tighter.summary.runwayYears).toBe(10)
    const taxed = answer(base({ items: [item()] as never, overrides: { taxGainsPercent: 30 }, assets: [asset({ purchase_price: 0 })] as never }))
    expect(taxed.summary.totalTax).toBeGreaterThan(0)
    expect(taxed.summary.runwayYears).toBeLessThan(20)
  })

  it('adds what-ifs and reports the runway without them', () => {
    const r = answer(base({ items: [item()] as never, overrides: { addWhatIfs: [{ kind: 'income', label: 'Side job', monthly: 500, fromYear: 0, inflates: false }] } }))
    expect(r.summary.runwayYears).toMatch(/lasts all/)
    expect(r.summary.runwayYearsWithoutWhatIfs).toBe(20)
  })

  it('runs the stress test with settings over the defaults', () => {
    const r = answer(base({ op: 'stress', items: [item()] as never, sim: { runs: 300, seed: 3 }, includeGrid: true, includeBuffers: true, runsPerCell: 100 }))
    expect(r.futures).toBe(300)
    expect(r.chanceTheMoneyLasts).toBeGreaterThanOrEqual(0)
    expect(r.chanceTheMoneyLasts).toBeLessThanOrEqual(1)
    expect(r.assetsYouSellFromByYear).toHaveLength(30)
    expect(r.resilienceGrid.length).toBe(30)
    expect(r.cashBufferComparison.map((c: { bufferYears: number }) => c.bufferYears)).toEqual([0, 1, 2, 3, 5])
    expect(answer(base({ op: 'stress', items: [item()] as never, sim: { runs: 300, seed: 3 } })).chanceTheMoneyLasts).toBe(r.chanceTheMoneyLasts)
  })

  it('compares the current plan with saved scenarios', () => {
    const lean = { assumptions: { horizonYears: 30, inflationPercent: 0, incomeIndexed: true }, living: { monthly: 200, inflates: true } }
    const r = answer(base({ op: 'compare', items: [item()] as never, scenarios: { Lean: lean }, names: ['Lean', 'Missing'] }))
    expect(r.scenarios.map((s: { scenario: string }) => s.scenario)).toEqual(['Current plan', 'Lean'])
    expect(r.scenarios[1].livingAndTravelMonthly).toBe(200)
    expect(r.scenarios[1].runwayYears).toBeLessThan(r.scenarios[0].runwayYears)
    expect(r.missing).toEqual(['Missing'])
  })

  it('answers a broken request with an error instead of throwing', () => {
    expect(JSON.parse(run('not json')).error).toBeTruthy()
  })
})

describe('the committed bundle', () => {
  it('is what the current source builds to', async () => {
    const out = await build({ configFile: path.resolve(import.meta.dirname, '../../vite.engine.config.ts'), logLevel: 'silent', build: { write: false } })
    const result = Array.isArray(out) ? out[0] : out
    const chunk = ('output' in result ? result.output[0] : { code: '' }) as { code: string }
    const committed = readFileSync(path.resolve(import.meta.dirname, '../../engine-dist/retirement_engine.js'), 'utf8')
    const sidecar = readFileSync(path.resolve(import.meta.dirname, '../../engine-dist/retirement_engine.sha256'), 'utf8').trim()
    expect(createHash('sha256').update(committed).digest('hex')).toBe(sidecar)
    // If this fails, run scripts/build-engine.sh and commit the result.
    expect(chunk.code.trimEnd()).toBe(committed.trimEnd())
  }, 60000)
})
