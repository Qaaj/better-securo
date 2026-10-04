/**
 * The retirement plan as data: every setting the projection used and every
 * result, in one JSON document that can be pasted into a chat or a script and
 * read without the app, and a year-by-year CSV for a spreadsheet. Amounts are
 * in the plan's currency; "nominal" amounts are in the money of each year,
 * "today's money" has inflation taken out.
 */
import { CASH_ID } from './retirement-projection'
import type { FullReportInput } from './retirement-full-report'
import { SWEEP_CRASH, SWEEP_SPEND } from './retirement-simulation'

export interface ExportLine {
  label: string
  monthly: number
  counted: boolean
  risesWithInflation: boolean
  lastYear?: number
  taxRatePercent?: number
}

export interface ExportExtras {
  incomeLines: ExportLine[]
  costLines: ExportLine[]
  /** Tax rates left at the default, percent, by kind. */
  defaultTaxPercent: { income: number; yield: number; rent: number; gains: number }
}

const round = (v: number, digits = 2) => Number(v.toFixed(digits))

export function buildExportJson(input: FullReportInput, extras: ExportExtras): string {
  const { scenario, baseline, assumptions: a, assets, now, simulation } = input
  const thisYear = now.getFullYear()
  const names: Record<string, string> = { [CASH_ID]: 'cash buffer' }
  for (const x of assets) names[x.id] = x.name
  const byName = (record: Record<string, number>) =>
    Object.fromEntries(Object.entries(record).filter(([, v]) => Math.abs(v) > 0.005).map(([id, v]) => [names[id] ?? id, round(v)]))

  const doc = {
    about: {
      generatedAt: now.toISOString(),
      app: 'better-securo retirement planner',
      currency: input.currency,
      note: 'A planning aid, not a forecast. Year 0 is the current year. "nominal" amounts are in each year\'s own money (inflation included); "todaysMoney" has inflation taken out. Costs are paid from income first; any shortfall is met by selling from assets marked sellFrom, after tax on the gain.',
    },
    settings: {
      horizonYears: a.horizonYears,
      inflationPercent: a.inflationPercent,
      incomeRisesWithInflation: a.incomeIndexed,
      drawdown: {
        startsYear: thisYear + (a.drawdownStartYear ?? 0),
        endsYear: a.drawdownEndYear !== undefined ? thisYear + a.drawdownEndYear : null,
        sellStrategy: a.sellStrategy === 'ordered' ? 'in the order set on each asset (lower first, unset last)' : 'in proportion to value',
      },
      livingAndTravel: input.living && input.living.monthly > 0 ? { monthly: input.living.monthly, risesWithInflation: input.living.inflates } : null,
      cashBufferYears: a.bufferYears ?? 0,
      tax: {
        defaultRatesPercent: extras.defaultTaxPercent,
        ratesSetPerLine: input.taxLines.map((l) => ({ line: l.label, kind: l.kind, ratePercent: l.rate })),
        notes: 'Tax on income and yields and rent is taken from each year\'s cash flow. Tax on a sale applies to the gain above cost basis only, and a sale is sized so what arrives after tax covers the cost.',
      },
      whatIfs: input.whatIfs.map((w) => ({ ...w })),
      linesWithALastYear: input.endedLines.map((l) => ({ line: l.label, lastYear: l.year })),
      amountsThatDoNotRiseWithInflation: input.fixedLines.map((l) => ({ line: l.label, monthly: round(l.monthly) })),
    },
    recurring: {
      income: extras.incomeLines,
      costs: extras.costLines,
    },
    assets: assets.map((x) => ({
      name: x.name,
      value: round(x.value),
      sellFrom: x.drawable,
      sellOrder: x.sellOrder ?? null,
      growthPercentPerYear: x.growthPercent ?? 0,
      yieldPercent: x.yieldPercent ?? null,
      fixedIncomeMonthly: x.fixedMonthly ?? null,
      fixedIncomeLastYear: x.fixedUntilYear !== undefined ? thisYear + x.fixedUntilYear : null,
      plannedSalePercentPerYear: x.sellPercent ?? null,
      costBasis: x.costBasis ?? null,
      gainsTaxFree: !!x.taxFree,
      taxRatesPercent: { yield: x.yieldTaxPercent ?? null, rent: x.rentTaxPercent ?? null, gains: x.gainsTaxPercent ?? null },
      hypotheticalAsset: !!x.temporary,
      existsFromYear: x.startYear ? thisYear + x.startYear : null,
    })),
    projection: {
      summary: {
        runwayYears: scenario.runwayYears === null ? `lasts the whole ${a.horizonYears} years` : round(scenario.runwayYears, 1),
        assetsYouSellFromNow: round(scenario.drawableNow),
        netWorthNow: round(scenario.netWorthNow),
        assetsLeftAtDrawdownEnd: scenario.leftAtEnd === null ? null : round(scenario.leftAtEnd),
        totalTaxOverHorizon: round(scenario.totalTax),
        baselineWithoutWhatIfs: input.whatIfs.length ? { runwayYears: baseline.runwayYears === null ? 'lasts' : round(baseline.runwayYears, 1), totalTax: round(baseline.totalTax) } : null,
      },
      years: scenario.rows.map((row) => ({
        year: thisYear + row.year,
        phase: row.phase,
        income: round(row.income),
        outgoing: round(row.outgoing),
        tax: { total: round(row.tax), income: round(row.taxKinds.income), yields: round(row.taxKinds.yield), rent: round(row.taxKinds.rent), gains: round(row.taxKinds.gains) },
        netCashFlow: round(row.netFlow),
        soldFromAssets: byName(row.drawn),
        shortfallNotCovered: round(row.unfunded),
        assetsYouSellFromAtYearEnd: round(row.drawable),
        netWorthAtYearEnd: round(row.netWorth),
        assetValuesAtYearEnd: byName(row.byAsset),
        priceLevelVsToday: round(row.deflator, 4),
      })),
    },
    stressTest: simulation
      ? {
          what: 'Monte Carlo: many random futures with market crashes, slumps and uneven inflation, each run through the same projection. The asset growth rate in the plan is its expected return.',
          settings: {
            futures: simulation.result.runs,
            seed: simulation.params.seed,
            marketSwingsScale: simulation.params.volatilityScale,
            crashChancePercentPerYear: simulation.params.crashChancePercent,
            crashDepthPercent: [simulation.params.crashMinPercent, simulation.params.crashMaxPercent],
            slumpAfterCrash: { years: simulation.params.slumpYears, growthLostPercent: simulation.params.slumpCutPercent },
            inflationWobblePoints: simulation.params.inflationSpread,
            inflationSpike: { chancePercentPerYear: simulation.params.spikeChancePercent, extraPoints: simulation.params.spikeExtraPoints, lastsYears: 3 },
            assetBehaviour: simulation.behaviour.map((b) => ({ asset: b.name, behavesLike: b.riskClass })),
          },
          results: {
            chanceTheMoneyLasts: round(simulation.result.successRate, 3),
            medianYearItRunsOutIfItDoes: simulation.result.medianRunOutYear === null ? null : thisYear + simulation.result.medianRunOutYear,
            shareOfFuturesRunOutByYear: simulation.result.depletedBy.map((share, i) => ({ year: thisYear + i, share: round(share, 3) })),
            todaysMoney: {
              typicalAssetsLeftAtEnd: round(simulation.result.real.medianEnd),
              badLuckAssetsLeftAtEnd_worst1in20: round(simulation.result.real.worstCaseEnd),
              assetsYouSellFromByYear: simulation.result.real.bands.map((b) => ({ year: thisYear + b.year, p10: round(b.p10), p25: round(b.p25), median: round(b.p50), p75: round(b.p75), p90: round(b.p90) })),
            },
            nominal: {
              typicalAssetsLeftAtEnd: round(simulation.result.nominal.medianEnd),
              badLuckAssetsLeftAtEnd_worst1in20: round(simulation.result.nominal.worstCaseEnd),
              assetsYouSellFromByYear: simulation.result.nominal.bands.map((b) => ({ year: thisYear + b.year, p10: round(b.p10), p25: round(b.p25), median: round(b.p50), p75: round(b.p75), p90: round(b.p90) })),
            },
          },
          resilienceGrid: simulation.grid
            ? { futuresPerCell: simulation.runsPerCell, cells: simulation.grid.map((c) => ({ spendingPercentOfPlan: Math.round(c.spend * 100), crashChancePercentPerYear: c.crash, chanceTheMoneyLasts: round(c.successRate, 3) })) }
            : null,
          cashBufferComparison: simulation.buffers
            ? { futuresPerCell: simulation.runsPerCell, cells: simulation.buffers.map((c) => ({ bufferYears: c.years, chanceTheMoneyLasts: round(c.successRate, 3), typicalAssetsLeftAtEndTodaysMoney: round(c.medianEnd) })) }
            : null,
          gridAxes: { spendingPercentOfPlan: SWEEP_SPEND.map((s) => Math.round(s * 100)), crashChancePercentPerYear: SWEEP_CRASH },
        }
      : null,
  }
  return JSON.stringify(doc, null, 2)
}

