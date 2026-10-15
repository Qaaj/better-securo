/**
 * The retirement engine as a function of one JSON request, bundled for the server (see
 * `npm run build:engine`) so the MCP tools run exactly the code the Retirement page runs. Nothing here
 * touches the browser; the server hands in the plan, the recurring items and the assets.
 */
import { buildProjectionInputs, DEFAULT_PLAN, type Plan } from '@/lib/retirement-model'
import { CASH_ID, projectRetirement, type Projection, type ProjectionInput, type WhatIf } from '@/lib/retirement-projection'
import { DEFAULT_SIM, bufferSweepSync, simulate, sweepSync, type SimParams } from '@/lib/retirement-simulation'
import type { Asset, RecurringTransaction } from '@/types'

/** Changes to the plan for one run, named as a person would say them. */
export interface Overrides {
  livingMonthly?: number
  livingInflates?: boolean
  horizonYears?: number
  inflationPercent?: number
  incomeIndexed?: boolean
  drawdownStartYear?: number
  drawdownEndYear?: number | null
  sellStrategy?: 'pro_rata' | 'ordered'
  taxIncomePercent?: number
  taxYieldPercent?: number
  taxRentPercent?: number
  taxGainsPercent?: number
  bufferYears?: number
  /** Extra what-ifs, in the plan's own shape; ids are made up when missing. */
  addWhatIfs?: (Omit<WhatIf, 'id'> & { id?: string })[]
}

export interface EngineRequest {
  op: 'projection' | 'stress' | 'compare'
  currency: string
  /** The calendar year that is "year 0". */
  thisYear: number
  items: RecurringTransaction[]
  assets: Asset[]
  excluded: string[]
  plan: Partial<Plan>
  overrides?: Overrides
  /** For `compare`: saved scenarios by name; the current plan is added as "Current plan". */
  scenarios?: Record<string, Partial<Plan>>
  names?: string[]
  /** Stress test settings over the defaults. */
  sim?: Partial<SimParams>
  includeGrid?: boolean
  includeBuffers?: boolean
  runsPerCell?: number
  /** Also run the stress test for each scenario in `compare`. */
  withStress?: boolean
}

const round = (v: number, digits = 0) => Number(v.toFixed(digits))

function fullPlan(plan: Partial<Plan>, overrides: Overrides | undefined): Plan {
  const base: Plan = {
    ...DEFAULT_PLAN,
    ...plan,
    assumptions: { ...DEFAULT_PLAN.assumptions, ...(plan.assumptions ?? {}) },
  }
  if (!overrides) return base
  const a = { ...base.assumptions }
  if (overrides.horizonYears !== undefined) a.horizonYears = overrides.horizonYears
  if (overrides.inflationPercent !== undefined) a.inflationPercent = overrides.inflationPercent
  if (overrides.incomeIndexed !== undefined) a.incomeIndexed = overrides.incomeIndexed
  if (overrides.drawdownStartYear !== undefined) a.drawdownStartYear = overrides.drawdownStartYear
  if (overrides.drawdownEndYear !== undefined) a.drawdownEndYear = overrides.drawdownEndYear ?? undefined
  if (overrides.sellStrategy !== undefined) a.sellStrategy = overrides.sellStrategy
  if (overrides.taxIncomePercent !== undefined) a.taxIncomePercent = overrides.taxIncomePercent
  if (overrides.taxYieldPercent !== undefined) a.taxAssetIncomePercent = overrides.taxYieldPercent
  if (overrides.taxRentPercent !== undefined) a.taxRentPercent = overrides.taxRentPercent
  if (overrides.taxGainsPercent !== undefined) a.taxGainsPercent = overrides.taxGainsPercent
  if (overrides.bufferYears !== undefined) a.bufferYears = overrides.bufferYears
  const out: Plan = { ...base, assumptions: a }
  if (overrides.livingMonthly !== undefined || overrides.livingInflates !== undefined) {
    out.living = { monthly: overrides.livingMonthly ?? base.living?.monthly ?? 0, inflates: overrides.livingInflates ?? base.living?.inflates ?? true }
  }
  if (overrides.addWhatIfs?.length) {
    out.whatIfs = [...base.whatIfs, ...overrides.addWhatIfs.map((w, i) => ({ ...w, id: w.id ?? `extra-${i}` }) as WhatIf)]
  }
  return out
}

