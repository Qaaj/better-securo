/**
 * A Monte Carlo run of the retirement projection.
 *
 * The plan's own growth rate for each asset is its long-run average yearly
 * growth, crashes included (a historical figure already contains them), unless
 * that is switched off. Each simulated future then draws, year by year, a random return around it (most
 * of it shared across assets, like a real market), an occasional crash that
 * hits risky assets hard and safer ones less, a slump of weaker growth after a
 * crash, and an inflation path that wanders and can spike. Every future is
 * run through the same engine as the plan, so incomes, costs, what-ifs and the
 * order of selling all apply. The result is how often the assets last, not a
 * forecast.
 */
import { projectRetirement, type MarketPath, type ProjectionAsset, type ProjectionInput } from './retirement-projection'

export type RiskClass = 'stocks' | 'bonds' | 'property' | 'cash' | 'fixed'

export const RISK_CLASSES: RiskClass[] = ['stocks', 'bonds', 'property', 'cash', 'fixed']

/** How each class behaves: ordinary yearly swings and how much of a crash it takes. */
const CLASS_TRAITS: Record<RiskClass, { volatility: number; crashShare: number }> = {
  stocks: { volatility: 16, crashShare: 1 },
  bonds: { volatility: 6, crashShare: 0.25 },
  property: { volatility: 9, crashShare: 0.4 },
  cash: { volatility: 1, crashShare: 0 },
  fixed: { volatility: 0, crashShare: 0 },
}

export interface SimParams {
  runs: number
  seed: number
  /** Scales the ordinary yearly swings of every class (1 = typical). */
  volatilityScale: number
  /** Chance of a crash in any year, percent. */
  crashChancePercent: number
  /** A crash costs stocks between these two, percent (positive numbers). */
  crashMinPercent: number
  crashMaxPercent: number
  /** Years of weaker growth after a crash, and how much of the expected growth is lost, percent. */
  slumpYears: number
  slumpCutPercent: number
  /** How far inflation wanders from the plan's rate year to year, in percentage points. */
  inflationSpread: number
  /** Chance a year starts a spell of higher inflation, percent, and the extra points it adds for three years. */
  spikeChancePercent: number
  spikeExtraPoints: number
  /**
   * The growth rate in the plan is a long-run average that already contains crashes, so the typical future matches
   * the projection and crashes show up as risk around it. Off: the rate is an ordinary year's return and crashes come on top.
   */
  rateIncludesCrashes: boolean
  /** Show outcomes in today's money rather than future money. */
  todaysMoney: boolean
  /** The risk class each asset (by id) is treated as; unset assets follow their type. */
  classes: Record<string, RiskClass>
}

export const DEFAULT_SIM: SimParams = {
  runs: 1000,
  seed: 1,
  volatilityScale: 1,
  crashChancePercent: 8,
  crashMinPercent: 30,
  crashMaxPercent: 40,
  slumpYears: 2,
  slumpCutPercent: 50,
  inflationSpread: 1.5,
  spikeChancePercent: 3,
  spikeExtraPoints: 5,
  rateIncludesCrashes: true,
  todaysMoney: true,
  classes: {},
}

/** What an asset is treated as unless you say otherwise. */
export function defaultRiskClass(type: string): RiskClass {
  if (type === 'investment') return 'stocks'
  if (type === 'real_estate') return 'property'
  if (type === 'cash' || type === 'bank_account') return 'cash'
  return 'fixed'
}

/** A small seedable generator, so the same inputs give the same answer. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

/** Share of an asset's yearly swing that moves with the market as a whole. */
const MARKET_WEIGHT = 0.7

const calibrationCache = new Map<string, number>()

/**
 * The ordinary-year return that makes the long-run compound growth of an asset,
 * with this crash and swing model, equal `expected`. It is solved once on a long
 * fixed run of random years (so it does not vary between calls), then reused.
 */