const csvCell = (value: string | number) => {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One row per year: the projection, the tax split, the value of each asset and, when the stress test ran, its bands. */
export function buildExportCsv(input: FullReportInput): string {
  const { scenario, assets, now, simulation } = input
  const thisYear = now.getFullYear()
  const names: Record<string, string> = { [CASH_ID]: 'cash buffer' }
  for (const x of assets) names[x.id] = x.name
  const peak: Record<string, number> = {}
  for (const row of scenario.rows) for (const [id, v] of Object.entries(row.byAsset)) peak[id] = Math.max(peak[id] ?? 0, v)
  const assetIds = Object.keys(peak).sort((p, q) => peak[q] - peak[p])

  const headers = [
    'year', 'phase', 'income', 'outgoing', 'tax_total', 'tax_income', 'tax_yields', 'tax_rent', 'tax_gains', 'net_cash_flow',
    'sold_total', 'shortfall_not_covered', 'assets_you_sell_from', 'net_worth',
    ...assetIds.map((id) => `value: ${names[id] ?? id}`),
    ...assetIds.filter((id) => scenario.rows.some((r) => (r.drawn[id] ?? 0) > 0.005)).map((id) => `sold: ${names[id] ?? id}`),
    ...(simulation ? ['sim_todays_money_p10', 'sim_todays_money_p25', 'sim_todays_money_median', 'sim_todays_money_p75', 'sim_todays_money_p90', 'sim_nominal_median', 'sim_share_run_out'] : []),
  ]
  const soldIds = assetIds.filter((id) => scenario.rows.some((r) => (r.drawn[id] ?? 0) > 0.005))
  const rows = scenario.rows.map((row, i) => {
    const sold = Object.values(row.drawn).reduce((s, v) => s + v, 0)
    const cells: (string | number)[] = [
      thisYear + row.year, row.phase, round(row.income), round(row.outgoing), round(row.tax), round(row.taxKinds.income), round(row.taxKinds.yield),
      round(row.taxKinds.rent), round(row.taxKinds.gains), round(row.netFlow), round(sold), round(row.unfunded), round(row.drawable), round(row.netWorth),
      ...assetIds.map((id) => round(row.byAsset[id] ?? 0)),
      ...soldIds.map((id) => round(row.drawn[id] ?? 0)),
    ]
    if (simulation) {
      const real = simulation.result.real.bands[i]
      cells.push(round(real.p10), round(real.p25), round(real.p50), round(real.p75), round(real.p90), round(simulation.result.nominal.bands[i].p50), round(simulation.result.depletedBy[i], 3))
    }
    return cells
  })
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}
