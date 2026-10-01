/**
 * A year-by-year projection of the assets you could sell from.
 *
 * Each year: outgoings (inflated) are paid from income (recurring credits,
 * asset yields, fixed rentals, planned sales and what-if items). From the
 * drawdown start year a shortfall is covered by selling the drawable assets,
 * either in proportion to their value or in an order you choose; a surplus is
 * added to them; then the assets grow. Before the start year surpluses are
 * saved and shortfalls are assumed to be paid from earnings that are not
 * modelled. Runway is how long the assets last.
 *
 * It is a planning aid, not a forecast: no taxes and no loan amortisation.
 * Each asset grows at its own rate.
 */

export interface ProjectionAsset {
  id: string
  name: string
  /** Value in the display currency; negative = a liability. */
  value: number
  /** Money you would sell from. */
  drawable: boolean
  /** % of the value paid out a year. */
  yieldPercent?: number
  /** Fixed income per month, in the display currency (a rental). */
  fixedMonthly?: number
  /** The fixed income does not rise with inflation. */
  fixedFlat?: boolean
  /** % of the holding sold each year. */
  sellPercent?: number
  /** The asset's own growth, % a year (0 when it has none). */
  growthPercent?: number
  /** When selling in order: lower sells first; unset sells last. */
  sellOrder?: number
  /** A what-if asset that exists only in the plan (display only; the engine treats it like any other). */
  temporary?: boolean
  /** The asset only exists from the start of this year (0 = now); its value arrives then. */
  startYear?: number
}

export interface Assumptions {
  horizonYears: number
  inflationPercent: number
  /** Whether income rises with inflation like outgoings do. */
  incomeIndexed: boolean
  /** First year (0 = this year) a shortfall is covered by selling assets. */
  drawdownStartYear?: number
  /** Last year of the planned drawdown; the projection reports what is left then. */
  drawdownEndYear?: number
  /** How a shortfall is spread over the assets you would sell from. */
  sellStrategy?: 'pro_rata' | 'ordered'
}

export type WhatIf =
  /** `inflates: false` keeps the amount the same instead of rising with inflation (default: it rises). */
  | { id: string; kind: 'income' | 'expense'; label: string; monthly: number; fromYear: number; toYear?: number; inflates?: boolean }
  | { id: string; kind: 'oneoff'; label: string; amount: number; year: number }
  | { id: string; kind: 'sell'; label: string; assetId: string; year: number; feesPercent: number }
  /** From this year on, spend this much a month (today's money) instead of the recurring outgoings. */
  | { id: string; kind: 'spend'; label: string; monthly: number; fromYear: number; inflates?: boolean }

export interface ProjectionInput {
  /** Counted recurring income per month, today's money. */
  recurringIncomeMonthly: number
  /** Counted outgoings per month, today's money; these rise with inflation. */
  outgoingMonthly: number
  /** Outgoings per month that stay the same in nominal terms (a fixed mortgage payment). */
  outgoingFlatMonthly?: number
  /** Counted recurring income that stays the same in nominal terms (a fixed rent). */
  recurringIncomeFlatMonthly?: number
  assets: ProjectionAsset[]
  assumptions: Assumptions
  whatIfs: WhatIf[]
  /** One random path of markets for the simulator; without it the plan's fixed rates apply. */
  market?: MarketPath
}

/** One simulated future: what inflation and each asset's growth turned out to be, year by year. */
export interface MarketPath {
  /** Inflation in each year, in percent. */
  inflationPercent: number[]
  /** An asset's growth in a year, in percent; undefined falls back to the asset's own rate. */
  growthPercent: (asset: ProjectionAsset, year: number) => number | undefined
}

export type Phase = 'saving' | 'drawdown' | 'after'

export interface YearRow {
  /** 0 = this year. */
  year: number
  phase: Phase
  /** Value of each asset at the end of the year (money that collects is listed as CASH_ID). */
  byAsset: Record<string, number>
  /** What was sold from each asset this year to cover a shortfall. */
  drawn: Record<string, number>
  /** Income from yields and rentals this year. */
  assetIncome: number
  /** Income from planned sales this year. */
  saleIncome: number
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
  /** Years from now until the drawable assets run out, or null if they last the horizon. */
  runwayYears: number | null
  /** Drawable assets at the end of the drawdown end year, if one was set. */
  leftAtEnd: number | null
  drawableNow: number
  netWorthNow: number
}

export const CASH_ID = '__cash__'

function active(item: { fromYear: number; toYear?: number }, year: number): boolean {
  return year >= item.fromYear && (item.toYear === undefined || year <= item.toYear)
}

