/**
 * A year-by-year projection of the money you could spend from.
 *
 * Each year: outgoings (inflated) are paid from income (recurring credits,
 * asset yields, fixed rentals, planned sales and what-if items). A shortfall
 * is drawn pro rata from the drawable assets, a surplus is added to them, then
 * the assets grow. Runway is how long the drawable assets last.
 *
 * It is a planning aid, not a forecast: no taxes, no loan amortisation, one
 * growth rate for everything drawable.
 */

export interface ProjectionAsset {
  id: string
  name: string
  /** Value in the display currency; negative = a liability. */
  value: number
  /** Money you would spend from. */
  drawable: boolean
  /** % of the value paid out a year. */
  yieldPercent?: number
  /** Fixed income per month, in the display currency (a rental). */
  fixedMonthly?: number
  /** % of the holding sold each year. */
  sellPercent?: number
}

export interface Assumptions {
  horizonYears: number
  inflationPercent: number
  /** Growth of the drawable assets, % a year. */
  growthPercent: number
  /** Growth of everything else you own (property, vehicles), % a year. */
  propertyGrowthPercent: number
  /** Whether income rises with inflation like outgoings do. */
  incomeIndexed: boolean
}

export type WhatIf =
  | { id: string; kind: 'income' | 'expense'; label: string; monthly: number; fromYear: number; toYear?: number }
  | { id: string; kind: 'oneoff'; label: string; amount: number; year: number }
  | { id: string; kind: 'sell'; label: string; assetId: string; year: number; feesPercent: number }

export interface ProjectionInput {
  /** Counted recurring income per month, today's money. */
  recurringIncomeMonthly: number
  /** Counted outgoings per month, today's money. */
  outgoingMonthly: number
  assets: ProjectionAsset[]
  assumptions: Assumptions
  whatIfs: WhatIf[]
}

export interface YearRow {
  /** 0 = this year. */
  year: number
  /** Drawable assets at the end of the year. */
  drawable: number
  /** Everything owned minus liabilities at the end of the year. */
  netWorth: number
  income: number
  outgoing: number
  /** Income minus outgoings; negative = drawn from assets. */
  netFlow: number
  /** What could not be paid because the drawable assets ran out. */
  unfunded: number
}

export interface Projection {
  rows: YearRow[]
  /** Years until the drawable assets run out, or null if they last the horizon. */
  runwayYears: number | null
  drawableNow: number
  netWorthNow: number
}

const CASH_ID = '__cash__'

function active(item: { fromYear: number; toYear?: number }, year: number): boolean {
  return year >= item.fromYear && (item.toYear === undefined || year <= item.toYear)
}

export function projectRetirement(input: ProjectionInput): Projection {
  const { assumptions: a } = input
  const inflation = a.inflationPercent / 100
  const growth = a.growthPercent / 100
  const propertyGrowth = a.propertyGrowthPercent / 100

  // Mutable working copy; surplus with nowhere to go collects in a cash bucket.
  const state = input.assets.map((asset) => ({ ...asset, held: true }))
  state.push({ id: CASH_ID, name: 'cash', value: 0, drawable: true, held: true })
  const liabilities = state.filter((s) => s.value < 0).reduce((sum, s) => sum + s.value, 0)
  const holdings = state.filter((s) => s.value >= 0)

  const drawableTotal = () => holdings.filter((h) => h.held && h.drawable).reduce((sum, h) => sum + h.value, 0)
  const ownedTotal = () => holdings.filter((h) => h.held).reduce((sum, h) => sum + h.value, 0)

  const drawableNow = drawableTotal()
  const netWorthNow = ownedTotal() + liabilities
  const rows: YearRow[] = []
  let runwayYears: number | null = null

  for (let year = 0; year < a.horizonYears; year++) {
    const inflate = (1 + inflation) ** year
    const incomeInflate = a.incomeIndexed ? inflate : 1

    let income = input.recurringIncomeMonthly * 12 * incomeInflate
    let outgoing = input.outgoingMonthly * 12 * inflate
    let oneOffs = 0

    for (const w of input.whatIfs) {
      if (w.kind === 'income' && active(w, year)) income += w.monthly * 12 * incomeInflate
      if (w.kind === 'expense' && active(w, year)) outgoing += w.monthly * 12 * inflate
      if (w.kind === 'oneoff' && w.year === year) oneOffs += w.amount
      if (w.kind === 'sell' && w.year === year) {
        const asset = holdings.find((h) => h.id === w.assetId && h.held)
        if (asset) {
          oneOffs += asset.value * (1 - w.feesPercent / 100)
          asset.value = 0
          asset.held = false
        }
      }
    }

    for (const h of holdings) {
      if (!h.held || h.value <= 0) continue
      if (h.yieldPercent) income += (h.value * h.yieldPercent) / 100
      if (h.fixedMonthly) income += h.fixedMonthly * 12 * incomeInflate
      if (h.sellPercent && h.drawable) {
        const sold = Math.min(h.value, (h.value * h.sellPercent) / 100)
        h.value -= sold
        income += sold
      }
    }

    const netFlow = income + oneOffs - outgoing
    let unfunded = 0
    const pool = holdings.filter((h) => h.held && h.drawable)
    const poolValue = drawableTotal()
    if (netFlow < 0) {
      const need = -netFlow
      const taken = Math.min(need, poolValue)
      for (const h of pool) h.value -= poolValue > 0 ? (h.value / poolValue) * taken : 0
      unfunded = need - taken
      if (unfunded > 0 && runwayYears === null) {
        runwayYears = year + (need > 0 ? taken / need : 0)
      }
    } else if (netFlow > 0) {
      const target = poolValue > 0 ? pool : holdings.filter((h) => h.id === CASH_ID)
      const base = target.reduce((sum, h) => sum + h.value, 0)
      for (const h of target) h.value += base > 0 ? (h.value / base) * netFlow : netFlow
    }

    for (const h of holdings) {
      if (!h.held) continue
      h.value *= 1 + (h.drawable ? growth : propertyGrowth)
    }

    rows.push({
      year,
      drawable: drawableTotal(),
      netWorth: ownedTotal() + liabilities,
      income: income + Math.max(0, oneOffs),
      outgoing: outgoing + Math.max(0, -oneOffs),
      netFlow,
      unfunded,
    })
  }

  return { rows, runwayYears, drawableNow, netWorthNow }
}

/** The assets you would normally spend from: not property or vehicles, not liabilities. */
export function defaultDrawable(type: string, value: number): boolean {
  return value > 0 && type !== 'real_estate' && type !== 'vehicle'
}
