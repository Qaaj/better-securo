import { SCENARIOS_KEY, scheduleSync } from '@/lib/retirement-sync'
import { annualGrowthPercent, assetCostBasis, assetFixedMonthly, assetValue, computeRetirement } from '@/lib/retirement'
import { defaultDrawable, type Assumptions, type ProjectionAsset, type ProjectionInput, type WhatIf } from '@/lib/retirement-projection'
import type { Asset, RecurringTransaction } from '@/types'

/** An asset that exists only in the plan, e.g. "more bonds". */
export interface TempAsset {
  id: string
  name: string
  value: number
  growthPercent: number
  yieldPercent: number
  /** The asset exists from this year (0 = now). Older saved plans have none. */
  fromYear?: number
}

export interface Plan {
  /** Lines whose amount stays the same instead of rising with inflation (recurring item ids, `asset:<id>:income`). */
  flat: string[]
  assumptions: Assumptions
  drawable: Record<string, boolean>
  /** Growth a year the user typed for an asset, over the one its own rule gives. */
  growth: Record<string, number>
  /** The order to sell in, when the strategy is "in my order": lower first. */
  sellOrder: Record<string, number>
  /** Hypothetical assets to sell from, kept with the plan. */
  tempAssets: TempAsset[]
  whatIfs: WhatIf[]
  /** The last calendar year a recurring line (or `asset:<id>:income`) counts; unset means it never stops. */
  lineEnd?: Record<string, number>
  /** Assets whose gains are not taxed when sold. */
  taxFree?: Record<string, boolean>
}

export const DEFAULT_PLAN: Plan = {
  flat: [],
  assumptions: { horizonYears: 30, inflationPercent: 2, incomeIndexed: true, drawdownStartYear: 0, sellStrategy: 'pro_rata' },
  drawable: {},
  growth: {},
  sellOrder: {},
  tempAssets: [],
  whatIfs: [],
  lineEnd: {},
  taxFree: {},
}
export const PLAN_KEY = 'retirement:plan'
export const SIM_KEY = 'retirement:simulation'
export { SCENARIOS_KEY }

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback
  } catch {
    return fallback
  }
}

export function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Blocked storage: the plan just does not persist.
  }
  scheduleSync()
}

/** What the retirement page counts, turned into the projection's input, for the saved plan. */
export function buildProjectionInputs(
  plan: Plan,
  items: RecurringTransaction[],
  assets: Asset[],
  currency: string,
  excluded: ReadonlySet<string>,
  thisYear: number = new Date().getFullYear(),
) {
  // What the page already counts feeds the projection, so its switches apply here too.
  const summary = computeRetirement(items, assets, currency, excluded)
  const flatSet = new Set(plan.flat ?? [])
  const sum = (lines: { monthly: number }[]) => lines.reduce((total, l) => total + l.monthly, 0)
  const lineEnd = plan.lineEnd ?? {}
  const ends = (id: string) => lineEnd[id] !== undefined
  const recurringIncome = summary.income.filter((l) => l.kind === 'recurring' && !excluded.has(l.id))
  const countedOutgoing = summary.outgoing.filter((l) => !excluded.has(l.item.id))
  const open = <T,>(list: T[], idOf: (item: T) => string) => list.filter((l) => !ends(idOf(l)))
  const recurringIncomeMonthly = sum(open(recurringIncome, (l) => l.id).filter((l) => !flatSet.has(l.id)))
  const recurringIncomeFlatMonthly = sum(open(recurringIncome, (l) => l.id).filter((l) => flatSet.has(l.id)))
  const outgoingMonthly = sum(open(countedOutgoing, (l) => l.item.id).filter((l) => !flatSet.has(l.item.id)))
  const outgoingFlatMonthly = sum(open(countedOutgoing, (l) => l.item.id).filter((l) => flatSet.has(l.item.id)))
  // Lines with an end year are kept out of the totals and handled on their own.
  const timed: NonNullable<ProjectionInput['timed']> = [
    ...recurringIncome.filter((l) => ends(l.id)).map((l) => ({
      id: l.id, kind: 'income' as const, label: l.label, monthly: l.monthly, fromYear: 0, toYear: lineEnd[l.id] - thisYear, inflates: !flatSet.has(l.id),
    })),
    ...countedOutgoing.filter((l) => ends(l.item.id)).map((l) => ({
      id: l.item.id, kind: 'expense' as const, label: l.item.description, monthly: l.monthly, fromYear: 0, toYear: lineEnd[l.item.id] - thisYear, inflates: !flatSet.has(l.item.id),
    })),
  ]

  const projectionAssets: ProjectionAsset[] = (() => {
    const list: ProjectionAsset[] = []
    for (const asset of assets) {
      if (asset.is_archived || asset.sell_date) continue
      const value = assetValue(asset, currency)
      if (value == null) continue
      const yielding = asset.income_mode === 'yield' && asset.income_rate != null && !excluded.has(`asset:${asset.id}:income`)
      const rental = !excluded.has(`asset:${asset.id}:income`) ? assetFixedMonthly(asset, currency) : null
      list.push({
        id: asset.id,
        name: asset.name,
        value,
        drawable: plan.drawable[asset.id] ?? defaultDrawable(asset.type, value),
        growthPercent: plan.growth[asset.id] ?? annualGrowthPercent(asset, value) ?? 0,
        sellOrder: plan.sellOrder[asset.id],
        yieldPercent: yielding ? asset.income_rate ?? undefined : undefined,
        fixedMonthly: rental ?? undefined,
        fixedFlat: flatSet.has(`asset:${asset.id}:income`) || undefined,
        fixedUntilYear: ends(`asset:${asset.id}:income`) ? lineEnd[`asset:${asset.id}:income`] - thisYear : undefined,
        costBasis: assetCostBasis(asset, currency) ?? undefined,
        taxFree: plan.taxFree?.[asset.id] || undefined,
        sellPercent: asset.sell_percent_per_year && !excluded.has(`asset:${asset.id}:sale`) ? asset.sell_percent_per_year : undefined,
      })
    }
    for (const temp of plan.tempAssets ?? []) {
      list.push({
        id: temp.id,
        name: temp.name,
        value: temp.value,
        drawable: plan.drawable[temp.id] ?? true,
        growthPercent: plan.growth[temp.id] ?? temp.growthPercent,
        yieldPercent: temp.yieldPercent || undefined,
        sellOrder: plan.sellOrder[temp.id],
        temporary: true,
        startYear: temp.fromYear || undefined,
        taxFree: plan.taxFree?.[temp.id] || undefined,
      })
    }
    return list
  })()

  const base: Omit<ProjectionInput, 'whatIfs'> = { recurringIncomeMonthly, recurringIncomeFlatMonthly, outgoingMonthly, outgoingFlatMonthly, assets: projectionAssets, assumptions: plan.assumptions, timed }

  return { summary, flatSet, projectionAssets, base }
}