export function calibratedMean(cls: RiskClass, expected: number, params: SimParams): number {
  if (cls === 'fixed') return expected
  const key = [cls, expected, params.volatilityScale, params.crashChancePercent, params.crashMinPercent, params.crashMaxPercent, params.slumpYears, params.slumpCutPercent].join('|')
  const hit = calibrationCache.get(key)
  if (hit !== undefined) return hit

  const traits = CLASS_TRAITS[cls]
  const sigma = traits.volatility * params.volatilityScale
  const n = 20000
  const rng = makeRng(987654321)
  const z = new Float64Array(n)
  const crash = new Float64Array(n)
  const slump = new Uint8Array(n)
  let slumpLeft = 0
  const span = Math.max(0, params.crashMaxPercent - params.crashMinPercent)
  for (let i = 0; i < n; i++) {
    z[i] = normal(rng)
    const crashed = rng() < params.crashChancePercent / 100
    crash[i] = crashed ? params.crashMinPercent + rng() * span : -1
    slump[i] = slumpLeft > 0 ? 1 : 0
    if (slumpLeft > 0) slumpLeft -= 1
    if (crashed) slumpLeft = params.slumpYears
  }
  const cut = 1 - params.slumpCutPercent / 100
  const growth = (mean: number) => {
    let total = 0
    for (let i = 0; i < n; i++) {
      const rate = crash[i] >= 0 && traits.crashShare > 0 ? -crash[i] * traits.crashShare : (slump[i] ? mean * cut : mean) + sigma * z[i]
      total += Math.log(1 + Math.max(-95, rate) / 100)
    }
    return total / n
  }
  const target = Math.log(1 + expected / 100)
  let low = -60
  let high = 120
  for (let step = 0; step < 40; step++) {
    const mid = (low + high) / 2
    if (growth(mid) < target) low = mid
    else high = mid
  }
  const solved = (low + high) / 2
  if (calibrationCache.size > 500) calibrationCache.clear()
  calibrationCache.set(key, solved)
  return solved
}

/** Draw one possible future. */
export function drawMarket(
  rng: () => number,
  params: SimParams,
  years: number,
  baseInflationPercent: number,
  classOf: (asset: ProjectionAsset) => RiskClass,
): MarketPath {
  const inflation: number[] = []
  let drift = 0
  let spellLeft = 0
  const marketShock: number[] = []
  const crashDepth: (number | null)[] = []
  const slump: boolean[] = []
  let slumpLeft = 0

  for (let y = 0; y < years; y++) {
    drift = 0.6 * drift + params.inflationSpread * Math.sqrt(1 - 0.36) * normal(rng)
    if (spellLeft === 0 && rng() < params.spikeChancePercent / 100) spellLeft = 3
    const extra = spellLeft > 0 ? params.spikeExtraPoints : 0
    if (spellLeft > 0) spellLeft -= 1
    inflation.push(Math.max(-2, baseInflationPercent + drift + extra))

    marketShock.push(normal(rng))
    const crashed = rng() < params.crashChancePercent / 100
    const span = Math.max(0, params.crashMaxPercent - params.crashMinPercent)
    crashDepth.push(crashed ? params.crashMinPercent + rng() * span : null)
    slump.push(slumpLeft > 0)
    if (slumpLeft > 0) slumpLeft -= 1
    if (crashed) slumpLeft = params.slumpYears
  }

  // Each asset has its own idiosyncratic noise, drawn lazily and kept for the run.
  const own = new Map<string, number[]>()
  const noise = (id: string) => {
    let list = own.get(id)
    if (!list) {
      list = Array.from({ length: years }, () => normal(rng))
      own.set(id, list)
    }
    return list
  }

  return {
    inflationPercent: inflation,
    growthPercent: (asset, year) => {
      const cls = classOf(asset)
      const traits = CLASS_TRAITS[cls]
      if (cls === 'fixed') return undefined
      const expected = asset.growthPercent ?? 0
      const anchored = params.rateIncludesCrashes ? calibratedMean(cls, expected, params) : expected
      const mean = slump[year] ? anchored * (1 - params.slumpCutPercent / 100) : anchored
      const sigma = traits.volatility * params.volatilityScale
      const z = MARKET_WEIGHT * marketShock[year] + Math.sqrt(1 - MARKET_WEIGHT ** 2) * noise(asset.id)[year]
      const ordinary = mean + sigma * z
      const crash = crashDepth[year]
      const value = crash !== null && traits.crashShare > 0 ? -crash * traits.crashShare : ordinary
      return Math.max(-95, value)
    },
  }
}

export interface Bands {
  /** Percentiles of the drawable assets at the end of each year, 10/25/50/75/90. */
  bands: { year: number; p10: number; p25: number; p50: number; p75: number; p90: number }[]
  /** Drawable assets left at the end in the worst 5% of futures. */
  worstCaseEnd: number
  medianEnd: number
}

