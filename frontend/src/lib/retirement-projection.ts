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
 * Optional taxes: a rate on income, a rate on what assets pay out, and a rate
 * on the gain in anything sold (each asset keeps a cost basis). A cash buffer
 * can hold some years of costs, spent first and refilled only after a year in
 * which the other assets did not fall.
 *
 * It is a planning aid, not a forecast: no loan amortisation. Each asset
 * grows at its own rate.
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
  /** The fixed income stops after this year (0 = this year). */
  fixedUntilYear?: number
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
  /** What it cost, in the display currency. Unset means no gain yet (only growth from now is taxed). */
  costBasis?: number
  /** Gains on selling it are not taxed. */
  taxFree?: boolean
  /** Own tax rates, percent; unset uses the plan's default for that kind. */
  yieldTaxPercent?: number
  rentTaxPercent?: number
  gainsTaxPercent?: number
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
  /** Tax on recurring income and income what-ifs, percent. */
  taxIncomePercent?: number
  /** Tax on yields (dividends, interest), percent. */
  taxAssetIncomePercent?: number
  /** Tax on fixed rent from assets, percent. */
  taxRentPercent?: number
  /** Tax on the gain when an asset is sold, percent. */
  taxGainsPercent?: number
  /** Years of costs held in cash from the first drawdown year; spent first, refilled after a year without a fall. */
  bufferYears?: number
}

export type WhatIf =
  /** `inflates: false` keeps the amount the same instead of rising with inflation (default: it rises). */
  | { id: string; kind: 'income' | 'expense'; label: string; monthly: number; fromYear: number; toYear?: number; inflates?: boolean; /** Own tax rate on an income, percent; unset uses the plan's income rate. */ taxPercent?: number }
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
  /** Lines that stop (or start) part-way through, kept out of the totals above. Same shape as income and cost what-ifs. */
  timed?: Extract<WhatIf, { kind: 'income' | 'expense' }>[]
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
  /** Income tax, tax on asset income and on gains from sales this year. */
  tax: number
  /** The same tax split by where it came from. */
  taxKinds: { income: number; yield: number; rent: number; gains: number }
  /** What prices at the end of this year are against today's (1 = no inflation). */
  deflator: number
}

export interface Projection {
  rows: YearRow[]
  /** Years from now until the drawable assets run out, or null if they last the horizon. */
  runwayYears: number | null
  /** Drawable assets at the end of the drawdown end year, if one was set. */
  leftAtEnd: number | null
  drawableNow: number
  netWorthNow: number
  /** All tax over the horizon. */
  totalTax: number
}

export const CASH_ID = '__cash__'

function active(item: { fromYear: number; toYear?: number }, year: number): boolean {
  return year >= item.fromYear && (item.toYear === undefined || year <= item.toYear)
}

interface Holding extends ProjectionAsset {
  held: boolean
  basis: number
}