function prepare(req: EngineRequest, plan: Partial<Plan>, overrides: Overrides | undefined) {
  const full = fullPlan(plan, overrides)
  const built = buildProjectionInputs(full, req.items, req.assets, req.currency, new Set(req.excluded), req.thisYear)
  const input: ProjectionInput = { ...built.base, whatIfs: built.whatIfs }
  const names: Record<string, string> = { [CASH_ID]: 'cash buffer' }
  for (const a of built.projectionAssets) names[a.id] = a.name
  const types = Object.fromEntries(req.assets.map((a) => [a.id, a.type]))
  return { full, input, built, names, types }
}

function byName(record: Record<string, number>, names: Record<string, string>) {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => Math.abs(v) > 0.005).map(([id, v]) => [names[id] ?? id, round(v)]))
}

function projectionSummary(p: Projection, baseline: Projection | null, horizon: number) {
  const last = p.rows[horizon - 1]
  return {
    runwayYears: p.runwayYears === null ? `lasts all ${horizon} years` : round(p.runwayYears, 1),
    runwayYearsWithoutWhatIfs: baseline ? (baseline.runwayYears === null ? `lasts all ${horizon} years` : round(baseline.runwayYears, 1)) : undefined,
    assetsYouSellFromNow: round(p.drawableNow),
    netWorthNow: round(p.netWorthNow),
    assetsLeftAtHorizon: round(last?.drawable ?? 0),
    netWorthAtHorizon: round(last?.netWorth ?? 0),
    assetsLeftAtDrawdownEnd: p.leftAtEnd === null ? null : round(p.leftAtEnd),
    totalTax: round(p.totalTax),
    taxByKind: {
      income: round(p.rows.reduce((s, r) => s + r.taxKinds.income, 0)),
      yields: round(p.rows.reduce((s, r) => s + r.taxKinds.yield, 0)),
      rent: round(p.rows.reduce((s, r) => s + r.taxKinds.rent, 0)),
      gains: round(p.rows.reduce((s, r) => s + r.taxKinds.gains, 0)),
    },
  }
}

function runProjection(req: EngineRequest) {
  const { full, input, built, names } = prepare(req, req.plan, req.overrides)
  const scenario = projectRetirement(input)
  const baseline = full.whatIfs.length ? projectRetirement({ ...input, whatIfs: [] }) : null
  const horizon = full.assumptions.horizonYears
  return {
    currency: req.currency,
    startYear: req.thisYear,
    settingsUsed: {
      assumptions: full.assumptions,
      livingAndTravel: full.living ?? null,
      whatIfs: full.whatIfs,
      temporaryAssets: full.tempAssets,
      linesWithALastYear: full.lineEnd ?? {},
    },
    summary: projectionSummary(scenario, baseline, horizon),
    assets: built.projectionAssets.map((a) => ({
      name: a.name, value: round(a.value), sellFrom: a.drawable, growthPercentPerYear: a.growthPercent ?? 0, yieldPercent: a.yieldPercent ?? null,
      fixedIncomeMonthly: a.fixedMonthly ?? null, costBasis: a.costBasis ?? null, sellOrder: a.sellOrder ?? null,
    })),
    years: scenario.rows.map((r) => ({
      year: req.thisYear + r.year,
      phase: r.phase,
      income: round(r.income),
      outgoing: round(r.outgoing),
      tax: round(r.tax),
      netCashFlow: round(r.netFlow),
      soldFromAssets: byName(r.drawn, names),
      soldTotal: round(Object.values(r.drawn).reduce((s, v) => s + v, 0)),
      shortfallNotCovered: round(r.unfunded),
      assetsYouSellFromAtYearEnd: round(r.drawable),
      netWorthAtYearEnd: round(r.netWorth),
    })),
  }
}

function simParams(req: EngineRequest, types: Record<string, string>): SimParams {
  void types
  return { ...DEFAULT_SIM, runs: 1000, ...(req.sim ?? {}), classes: { ...DEFAULT_SIM.classes, ...(req.sim?.classes ?? {}) } }
}