export interface SimResult {
  runs: number
  /** Share of futures where the assets lasted the whole horizon, 0..1. */
  successRate: number
  /** Outcomes in future money, and in today's money (each future's own inflation taken out). */
  nominal: Bands
  real: Bands
  /** For each year, the share of futures that had run out by then, 0..1. */
  depletedBy: number[]
  /** Median year the assets ran out among the futures that ran out, or null if none did. */
  medianRunOutYear: number | null
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

/** How the stress test treats an asset: what you set for it, else its own class (temporary assets), else its type. */
export function riskClassOf(asset: ProjectionAsset, params: SimParams, types: Record<string, string>): RiskClass {
  const own = asset.riskClass
  return params.classes[asset.id] ?? (own && (RISK_CLASSES as string[]).includes(own) ? (own as RiskClass) : defaultRiskClass(types[asset.id] ?? ''))
}

function classifier(params: SimParams, types: Record<string, string>) {
  return (asset: ProjectionAsset): RiskClass => riskClassOf(asset, params, types)
}

/** Run many futures through the projection. `types` maps asset id to its type, for default risk classes. */
export function simulate(input: ProjectionInput, params: SimParams, types: Record<string, string> = {}): SimResult {
  const years = input.assumptions.horizonYears
  const rng = makeRng(params.seed)
  const classOf = classifier(params, types)
  const nominalYears: number[][] = Array.from({ length: years }, () => [])
  const realYears: number[][] = Array.from({ length: years }, () => [])
  const depletedAt: number[] = []
  let lasted = 0

  for (let run = 0; run < params.runs; run++) {
    const market = drawMarket(rng, params, years, input.assumptions.inflationPercent, classOf)
    const projection = projectRetirement({ ...input, market })
    if (projection.runwayYears === null) lasted += 1
    else depletedAt.push(Math.floor(projection.runwayYears))
    projection.rows.forEach((row, i) => {
      nominalYears[i].push(row.drawable)
      realYears[i].push(row.drawable / row.deflator)
    })
  }

  const summarise = (perYear: number[][]): Bands => {
    const bands = perYear.map((values, year) => {
      const sorted = [...values].sort((a, b) => a - b)
      return {
        year,
        p10: percentile(sorted, 10),
        p25: percentile(sorted, 25),
        p50: percentile(sorted, 50),
        p75: percentile(sorted, 75),
        p90: percentile(sorted, 90),
      }
    })
    const ends = [...(perYear[years - 1] ?? [])].sort((a, b) => a - b)
    return { bands, worstCaseEnd: percentile(ends, 5), medianEnd: percentile(ends, 50) }
  }

  const depletedBy = Array.from({ length: years }, (_, year) => depletedAt.filter((d) => d <= year).length / params.runs)
  const sortedDepleted = [...depletedAt].sort((a, b) => a - b)
  return {
    runs: params.runs,
    successRate: lasted / params.runs,
    nominal: summarise(nominalYears),
    real: summarise(realYears),
    depletedBy,
    medianRunOutYear: sortedDepleted.length ? percentile(sortedDepleted, 50) : null,
  }
}

/** The input with every planned monthly cost scaled, to ask "what if I spent more or less". */
export function scaleSpending(input: ProjectionInput, factor: number): ProjectionInput {
  return {
    ...input,
    outgoingMonthly: input.outgoingMonthly * factor,
    outgoingFlatMonthly: (input.outgoingFlatMonthly ?? 0) * factor,
    whatIfs: input.whatIfs.map((w) => (w.kind === 'expense' || w.kind === 'spend' ? { ...w, monthly: w.monthly * factor } : w)),
  }
}

export interface SweepCell {
  spend: number
  crash: number
  successRate: number
}

/** Futures run for each cell of the resilience grid and the buffer comparison. */
export const SWEEP_RUNS = 300

export const SWEEP_SPEND = [0.8, 0.9, 1, 1.1, 1.25, 1.5]
export const SWEEP_CRASH = [0, 5, 10, 15, 25]

/** Success rate across a grid of spending levels and crash chances. Yields between rows so the page stays responsive. */
export async function sweep(
  input: ProjectionInput,
  params: SimParams,
  types: Record<string, string>,
  runsPerCell: number,
  signal?: { cancelled: boolean },
): Promise<SweepCell[]> {
  const cells: SweepCell[] = []
  for (const crash of SWEEP_CRASH) {
    for (const spend of SWEEP_SPEND) {
      if (signal?.cancelled) return cells
      const result = simulate(scaleSpending(input, spend), { ...params, runs: runsPerCell, crashChancePercent: crash }, types)
      cells.push({ spend, crash, successRate: result.successRate })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return cells
}

export interface BufferCell {
  years: number
  successRate: number
  /** Median drawable assets at the end, in today's money. */
  medianEnd: number
}

export const BUFFER_YEARS = [0, 1, 2, 3, 5]

/** The same futures with different cash buffers, to see what holding cash is worth. */
export async function bufferSweep(
  input: ProjectionInput,
  params: SimParams,
  types: Record<string, string>,
  runs: number,
  signal?: { cancelled: boolean },
): Promise<BufferCell[]> {
  const cells: BufferCell[] = []
  for (const years of BUFFER_YEARS) {
    if (signal?.cancelled) return cells
    const withBuffer = { ...input, assumptions: { ...input.assumptions, bufferYears: years } }
    const result = simulate(withBuffer, { ...params, runs }, types)
    cells.push({ years, successRate: result.successRate, medianEnd: result.real.medianEnd })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return cells
}