export function projectRetirement(input: ProjectionInput): Projection {
  const { assumptions: a } = input
  const inflation = a.inflationPercent / 100
  const startYear = a.drawdownStartYear ?? 0
  const ordered = a.sellStrategy === 'ordered'
  const incomeTaxDefault = (a.taxIncomePercent ?? 0) / 100
  const bufferYears = a.bufferYears ?? 0
  // Prices at the start of each year against today's: fixed rate, or the simulated path compounded.
  const priceLevel: number[] = [1]
  for (let y = 0; y < a.horizonYears; y++) {
    priceLevel.push(priceLevel[y] * (1 + (input.market ? (input.market.inflationPercent[y] ?? a.inflationPercent) / 100 : inflation)))
  }

  // Mutable working copy; surplus with nowhere to go collects in a cash bucket,
  // which is sold first when selling in order or when a buffer is kept.
  const state: Holding[] = input.assets.map((asset) => ({
    ...asset,
    held: (asset.startYear ?? 0) <= 0,
    basis: asset.costBasis ?? Math.max(0, asset.value),
  }))
  state.push({ id: CASH_ID, name: 'cash', value: 0, drawable: true, held: true, sellOrder: -1, basis: 0 })
  const liabilities = state.filter((s) => s.value < 0).reduce((sum, s) => sum + s.value, 0)
  const holdings = state.filter((s) => s.value >= 0)
  const cash = holdings.find((h) => h.id === CASH_ID)!

  const drawableTotal = () => holdings.filter((h) => h.held && h.drawable).reduce((sum, h) => sum + h.value, 0)
  const ownedTotal = () => holdings.filter((h) => h.held).reduce((sum, h) => sum + h.value, 0)

  /** Share of a sale that is gain, for the tax. */
  const gainsRate = (h: Holding) => (h.taxFree ? 0 : (h.gainsTaxPercent ?? a.taxGainsPercent ?? 0) / 100)
  const gainShare = (h: Holding) => (h.taxFree || h.value <= 0 ? 0 : Math.max(0, 1 - h.basis / h.value))
  const keepAfterTax = (h: Holding) => 1 - gainShare(h) * gainsRate(h)

  /** Take `gross` out of an asset, shrinking its cost basis in proportion; returns the tax on the gain. */
  function take(h: Holding, gross: number): number {
    const tax = gross * gainShare(h) * gainsRate(h)
    h.basis -= h.value > 0 ? (h.basis * gross) / h.value : 0
    h.value -= gross
    return tax
  }

  /**
   * Sell from `pool` until `net` has arrived after tax on the gains (or the
   * pool is empty). Returns what arrived, the tax withheld and what was sold.
   */
  function sell(pool: Holding[], net: number): { net: number; tax: number; sold: Record<string, number> } {
    const sold: Record<string, number> = {}
    let arrived = 0
    let tax = 0
    const live = pool.filter((h) => h.value > 0)
    if (net <= 0 || live.length === 0) return { net: 0, tax: 0, sold }
    if (ordered) {
      const queue = [...live].sort((x, y) => (x.sellOrder ?? Number.MAX_SAFE_INTEGER) - (y.sellOrder ?? Number.MAX_SAFE_INTEGER))
      for (const h of queue) {
        const remaining = net - arrived
        if (remaining <= 1e-9) break
        const factor = keepAfterTax(h)
        const gross = Math.min(h.value, remaining / factor)
        const paid = take(h, gross)
        sold[h.id] = (sold[h.id] ?? 0) + gross
        tax += paid
        arrived += gross - paid
      }
    } else {
      const total = live.reduce((sum, h) => sum + h.value, 0)
      const weightedKeep = live.reduce((sum, h) => sum + (h.value / total) * keepAfterTax(h), 0)
      const gross = Math.min(total, net / weightedKeep)
      for (const h of live) {
        const part = (h.value / total) * gross
        const paid = take(h, part)
        sold[h.id] = (sold[h.id] ?? 0) + part
        tax += paid
        arrived += part - paid
      }
    }
    return { net: arrived, tax, sold }
  }

  const drawableNow = drawableTotal()
  const netWorthNow = ownedTotal() + liabilities
  const rows: YearRow[] = []
  let runwayYears: number | null = null
  let totalTax = 0
  const lines = [...(input.timed ?? []), ...input.whatIfs]

  for (let year = 0; year < a.horizonYears; year++) {
    const inflate = priceLevel[year]
    const incomeInflate = a.incomeIndexed ? inflate : 1

    // Assets that only exist from a later year arrive at the start of that year.
    for (const h of holdings) if (!h.held && h.startYear === year) h.held = true

    let income = input.recurringIncomeMonthly * 12 * incomeInflate + (input.recurringIncomeFlatMonthly ?? 0) * 12
    // Tax on income: the plain recurring income at the default rate, lines with their own rate as they come.
    let incomeTaxDue = income * incomeTaxDefault
    let outgoingMonthly = input.outgoingMonthly
    let outgoingFlatMonthly = input.outgoingFlatMonthly ?? 0
    let spending = false
    for (const w of input.whatIfs) {
      if (w.kind === 'spend' && year >= w.fromYear) {
        // Replaces both kinds of recurring outgoing; flat when it should not inflate.
        outgoingMonthly = w.inflates === false ? 0 : w.monthly
        outgoingFlatMonthly = w.inflates === false ? w.monthly : 0
        spending = true
      }
    }
    let outgoing = outgoingMonthly * 12 * inflate + outgoingFlatMonthly * 12
    let oneOffs = 0
    let assetIncome = 0
    let saleIncome = 0
    // Tax that has to be paid out of the year's cash flow.
    let gainsDue = 0
    // Tax already withheld from sales that were made to raise cash.
    let withheldTax = 0

    for (const w of lines) {
      if (w.kind === 'income' && active(w, year)) {
        const amount = w.monthly * 12 * (w.inflates === false ? 1 : incomeInflate)
        income += amount
        incomeTaxDue += amount * (w.taxPercent !== undefined ? w.taxPercent / 100 : incomeTaxDefault)
      }
      if (w.kind === 'expense' && active(w, year)) {
        // A spending what-if replaces the recurring costs, including lines that end part-way.
        if (spending && input.timed?.includes(w)) continue
        outgoing += w.monthly * 12 * (w.inflates === false ? 1 : inflate)
      }
    }
    for (const w of input.whatIfs) {
      if (w.kind === 'oneoff' && w.year === year) oneOffs += w.amount
      if (w.kind === 'sell' && w.year === year) {
        const asset = holdings.find((h) => h.id === w.assetId && h.held)
        if (asset) {
          const proceeds = asset.value * (1 - w.feesPercent / 100)
          oneOffs += proceeds
          gainsDue += Math.max(0, proceeds - asset.basis) * gainsRate(asset)
          asset.value = 0
          asset.basis = 0
          asset.held = false
        }
      }
    }

    let yieldIncome = 0
    let rentIncome = 0
    let yieldTaxDue = 0
    let rentTaxDue = 0
    for (const h of holdings) {
      if (!h.held || h.value <= 0) continue
      if (h.yieldPercent) {
        const paid = (h.value * h.yieldPercent) / 100
        yieldIncome += paid
        yieldTaxDue += paid * (h.yieldTaxPercent ?? a.taxAssetIncomePercent ?? 0) / 100
      }
      if (h.fixedMonthly && (h.fixedUntilYear === undefined || year <= h.fixedUntilYear)) {
        const rent = h.fixedMonthly * 12 * (h.fixedFlat ? 1 : incomeInflate)
        rentIncome += rent
        rentTaxDue += rent * (h.rentTaxPercent ?? a.taxRentPercent ?? 0) / 100
      }
      if (h.sellPercent && h.drawable) {
        const sold = Math.min(h.value, (h.value * h.sellPercent) / 100)
        gainsDue += sold * gainShare(h) * gainsRate(h)
        take(h, sold)
        saleIncome += sold
      }
    }
    assetIncome = yieldIncome + rentIncome
    income += assetIncome + saleIncome
    const payableTax = incomeTaxDue + yieldTaxDue + rentTaxDue + gainsDue

    const netFlow = income + oneOffs - outgoing - payableTax
    const phase: Phase =
      year < startYear ? 'saving' : a.drawdownEndYear !== undefined && year > a.drawdownEndYear ? 'after' : 'drawdown'
    let unfunded = 0
    const drawn: Record<string, number> = {}
    const addDrawn = (sold: Record<string, number>) => {
      for (const [id, amount] of Object.entries(sold)) drawn[id] = (drawn[id] ?? 0) + amount
    }
    const heldDrawable = () => holdings.filter((h) => h.held && h.drawable)
    const others = () => heldDrawable().filter((h) => h.id !== CASH_ID)
    const bufferTarget = bufferYears > 0 && year >= startYear ? bufferYears * outgoing : 0

    // The buffer is set up from the other assets in the first year of drawing.
    if (bufferTarget > 0 && year === startYear) {
      const result = sell(others(), bufferTarget - cash.value)
      cash.value += result.net
      withheldTax += result.tax
      addDrawn(result.sold)
    }

    if (netFlow < 0 && year >= startYear) {
      const need = -netFlow
      let remaining = need
      if (bufferYears > 0) {
        const fromCash = Math.min(cash.value, remaining)
        cash.value -= fromCash
        remaining -= fromCash
        if (fromCash > 0) drawn[CASH_ID] = (drawn[CASH_ID] ?? 0) + fromCash
      }
      if (remaining > 1e-9) {
        const result = sell(bufferYears > 0 ? others() : heldDrawable(), remaining)
        withheldTax += result.tax
        addDrawn(result.sold)
        remaining -= result.net
      }
      unfunded = Math.max(0, remaining)
      if (unfunded > 1e-6 && runwayYears === null) {
        runwayYears = year + (need > 0 ? (need - unfunded) / need : 0)
      }
    } else if (netFlow > 0) {
      const pool = heldDrawable()
      let surplus = netFlow
      if (bufferTarget > 0 && cash.value < bufferTarget) {
        const fill = Math.min(surplus, bufferTarget - cash.value)
        cash.value += fill
        cash.basis += fill
        surplus -= fill
      }
      if (surplus > 0) {
        const target = pool.some((h) => h.value > 0) ? pool.filter((h) => h.value > 0) : [cash]
        const base = target.reduce((sum, h) => sum + h.value, 0)
        for (const h of target) {
          const add = base > 0 ? (h.value / base) * surplus : surplus
          h.value += add
          h.basis += add
        }
      }
    }

    // Growth, noting how the assets other than cash fared as a whole.
    let before = 0
    let after = 0
    for (const h of holdings) {
      if (!h.held) continue
      const rate = input.market?.growthPercent(h, year) ?? h.growthPercent ?? 0
      if (h.drawable && h.id !== CASH_ID) before += h.value
      h.value *= 1 + rate / 100
      if (h.drawable && h.id !== CASH_ID) after += h.value
    }

    // After a year in which they did not fall, top the buffer up again.
    if (bufferYears > 0 && year >= startYear && after >= before) {
      const nextTarget = bufferYears * outgoing * (priceLevel[year + 1] / priceLevel[year])
      if (cash.value < nextTarget) {
        const result = sell(others(), nextTarget - cash.value)
        cash.value += result.net
        withheldTax += result.tax
        addDrawn(result.sold)
      }
    }

    const byAsset: Record<string, number> = {}
    for (const h of holdings) if (h.held && h.value > 0.005) byAsset[h.id] = h.value

    const yearTax = payableTax + withheldTax
    const taxKinds = { income: incomeTaxDue, yield: yieldTaxDue, rent: rentTaxDue, gains: gainsDue + withheldTax }
    totalTax += yearTax
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
      tax: yearTax,
      taxKinds,
      deflator: priceLevel[year + 1],
    })
  }

  const endRow = a.drawdownEndYear !== undefined ? rows[a.drawdownEndYear] : undefined
  return { rows, runwayYears, leftAtEnd: endRow ? endRow.drawable : null, drawableNow, netWorthNow, totalTax }
}

/** The assets you would normally sell from: not property or vehicles, not liabilities. */
export function defaultDrawable(type: string, value: number): boolean {
  return value > 0 && type !== 'real_estate' && type !== 'vehicle'
}