function stressFor(req: EngineRequest, plan: Partial<Plan>, overrides: Overrides | undefined, grid: boolean, buffers: boolean) {
  const { full, input, types } = prepare(req, plan, overrides)
  const params = simParams(req, types)
  params.runs = Math.min(5000, Math.max(100, params.runs))
  const result = simulate(input, params, types)
  const view = params.todaysMoney ? result.real : result.nominal
  const bands = (b: typeof view) => b.bands.map((x) => ({ year: req.thisYear + x.year, p10: round(x.p10), p25: round(x.p25), median: round(x.p50), p75: round(x.p75), p90: round(x.p90) }))
  const cells = Math.min(1000, Math.max(100, req.runsPerCell ?? 300))
  return {
    futures: result.runs,
    chanceTheMoneyLasts: round(result.successRate, 3),
    medianRunOutYearIfItDoes: result.medianRunOutYear === null ? null : req.thisYear + result.medianRunOutYear,
    shownIn: params.todaysMoney ? "today's money" : 'future money',
    typicalAssetsLeftAtEnd: round(view.medianEnd),
    badLuckAssetsLeftAtEnd_worst1in20: round(view.worstCaseEnd),
    assetsYouSellFromByYear: bands(view),
    shareOfFuturesRunOutByYear: result.depletedBy.map((s, i) => ({ year: req.thisYear + i, share: round(s, 3) })),
    settings: {
      crashChancePercentPerYear: params.crashChancePercent, crashDepthPercent: [params.crashMinPercent, params.crashMaxPercent], slumpYears: params.slumpYears,
      slumpGrowthLostPercent: params.slumpCutPercent, marketSwingsScale: params.volatilityScale, inflationWobblePoints: params.inflationSpread,
      inflationSpikeChancePercent: params.spikeChancePercent, growthRatesIncludeCrashes: params.rateIncludesCrashes, seed: params.seed,
    },
    resilienceGrid: grid ? sweepSync(input, params, types, cells).map((c) => ({ spendingPercentOfPlan: Math.round(c.spend * 100), crashChancePercentPerYear: c.crash, chanceTheMoneyLasts: round(c.successRate, 3) })) : undefined,
    cashBufferComparison: buffers ? bufferSweepSync(input, params, types, cells).map((c) => ({ bufferYears: c.years, chanceTheMoneyLasts: round(c.successRate, 3), typicalAssetsLeftTodaysMoney: round(c.medianEnd) })) : undefined,
    horizonYears: full.assumptions.horizonYears,
  }
}

function runCompare(req: EngineRequest) {
  const all: Record<string, Partial<Plan>> = { 'Current plan': req.plan, ...(req.scenarios ?? {}) }
  const wanted = req.names?.length ? ['Current plan', ...req.names.filter((n) => n !== 'Current plan')] : Object.keys(all)
  const rows = wanted.filter((name) => name in all).map((name) => {
    const { full, input } = prepare(req, all[name], name === 'Current plan' ? req.overrides : undefined)
    const p = projectRetirement(input)
    const baseline = full.whatIfs.length ? projectRetirement({ ...input, whatIfs: [] }) : null
    return {
      scenario: name,
      livingAndTravelMonthly: full.living?.monthly ?? 0,
      drawdownStartsYear: req.thisYear + (full.assumptions.drawdownStartYear ?? 0),
      ...projectionSummary(p, baseline, full.assumptions.horizonYears),
      stressTest: req.withStress ? stressFor(req, all[name], name === 'Current plan' ? req.overrides : undefined, false, false).chanceTheMoneyLasts : undefined,
    }
  })
  return { currency: req.currency, scenarios: rows, missing: (req.names ?? []).filter((n) => !(n in all)) }
}

/** Entry point: a JSON request in, a JSON answer out. */
export function run(requestJson: string): string {
  try {
    const req = JSON.parse(requestJson) as EngineRequest
    const answer =
      req.op === 'projection' ? runProjection(req) : req.op === 'stress' ? stressFor(req, req.plan, req.overrides, !!req.includeGrid, !!req.includeBuffers) : runCompare(req)
    return JSON.stringify(answer)
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
  }
}