export function projectRetirement(input: ProjectionInput): Projection {
  const { assumptions: a } = input
  const inflation = a.inflationPercent / 100
  // Prices at the start of each year against today's: fixed rate, or the simulated path compounded.
  const priceLevel: number[] = []
  let level = 1
  for (let y = 0; y < a.horizonYears; y++) {
    priceLevel.push(level)
    level *= 1 + (input.market ? (input.market.inflationPercent[y] ?? a.inflationPercent) / 100 : inflation)
  }
  const startYear = a.drawdownStartYear ?? 0
  const ordered = a.sellStrategy === 'ordered'

  // Mutable working copy; surplus with nowhere to go collects in a cash bucket,
  // which is sold first when selling in order.
  const state = input.assets.map((asset) => ({ ...asset, held: (asset.startYear ?? 0) <= 0 }))
  state.push({ id: CASH_ID, name: 'cash', value: 0, drawable: true, held: true, sellOrder: -1 })
  const liabilities = state.filter((s) => s.value < 0).reduce((sum, s) => sum + s.value, 0)
  const holdings = state.filter((s) => s.value >= 0)

  const drawableTotal = () => holdings.filter((h) => h.held && h.drawable).reduce((sum, h) => sum + h.value, 0)
  const ownedTotal = () => holdings.filter((h) => h.held).reduce((sum, h) => sum + h.value, 0)

  const drawableNow = drawableTotal()
  const netWorthNow = ownedTotal() + liabilities
  const rows: YearRow[] = []
  let runwayYears: number | null = null

  for (let year = 0; year < a.horizonYears; year++) {
    const inflate = priceLevel[year]
    const incomeInflate = a.incomeIndexed ? inflate : 1

    // Assets that only exist from a later year arrive at the start of that year.
    for (const h of holdings) if (!h.held && h.startYear === year) h.held = true

    let income = input.recurringIncomeMonthly * 12 * incomeInflate + (input.recurringIncomeFlatMonthly ?? 0) * 12
    let outgoingMonthly = input.outgoingMonthly
    let outgoingFlatMonthly = input.outgoingFlatMonthly ?? 0
    for (const w of input.whatIfs) {
      if (w.kind === 'spend' && year >= w.fromYear) {
        // Replaces both kinds of recurring outgoing; flat when it should not inflate.
        outgoingMonthly = w.inflates === false ? 0 : w.monthly
        outgoingFlatMonthly = w.inflates === false ? w.monthly : 0
      }
    }
    let outgoing = outgoingMonthly * 12 * inflate + outgoingFlatMonthly * 12
    let oneOffs = 0
    let assetIncome = 0
    let saleIncome = 0

    for (const w of input.whatIfs) {
      if (w.kind === 'income' && active(w, year)) income += w.monthly * 12 * (w.inflates === false ? 1 : incomeInflate)
      if (w.kind === 'expense' && active(w, year)) outgoing += w.monthly * 12 * (w.inflates === false ? 1 : inflate)
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
      if (h.yieldPercent) assetIncome += (h.value * h.yieldPercent) / 100
      if (h.fixedMonthly) assetIncome += h.fixedMonthly * 12 * (h.fixedFlat ? 1 : incomeInflate)
      if (h.sellPercent && h.drawable) {
        const sold = Math.min(h.value, (h.value * h.sellPercent) / 100)
        h.value -= sold
        saleIncome += sold
      }
    }
    income += assetIncome + saleIncome

    const netFlow = income + oneOffs - outgoing
    const phase: Phase =
      year < startYear ? 'saving' : a.drawdownEndYear !== undefined && year > a.drawdownEndYear ? 'after' : 'drawdown'
    let unfunded = 0
    const drawn: Record<string, number> = {}
    const pool = holdings.filter((h) => h.held && h.drawable)
    const poolValue = drawableTotal()

    if (netFlow < 0 && year >= startYear) {
      const need = -netFlow
      const taken = Math.min(need, poolValue)
      if (ordered) {
        let remaining = taken
        const queue = [...pool].sort(
          (x, y) => (x.sellOrder ?? Number.MAX_SAFE_INTEGER) - (y.sellOrder ?? Number.MAX_SAFE_INTEGER),
        )
        for (const h of queue) {
          if (remaining <= 0) break
          const take = Math.min(h.value, remaining)
          h.value -= take
          drawn[h.id] = take
          remaining -= take
        }
      } else {
        for (const h of pool) {
          const take = poolValue > 0 ? (h.value / poolValue) * taken : 0
          h.value -= take
          drawn[h.id] = take
        }
      }
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
      const rate = input.market?.growthPercent(h, year) ?? h.growthPercent ?? 0
      h.value *= 1 + rate / 100
    }

    const byAsset: Record<string, number> = {}
    for (const h of holdings) if (h.held && h.value > 0.005) byAsset[h.id] = h.value

    rows.push({
      year,
      phase,
      byAsset,
      drawn,
      assetIncome,
      saleIncome,
      drawable: drawableTotal(),
      netWorth: ownedTotal() + liabilities,
      income: income + Math.max(0, oneOffs),
      outgoing: outgoing + Math.max(0, -oneOffs),
      netFlow,
      unfunded,
    })
  }

  const endRow = a.drawdownEndYear !== undefined ? rows[a.drawdownEndYear] : undefined
  return { rows, runwayYears, leftAtEnd: endRow ? endRow.drawable : null, drawableNow, netWorthNow }
}

/** The assets you would normally sell from: not property or vehicles, not liabilities. */
export function defaultDrawable(type: string, value: number): boolean {
  return value > 0 && type !== 'real_estate' && type !== 'vehicle'
}
