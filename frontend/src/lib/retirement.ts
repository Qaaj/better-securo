import type { Asset, RecurringTransaction } from '@/types'
import { PER_YEAR, inDisplayCurrency } from './recurring-totals'

export type IncomeKind = 'recurring' | 'asset-income' | 'asset-sale'

export interface IncomeLine {
  /** Stable key, also what the user's deselections are stored under. */
  id: string
  kind: IncomeKind
  label: string
  /** What the line amounts to in a month, in the display currency. */
  monthly: number
  frequency?: string
  asset?: Asset
}

export interface OutgoingLine {
  item: RecurringTransaction
  monthly: number
}

export interface RetirementSummary {
  /** Every income line, whether or not it is counted. */
  income: IncomeLine[]
  /** Every active recurring debit, whether or not it is counted. */
  outgoing: OutgoingLine[]
  incomeMonthly: number
  outgoingMonthly: number
  /** Share of the outgoings the counted income covers (1 = fully covered). */
  coverage: number | null
  /** Counted income minus outgoings, per month. Negative = shortfall. */
  surplusMonthly: number
  /** Active items left out because they had no amount in the display currency. */
  skipped: number
}

/** An item's amount normalised to a month, or null if it cannot be known. */
export function monthlyEquivalent(rt: RecurringTransaction, displayCurrency: string): number | null {
  const amount = inDisplayCurrency(rt, displayCurrency)
  const perYear = PER_YEAR[rt.frequency]
  if (amount == null || perYear == null) return null
  return (amount * perYear) / 12
}

/** The asset's value in the display currency, or null if unknown. */
export function assetValue(asset: Asset, displayCurrency: string): number | null {
  if (asset.current_value_primary != null) return asset.current_value_primary
  if (asset.current_value != null && asset.currency === displayCurrency) return asset.current_value
  return null
}

/** Display-currency per asset-currency unit, from the asset's own value pair. */
function conversionRate(asset: Asset, displayCurrency: string): number | null {
  if (asset.currency === displayCurrency) return 1
  if (asset.current_value && asset.current_value_primary != null) {
    return asset.current_value_primary / asset.current_value
  }
  return null
}

/** What the asset cost, in the display currency, or null when it is not known. */
export function assetCostBasis(asset: Asset, displayCurrency: string): number | null {
  if (asset.purchase_price == null) return null
  const rate = conversionRate(asset, displayCurrency)
  return rate == null ? null : asset.purchase_price * rate
}

/** The asset's own growth rule as a rate per year, or null when it has none. */
export function annualGrowthPercent(asset: Asset, value: number | null): number | null {
  if (!asset.growth_type || asset.growth_rate == null || !asset.growth_frequency) return null
  const perYear = ({ daily: 365, weekly: 52, monthly: 12, yearly: 1 } as Record<string, number>)[asset.growth_frequency]
  if (perYear == null) return null
  if (asset.growth_type === 'percentage') return ((1 + asset.growth_rate / 100) ** perYear - 1) * 100
  // A fixed amount per period, against what the asset is worth now.
  return value ? ((asset.growth_rate * perYear) / value) * 100 : null
}

/** A fixed asset income (a rental) as a monthly amount in the display currency. */
export function assetFixedMonthly(asset: Asset, displayCurrency: string): number | null {
  if (asset.income_mode !== 'fixed' || asset.income_amount == null || !asset.income_frequency) return null
  const rate = conversionRate(asset, displayCurrency)
  const perYear = PER_YEAR[asset.income_frequency]
  if (rate == null || perYear == null) return null
  return (asset.income_amount * rate * perYear) / 12
}

function assetIncomeLines(asset: Asset, displayCurrency: string): { lines: IncomeLine[]; skipped: number } {
  const lines: IncomeLine[] = []
  let skipped = 0
  const value = assetValue(asset, displayCurrency)

  if (asset.income_mode === 'yield' && asset.income_rate != null) {
    if (value == null) skipped += 1
    else lines.push({ id: `asset:${asset.id}:income`, kind: 'asset-income', label: asset.name, monthly: (value * asset.income_rate) / 100 / 12, asset })
  } else if (asset.income_mode === 'fixed' && asset.income_amount != null && asset.income_frequency) {
    const rate = conversionRate(asset, displayCurrency)
    const perYear = PER_YEAR[asset.income_frequency]
    if (rate == null || perYear == null) skipped += 1
    else lines.push({ id: `asset:${asset.id}:income`, kind: 'asset-income', label: asset.name, monthly: (asset.income_amount * rate * perYear) / 12, frequency: asset.income_frequency, asset })
  }

  if (asset.sell_percent_per_year) {
    if (value == null) skipped += 1
    else lines.push({ id: `asset:${asset.id}:sale`, kind: 'asset-sale', label: asset.name, monthly: (value * asset.sell_percent_per_year) / 100 / 12, asset })
  }
  return { lines, skipped }
}

/**
 * Passive income against outgoings. Income is every active recurring credit,
 * plus the modelled income and planned sales of every live asset, grouped or
 * not. Outgoings are every active recurring debit. Any line can be left out of
 * the totals by id (income line ids, or the recurring item's id).
 */
export function computeRetirement(
  items: RecurringTransaction[],
  assets: Asset[],
  displayCurrency: string,
  excludedIds: ReadonlySet<string>,
): RetirementSummary {
  const income: IncomeLine[] = []
  const outgoing: OutgoingLine[] = []
  let skipped = 0

  for (const item of items) {
    if (!item.is_active) continue
    const monthly = monthlyEquivalent(item, displayCurrency)
    if (monthly == null) {
      skipped += 1
      continue
    }
    if (item.type === 'credit') {
      income.push({ id: item.id, kind: 'recurring', label: item.description, monthly, frequency: item.frequency })
    } else {
      outgoing.push({ item, monthly })
    }
  }

  for (const asset of assets) {
    if (asset.is_archived || asset.sell_date) continue
    const result = assetIncomeLines(asset, displayCurrency)
    income.push(...result.lines)
    skipped += result.skipped
  }

  income.sort((a, b) => b.monthly - a.monthly)
  outgoing.sort((a, b) => b.monthly - a.monthly)

  const incomeMonthly = income.filter((l) => !excludedIds.has(l.id)).reduce((sum, l) => sum + l.monthly, 0)
  const outgoingMonthly = outgoing
    .filter((l) => !excludedIds.has(l.item.id))
    .reduce((sum, l) => sum + l.monthly, 0)
  return {
    income,
    outgoing,
    incomeMonthly,
    outgoingMonthly,
    coverage: outgoingMonthly > 0 ? incomeMonthly / outgoingMonthly : null,
    surplusMonthly: incomeMonthly - outgoingMonthly,
    skipped,
  }
}
