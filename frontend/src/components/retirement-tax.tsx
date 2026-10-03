import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { buildProjectionInputs, read, write, DEFAULT_PLAN, PLAN_KEY, type Plan } from '@/lib/retirement-plan'
import { projectRetirement, type Assumptions } from '@/lib/retirement-projection'
import { formatCurrency } from '@/lib/format'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Asset, RecurringTransaction } from '@/types'

const KIND_COLORS = { income: '#6366F1', yield: '#10B981', rent: '#06B6D4', gains: '#F59E0B' } as const
type Kind = keyof typeof KIND_COLORS

const tooltipStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
}

function formatCompact(value: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

interface Line {
  /** Key the rate is saved under. */
  key: string
  label: string
  /** What the line is worth in a year, today's money. */
  yearly: number
  /** Rate when none is typed, percent. */
  fallback: number
  note?: string
}

/** Tax for every line the plan takes into account, with summaries of what it comes to. */
export function RetirementTax({
  items,
  assets,
  excluded,
  currency,
  locale,
}: {
  items: RecurringTransaction[]
  assets: Asset[]
  excluded: ReadonlySet<string>
  currency: string
  locale: string
}) {
  const { t } = useTranslation()
  const { mask, privacyMode, MASK } = usePrivacyMode()
  const [plan, setPlanState] = useState<Plan>(() => read(PLAN_KEY, DEFAULT_PLAN))
  const setPlan = (next: Plan) => {
    setPlanState(next)
    write(PLAN_KEY, next)
  }
  const a = plan.assumptions
  const rates = plan.taxRates ?? {}
  const setDefault = (key: 'taxIncomePercent' | 'taxAssetIncomePercent' | 'taxRentPercent' | 'taxGainsPercent', value: number) =>
    setPlan({ ...plan, assumptions: { ...a, [key]: value } as Assumptions })
  const setRate = (key: string, value: number | null) => {
    const next = { ...rates }
    if (value === null) delete next[key]
    else next[key] = value
    setPlan({ ...plan, taxRates: next })
  }

  const { summary, projectionAssets, base, whatIfs } = useMemo(
    () => buildProjectionInputs(plan, items, assets, currency, excluded),
    [plan, items, assets, currency, excluded],
  )
  const projection = useMemo(() => projectRetirement({ ...base, whatIfs }), [base, whatIfs])
  const thisYear = new Date().getFullYear()
  const money = (v: number) => mask(formatCurrency(v, currency, locale))
  const axis = (v: number) => (privacyMode ? '' : v === 0 ? '0' : formatCompact(v, currency, locale))
  const percent = (v: number) => `${Number(v.toFixed(1))}%`

  // The lines, grouped by the kind of tax they pay.
  const defaults = {
    income: a.taxIncomePercent ?? 0,
    yield: a.taxAssetIncomePercent ?? 0,
    rent: a.taxRentPercent ?? 0,
    gains: a.taxGainsPercent ?? 0,
  }
  const recurring: Line[] = summary.income
    .filter((l) => l.kind === 'recurring' && !excluded.has(l.id))
    .map((l) => ({ key: `income:${l.id}`, label: l.label, yearly: l.monthly * 12, fallback: defaults.income }))
  const whatIfIncome: Line[] = plan.whatIfs
    .filter((w) => w.kind === 'income')
    .map((w) => ({ key: `whatif:${w.id}`, label: w.label, yearly: w.kind === 'income' ? w.monthly * 12 : 0, fallback: defaults.income }))
  const yields: Line[] = projectionAssets
    .filter((x) => x.yieldPercent && x.value > 0)
    .map((x) => ({ key: `yield:${x.id}`, label: x.name, yearly: (x.value * (x.yieldPercent ?? 0)) / 100, fallback: defaults.yield, note: `${Number((x.yieldPercent ?? 0).toFixed(2))}%` }))
  const rents: Line[] = projectionAssets
    .filter((x) => x.fixedMonthly)
    .map((x) => ({ key: `rent:${x.id}`, label: x.name, yearly: (x.fixedMonthly ?? 0) * 12, fallback: defaults.rent }))
  // Gains: what selling the asset today would be taxed on.
  const gains: Line[] = projectionAssets
    .filter((x) => x.drawable && x.value > 0)
    .sort((x, y) => y.value - x.value)
    .map((x) => ({
      key: `gains:${x.id}`,
      label: x.name,
      yearly: Math.max(0, x.value - (x.costBasis ?? x.value)),
      fallback: x.taxFree ? 0 : defaults.gains,
      note: x.costBasis === undefined ? t('retirement.tax.noBasis') : undefined,
    }))

  const rateOf = (line: Line) => rates[line.key] ?? line.fallback
  const taxOf = (line: Line) => (line.yearly * rateOf(line)) / 100
  const sum = (lines: Line[], pick: (l: Line) => number) => lines.reduce((total, l) => total + pick(l), 0)

  const totals = projection.rows.reduce(
    (acc, row) => ({
      income: acc.income + row.taxKinds.income,
      yield: acc.yield + row.taxKinds.yield,
      rent: acc.rent + row.taxKinds.rent,
      gains: acc.gains + row.taxKinds.gains,
      received: acc.received + row.income,
    }),
    { income: 0, yield: 0, rent: 0, gains: 0, received: 0 },
  )
  const grandTotal = totals.income + totals.yield + totals.rent + totals.gains
  const horizon = a.horizonYears
  const peak = projection.rows.reduce((best, row) => (row.tax > best.tax ? row : best), projection.rows[0])
  const todayYearly = sum([...recurring, ...yields, ...rents], taxOf)
  const todayGross = sum([...recurring, ...yields, ...rents], (l) => l.yearly)

  const chartData = projection.rows.map((row) => ({
    label: String(thisYear + row.year),
    income: Math.round(row.taxKinds.income),
    yield: Math.round(row.taxKinds.yield),
    rent: Math.round(row.taxKinds.rent),
    gains: Math.round(row.taxKinds.gains),
  }))

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-border">
          <p className="text-sm font-semibold text-foreground">{t('retirement.tax.title')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('retirement.tax.subtitle')}</p>
        </div>
        <div className="p-4 sm:p-5 space-y-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">{t('retirement.tax.defaults')}</p>
            <p className="text-[11px] text-muted-foreground mb-2">{t('retirement.projection.taxesHint')}</p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <DefaultRate label={t('retirement.projection.taxIncome')} value={a.taxIncomePercent ?? 0} onChange={(v) => setDefault('taxIncomePercent', v)} />
              <DefaultRate label={t('retirement.projection.taxAssetIncome')} value={a.taxAssetIncomePercent ?? 0} onChange={(v) => setDefault('taxAssetIncomePercent', v)} />
              <DefaultRate label={t('retirement.projection.taxRent')} value={a.taxRentPercent ?? 0} onChange={(v) => setDefault('taxRentPercent', v)} />
              <DefaultRate label={t('retirement.projection.taxGains')} value={a.taxGainsPercent ?? 0} onChange={(v) => setDefault('taxGainsPercent', v)} />
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card label={t('retirement.tax.totalOver', { years: horizon })} value={money(grandTotal)} hint={t('retirement.tax.totalHint')} />
            <Card label={t('retirement.tax.share')} value={totals.received > 0 ? percent((grandTotal / totals.received) * 100) : '–'} hint={t('retirement.tax.shareHint')} />
            <Card label={t('retirement.tax.today')} value={money(todayYearly)} hint={t('retirement.tax.todayHint', { gross: money(todayGross) })} />
            <Card label={t('retirement.tax.peak')} value={peak ? money(peak.tax) : '–'} hint={peak ? t('retirement.tax.peakHint', { year: thisYear + peak.year }) : ''} />
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">{t('retirement.tax.chartTitle')}</p>
            <div className="h-60">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tickFormatter={axis} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} width={64} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => (privacyMode ? MASK : formatCurrency(Number(v), currency, locale))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {(Object.keys(KIND_COLORS) as Kind[]).map((kind) => (
                    <Bar key={kind} dataKey={kind} stackId="tax" name={t(`retirement.tax.kind_${kind}`)} fill={KIND_COLORS[kind]} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      <LineTable title={t('retirement.tax.secIncome')} hint={t('retirement.tax.secIncomeHint')} lines={recurring} {...{ rates, setRate, money, taxOf, percent }} />
      <LineTable title={t('retirement.tax.secWhatIf')} hint={t('retirement.tax.secWhatIfHint')} lines={whatIfIncome} {...{ rates, setRate, money, taxOf, percent }} />
      <LineTable title={t('retirement.tax.secYield')} hint={t('retirement.tax.secYieldHint')} lines={yields} {...{ rates, setRate, money, taxOf, percent }} />
      <LineTable title={t('retirement.tax.secRent')} hint={t('retirement.tax.secRentHint')} lines={rents} {...{ rates, setRate, money, taxOf, percent }} />
      <LineTable
        title={t('retirement.tax.secGains')}
        hint={t('retirement.tax.secGainsHint')}
        lines={gains}
        gainsColumns
        {...{ rates, setRate, money, taxOf, percent }}
      />

      <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5">
        <p className="text-sm font-semibold text-foreground mb-3">{t('retirement.tax.yearTitle')}</p>
        <div className="overflow-x-auto max-h-96 overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 bg-card">
              <tr className="text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">{t('retirement.projection.tableYear')}</th>
                {(Object.keys(KIND_COLORS) as Kind[]).map((kind) => (
                  <th key={kind} className="text-right font-medium px-3 py-2">{t(`retirement.tax.kind_${kind}`)}</th>
                ))}
                <th className="text-right font-medium px-3 py-2">{t('retirement.projection.tableTotal')}</th>
                <th className="text-right font-medium px-3 py-2">{t('retirement.tax.shareShort')}</th>
              </tr>
            </thead>
            <tbody>
              {projection.rows.map((row) => (
                <tr key={row.year} className="border-t border-border">
                  <td className="px-3 py-1.5">{thisYear + row.year}</td>
                  {(Object.keys(KIND_COLORS) as Kind[]).map((kind) => (
                    <td key={kind} className="text-right px-3 py-1.5">{row.taxKinds[kind] > 0.5 ? money(row.taxKinds[kind]) : '–'}</td>
                  ))}
                  <td className="text-right px-3 py-1.5 font-medium">{row.tax > 0.5 ? money(row.tax) : '–'}</td>
                  <td className="text-right px-3 py-1.5 text-muted-foreground">{row.income > 0 && row.tax > 0.5 ? percent((row.tax / row.income) * 100) : '–'}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-3 py-1.5">{t('retirement.tax.totals')}</td>
                {(Object.keys(KIND_COLORS) as Kind[]).map((kind) => (
                  <td key={kind} className="text-right px-3 py-1.5">{totals[kind] > 0.5 ? money(totals[kind]) : '–'}</td>
                ))}
                <td className="text-right px-3 py-1.5">{money(grandTotal)}</td>
                <td className="text-right px-3 py-1.5 text-muted-foreground">{totals.received > 0 ? percent((grandTotal / totals.received) * 100) : '–'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-3">{t('retirement.tax.disclaimer')}</p>
      </div>
    </div>
  )
}

function Card({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
      <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>
    </div>
  )
}

function DefaultRate({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          step="any"
          min={0}
          max={80}
          value={value}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (!Number.isNaN(v)) onChange(Math.min(80, Math.max(0, v)))
          }}
          className="pr-8 h-8"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">%</span>
      </div>
    </div>
  )
}

function LineTable({
  title,
  hint,
  lines,
  rates,
  setRate,
  money,
  taxOf,
  percent,
  gainsColumns,
}: {
  title: string
  hint: string
  lines: Line[]
  rates: Record<string, number>
  setRate: (key: string, value: number | null) => void
  money: (v: number) => string
  taxOf: (line: Line) => number
  percent: (v: number) => string
  gainsColumns?: boolean
}) {
  const { t } = useTranslation()
  if (lines.length === 0) return null
  const totalYearly = lines.reduce((sum, l) => sum + l.yearly, 0)
  const totalTax = lines.reduce((sum, l) => sum + taxOf(l), 0)
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-0.5 mb-3">{hint}</p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">{t('retirement.tax.line')}</th>
              <th className="text-right font-medium px-3 py-2">{gainsColumns ? t('retirement.tax.gainToday') : t('retirement.tax.perYear')}</th>
              <th className="text-right font-medium px-3 py-2">{t('retirement.tax.rate')}</th>
              <th className="text-right font-medium px-3 py-2">{gainsColumns ? t('retirement.tax.ifSold') : t('retirement.tax.taxPerYear')}</th>
              {!gainsColumns && <th className="text-right font-medium px-3 py-2">{t('retirement.tax.afterTax')}</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key} className="border-t border-border">
                <td className="px-3 py-1.5">
                  <span className="block truncate max-w-xs">{line.label}</span>
                  {line.note && <span className="text-[10px] text-muted-foreground">{line.note}</span>}
                </td>
                <td className="text-right px-3 py-1.5">{money(line.yearly)}</td>
                <td className="text-right px-3 py-1.5">
                  <span className="relative inline-block">
                    <Input
                      type="number"
                      step="any"
                      min={0}
                      max={100}
                      value={rates[line.key] ?? ''}
                      placeholder={String(Number(line.fallback.toFixed(2)))}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        setRate(line.key, e.target.value === '' || Number.isNaN(v) ? null : Math.min(100, Math.max(0, v)))
                      }}
                      className="h-7 w-20 pr-5 text-right text-xs"
                      aria-label={t('retirement.tax.rateFor', { name: `${line.label} · ${title}` })}
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                  </span>
                </td>
                <td className="text-right px-3 py-1.5">{money(taxOf(line))}</td>
                {!gainsColumns && <td className="text-right px-3 py-1.5 text-muted-foreground">{money(line.yearly - taxOf(line))}</td>}
              </tr>
            ))}
            <tr className="border-t-2 border-border font-semibold">
              <td className="px-3 py-1.5">{t('retirement.tax.totals')}</td>
              <td className="text-right px-3 py-1.5">{money(totalYearly)}</td>
              <td className="text-right px-3 py-1.5 text-muted-foreground">{totalYearly > 0 ? percent((totalTax / totalYearly) * 100) : '–'}</td>
              <td className="text-right px-3 py-1.5">{money(totalTax)}</td>
              {!gainsColumns && <td className="text-right px-3 py-1.5 text-muted-foreground">{money(totalYearly - totalTax)}</td>}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground mt-2">{t('retirement.tax.blankHint')}</p>
    </div>
  )
}
