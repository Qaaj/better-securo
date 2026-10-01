import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Plus, Save, Trash2 } from 'lucide-react'
import { annualGrowthPercent, assetFixedMonthly, assetValue, computeRetirement } from '@/lib/retirement'
import {
  defaultDrawable,
  projectRetirement,
  type Assumptions,
  type ProjectionAsset,
  type WhatIf,
} from '@/lib/retirement-projection'
import { formatCurrency } from '@/lib/format'
import { AssetsChart, type ChartMode } from '@/components/retirement-projection-charts'
import { cn } from '@/lib/utils'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Asset, RecurringTransaction } from '@/types'

/** An asset that exists only in the plan, e.g. "more bonds". */
interface TempAsset {
  id: string
  name: string
  value: number
  growthPercent: number
  yieldPercent: number
  /** The asset exists from this year (0 = now). Older saved plans have none. */
  fromYear?: number
}

interface Plan {
  assumptions: Assumptions
  drawable: Record<string, boolean>
  /** Growth a year the user typed for an asset, over the one its own rule gives. */
  growth: Record<string, number>
  /** The order to sell in, when the strategy is "in my order": lower first. */
  sellOrder: Record<string, number>
  /** Hypothetical assets to sell from, kept with the plan. */
  tempAssets: TempAsset[]
  whatIfs: WhatIf[]
}

const DEFAULT_PLAN: Plan = {
  assumptions: { horizonYears: 30, inflationPercent: 2, incomeIndexed: true, drawdownStartYear: 0, sellStrategy: 'pro_rata' },
  drawable: {},
  growth: {},
  sellOrder: {},
  tempAssets: [],
  whatIfs: [],
}
const PLAN_KEY = 'retirement:plan'
const SCENARIOS_KEY = 'retirement:scenarios'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Blocked storage: the plan just does not persist.
  }
}

function formatCompact(value: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

const tooltipStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
}

/** Runway, a projection of the assets you would spend from, and a what-if simulator. */
export function RetirementProjection({
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
  const [scenarios, setScenarios] = useState<Record<string, Plan>>(() => read<Record<string, Plan>>(SCENARIOS_KEY, {}))
  const [scenarioName, setScenarioName] = useState('')
  const [chartMode, setChartMode] = useState<ChartMode>('total')
  const setPlan = (next: Plan) => {
    setPlanState(next)
    write(PLAN_KEY, next)
  }
  const setAssumption = <K extends keyof Assumptions>(key: K, value: Assumptions[K]) =>
    setPlan({ ...plan, assumptions: { ...plan.assumptions, [key]: value } })

  // What the page already counts feeds the projection, so its switches apply here too.
  const summary = useMemo(() => computeRetirement(items, assets, currency, excluded), [items, assets, currency, excluded])
  const recurringIncomeMonthly = summary.income
    .filter((l) => l.kind === 'recurring' && !excluded.has(l.id))
    .reduce((sum, l) => sum + l.monthly, 0)

  const projectionAssets: ProjectionAsset[] = useMemo(() => {
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
      })
    }
    return list
  }, [assets, currency, excluded, plan.drawable, plan.growth, plan.sellOrder, plan.tempAssets])

  const base = { recurringIncomeMonthly, outgoingMonthly: summary.outgoingMonthly, assets: projectionAssets, assumptions: plan.assumptions }
  const baseline = useMemo(() => projectRetirement({ ...base, whatIfs: [] }), [base.recurringIncomeMonthly, base.outgoingMonthly, projectionAssets, plan.assumptions]) // eslint-disable-line react-hooks/exhaustive-deps
  const scenario = useMemo(() => projectRetirement({ ...base, whatIfs: plan.whatIfs }), [base.recurringIncomeMonthly, base.outgoingMonthly, projectionAssets, plan.assumptions, plan.whatIfs]) // eslint-disable-line react-hooks/exhaustive-deps

  const thisYear = new Date().getFullYear()
  const horizon = plan.assumptions.horizonYears
  const money = (v: number) => mask(formatCurrency(v, currency, locale))
  const runway = (years: number | null) =>
    years === null ? t('retirement.projection.beyond', { years: horizon }) : t('retirement.projection.years', { years: years.toFixed(1), calendar: thisYear + Math.floor(years) })

  const chartData = scenario.rows.map((row) => ({
    label: String(thisYear + row.year),
    income: Math.round(row.income),
    outgoing: Math.round(row.outgoing),
  }))
  const axis = (v: number) => (privacyMode ? '' : v === 0 ? '0' : formatCompact(v, currency, locale))
  const startYear = plan.assumptions.drawdownStartYear ?? 0
  const endYear = plan.assumptions.drawdownEndYear
  const names = useMemo(() => Object.fromEntries(projectionAssets.map((a) => [a.id, a.name])), [projectionAssets])
  const drawableIds = useMemo(() => new Set(projectionAssets.filter((a) => a.drawable).map((a) => a.id).concat('__cash__')), [projectionAssets])

  const hasWhatIfs = plan.whatIfs.length > 0
  const saveScenario = () => {
    const name = scenarioName.trim()
    if (!name) return
    const next = { ...scenarios, [name]: plan }
    setScenarios(next)
    write(SCENARIOS_KEY, next)
    setScenarioName('')
  }
  const loadScenario = (name: string) => {
    if (scenarios[name]) setPlan({ ...DEFAULT_PLAN, ...scenarios[name] })
  }
  const deleteScenario = (name: string) => {
    const { [name]: _removed, ...rest } = scenarios
    void _removed
    setScenarios(rest)
    write(SCENARIOS_KEY, rest)
  }

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm mb-4 overflow-hidden">
      <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('retirement.projection.title')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('retirement.projection.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {Object.keys(scenarios).length > 0 && (
            <select
              className="border border-border rounded-md px-2 py-1.5 text-sm bg-card"
              value=""
              onChange={(e) => e.target.value && loadScenario(e.target.value)}
              aria-label={t('retirement.projection.loadScenario')}
            >
              <option value="">{t('retirement.projection.loadScenario')}</option>
              {Object.keys(scenarios).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          <Input
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            placeholder={t('retirement.projection.scenarioName')}
            className="h-8 w-40"
          />
          <Button type="button" size="sm" variant="outline" onClick={saveScenario} disabled={!scenarioName.trim()}>
            <Save size={14} /> {t('retirement.projection.save')}
          </Button>
        </div>
      </div>

      <div className="p-4 sm:p-5 space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label={t('retirement.projection.runway')} value={runway(scenario.runwayYears)} tone={scenario.runwayYears === null ? 'positive' : 'negative'} hint={startYear > 0 ? t('retirement.projection.drawingFrom', { year: thisYear + startYear }) : hasWhatIfs ? t('retirement.projection.withWhatIfs') : t('retirement.projection.baselineHint')} />
          {hasWhatIfs && <Stat label={t('retirement.projection.runwayBaseline')} value={runway(baseline.runwayYears)} hint={t('retirement.projection.withoutWhatIfs')} />}
          {scenario.leftAtEnd !== null && endYear !== undefined && (
            <Stat label={t('retirement.projection.leftAtEnd', { year: thisYear + endYear })} value={money(scenario.leftAtEnd)} tone={scenario.leftAtEnd > 0 ? 'positive' : 'negative'} hint={t('retirement.projection.leftAtEndHint')} />
          )}
          <Stat label={t('retirement.projection.drawableNow')} value={money(scenario.drawableNow)} hint={t('retirement.projection.drawableHint')} />
          <Stat label={t('retirement.projection.inYears', { years: horizon })} value={money(scenario.rows[horizon - 1]?.drawable ?? 0)} hint={t('retirement.projection.netWorthIn', { amount: money(scenario.rows[horizon - 1]?.netWorth ?? 0) })} />
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-xs font-medium text-muted-foreground">{t('retirement.projection.chartAssets')}</p>
            <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
              {(['total', 'assets'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setChartMode(m)}
                  className={cn('px-2.5 py-1', chartMode === m ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}
                >
                  {t(`retirement.projection.mode_${m}`)}
                </button>
              ))}
            </div>
          </div>
          <AssetsChart
            scenario={scenario}
            baseline={baseline}
            hasWhatIfs={hasWhatIfs}
            names={names}
            drawableIds={drawableIds}
            thisYear={thisYear}
            currency={currency}
            locale={locale}
            mode={chartMode}
            startYear={startYear}
            endYear={endYear}
            privacyMode={privacyMode}
            mask={MASK}
          />
          <p className="text-[11px] text-muted-foreground mt-1">{t('retirement.projection.hoverHint')}</p>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">{t('retirement.projection.chartFlows')}</p>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tickFormatter={axis} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} width={64} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => (privacyMode ? MASK : formatCurrency(Number(v), currency, locale))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="income" name={t('retirement.projection.income')} stroke="#10B981" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="outgoing" name={t('retirement.projection.outgoing')} stroke="#F43F5E" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <Assumptions plan={plan} setAssumption={setAssumption} thisYear={thisYear} />
        <SpendFrom
          assets={projectionAssets}
          money={money}
          onToggle={(id, value) => setPlan({ ...plan, drawable: { ...plan.drawable, [id]: value } })}
          onGrowth={(id, value) => setPlan({ ...plan, growth: { ...plan.growth, [id]: value } })}
          ordered={plan.assumptions.sellStrategy === 'ordered'}
          onOrder={(id, value) => {
            const next = { ...plan.sellOrder }
            if (value === null) delete next[id]
            else next[id] = value
            setPlan({ ...plan, sellOrder: next })
          }}
          currency={currency}
          thisYear={thisYear}
          onAddTemp={(temp) => setPlan({ ...plan, tempAssets: [...(plan.tempAssets ?? []), temp] })}
          onChangeTemp={(id, value) => setPlan({ ...plan, tempAssets: (plan.tempAssets ?? []).map((a) => (a.id === id ? { ...a, value } : a)) })}
          onRemoveTemp={(id) => setPlan({ ...plan, tempAssets: (plan.tempAssets ?? []).filter((a) => a.id !== id) })}
        />
        <WhatIfs
          whatIfs={plan.whatIfs}
          assets={projectionAssets}
          horizon={horizon}
          thisYear={thisYear}
          onChange={(whatIfs) => setPlan({ ...plan, whatIfs })}
        />

        {Object.keys(scenarios).length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {Object.keys(scenarios).map((name) => (
              <span key={name} className="inline-flex items-center gap-1 text-xs rounded-full border border-border px-2.5 py-1">
                {name}
                <button type="button" onClick={() => deleteScenario(name)} aria-label={t('common.delete')} className="text-muted-foreground hover:text-rose-500">
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('retirement.projection.disclaimer')}</p>
      </div>
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: 'positive' | 'negative' }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold mt-0.5', tone === 'positive' && 'text-emerald-600', tone === 'negative' && 'text-rose-500')}>{value}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>
    </div>
  )
}

function Assumptions({ plan, setAssumption, thisYear }: { plan: Plan; setAssumption: <K extends keyof Assumptions>(key: K, value: Assumptions[K]) => void; thisYear: number }) {
  const { t } = useTranslation()
  const uid = useId()
  const a = plan.assumptions
  const number = (key: 'horizonYears' | 'inflationPercent', label: string, suffix: string, min: number, max: number) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${uid}-${key}`} className="text-xs">{label}</Label>
      <div className="relative">
        <Input
          id={`${uid}-${key}`}
          type="number"
          step="any"
          min={min}
          max={max}
          value={a[key]}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (!Number.isNaN(v)) setAssumption(key, Math.min(max, Math.max(min, v)))
          }}
          className="pr-12 h-8"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">{suffix}</span>
      </div>
    </div>
  )
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">{t('retirement.projection.assumptions')}</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {number('horizonYears', t('retirement.projection.horizon'), t('retirement.projection.yearsSuffix'), 5, 60)}
        {number('inflationPercent', t('retirement.projection.inflation'), '%', 0, 20)}
      </div>
      <p className="text-xs font-medium text-muted-foreground mt-4 mb-2">{t('retirement.projection.drawdown')}</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-start`} className="text-xs">{t('retirement.projection.drawdownStart', { year: thisYear + (a.drawdownStartYear ?? 0) })}</Label>
          <Input
            id={`${uid}-start`}
            type="number"
            min="0"
            max={a.horizonYears - 1}
            value={a.drawdownStartYear ?? 0}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (!Number.isNaN(v)) setAssumption('drawdownStartYear', Math.min(a.horizonYears - 1, Math.max(0, v)))
            }}
            className="h-8"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-end`} className="text-xs">
            {a.drawdownEndYear !== undefined ? t('retirement.projection.drawdownEnd', { year: thisYear + a.drawdownEndYear }) : t('retirement.projection.drawdownEndOpen')}
          </Label>
          <Input
            id={`${uid}-end`}
            type="number"
            min={a.drawdownStartYear ?? 0}
            max={a.horizonYears - 1}
            value={a.drawdownEndYear ?? ''}
            placeholder="∞"
            onChange={(e) => {
              if (e.target.value === '') return setAssumption('drawdownEndYear', undefined)
              const v = parseInt(e.target.value, 10)
              if (!Number.isNaN(v)) setAssumption('drawdownEndYear', Math.min(a.horizonYears - 1, Math.max(a.drawdownStartYear ?? 0, v)))
            }}
            className="h-8"
          />
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label htmlFor={`${uid}-strategy`} className="text-xs">{t('retirement.projection.sellStrategy')}</Label>
          <select
            id={`${uid}-strategy`}
            className="w-full border border-border rounded-md px-2 h-8 text-sm bg-card"
            value={a.sellStrategy ?? 'pro_rata'}
            onChange={(e) => setAssumption('sellStrategy', e.target.value as 'pro_rata' | 'ordered')}
          >
            <option value="pro_rata">{t('retirement.projection.strategyProRata')}</option>
            <option value="ordered">{t('retirement.projection.strategyOrdered')}</option>
          </select>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground mt-2">{t('retirement.projection.drawdownNote')}</p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground mt-3 cursor-pointer">
        <input type="checkbox" checked={a.incomeIndexed} onChange={(e) => setAssumption('incomeIndexed', e.target.checked)} className="size-4 accent-primary" />
        {t('retirement.projection.incomeIndexed')}
      </label>
    </div>
  )
}

function SpendFrom({
  assets,
  money,
  onToggle,
  onGrowth,
  ordered,
  onOrder,
  currency,
  thisYear,
  onAddTemp,
  onChangeTemp,
  onRemoveTemp,
}: {
  assets: ProjectionAsset[]
  money: (v: number) => string
  onToggle: (id: string, value: boolean) => void
  onGrowth: (id: string, value: number) => void
  ordered: boolean
  onOrder: (id: string, value: number | null) => void
  currency: string
  thisYear: number
  onAddTemp: (temp: TempAsset) => void
  onChangeTemp: (id: string, value: number) => void
  onRemoveTemp: (id: string) => void
}) {
  const { t } = useTranslation()
  const uid = useId()
  const [tempName, setTempName] = useState('')
  const [tempValue, setTempValue] = useState('')
  const [tempGrowth, setTempGrowth] = useState('')
  const [tempYield, setTempYield] = useState('')
  const [tempFrom, setTempFrom] = useState('0')
  const addTemp = () => {
    const value = parseFloat(tempValue)
    if (Number.isNaN(value) || value <= 0) return
    onAddTemp({
      id: crypto.randomUUID(),
      name: tempName.trim() || t('retirement.projection.tempDefaultName'),
      value,
      growthPercent: parseFloat(tempGrowth) || 0,
      yieldPercent: parseFloat(tempYield) || 0,
      fromYear: Math.max(0, parseInt(tempFrom, 10) || 0),
    })
    setTempName('')
    setTempValue('')
    setTempGrowth('')
    setTempYield('')
    setTempFrom('0')
  }
  const owned = assets.filter((a) => a.value > 0).sort((a, b) => b.value - a.value)
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{t('retirement.projection.spendFrom')}</p>
      <p className="text-[11px] text-muted-foreground mb-2">{t('retirement.projection.spendFromHint')}</p>
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-1">
        {owned.map((asset) => (
          <li key={asset.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={asset.drawable}
              onChange={(e) => onToggle(asset.id, e.target.checked)}
              className="size-4 accent-primary shrink-0"
              aria-label={t('retirement.projection.spendFromThis', { name: asset.name })}
            />
            <span className={cn('min-w-0 flex-1 truncate', !asset.drawable && 'text-muted-foreground')}>
              {asset.name}
              {asset.temporary && (
                <span className="ml-1.5 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                  {asset.startYear ? t('retirement.projection.tempBadgeFrom', { year: thisYear + asset.startYear }) : t('retirement.projection.tempBadge')}
                </span>
              )}
            </span>
            {ordered && asset.drawable && (
              <Input
                type="number"
                min="1"
                step="1"
                value={asset.sellOrder ?? ''}
                placeholder="–"
                onChange={(e) => onOrder(asset.id, e.target.value === '' ? null : Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="h-7 w-12 px-1.5 text-center text-xs shrink-0"
                aria-label={t('retirement.projection.sellOrderOf', { name: asset.name })}
                title={t('retirement.projection.sellOrder')}
              />
            )}
            <span className="relative shrink-0">
              <Input
                type="number"
                step="any"
                value={Number((asset.growthPercent ?? 0).toFixed(2))}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (!Number.isNaN(v)) onGrowth(asset.id, Math.min(100, Math.max(-100, v)))
                }}
                className="h-7 w-[4.5rem] pr-5 text-right text-xs"
                aria-label={t('retirement.projection.growthOf', { name: asset.name })}
                title={t('retirement.projection.growthPerYear')}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
            </span>
            {asset.temporary ? (
              <>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={asset.value}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isNaN(v) && v > 0) onChangeTemp(asset.id, v)
                  }}
                  className="h-7 w-24 px-1.5 text-right text-xs shrink-0"
                  aria-label={t('retirement.projection.valueOf', { name: asset.name })}
                />
                <button type="button" onClick={() => onRemoveTemp(asset.id)} aria-label={t('retirement.projection.removeTemp', { name: asset.name })} className="text-muted-foreground hover:text-rose-500 shrink-0">
                  <Trash2 size={14} />
                </button>
              </>
            ) : (
              <span className="shrink-0 w-24 text-right tabular-nums text-xs text-muted-foreground">{money(asset.value)}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 rounded-lg border border-dashed border-border p-3">
        <p className="text-xs font-medium text-muted-foreground mb-2">{t('retirement.projection.addTemp')}</p>
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 items-end">
          <div className="space-y-1.5 col-span-2 lg:col-span-1">
            <Label htmlFor={`${uid}-tn`} className="text-xs">{t('retirement.projection.label')}</Label>
            <Input id={`${uid}-tn`} value={tempName} onChange={(e) => setTempName(e.target.value)} placeholder={t('retirement.projection.tempPlaceholder')} className="h-8" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-tv`} className="text-xs">{t('retirement.projection.tempValue', { currency })}</Label>
            <Input id={`${uid}-tv`} type="number" min="0" step="any" value={tempValue} onChange={(e) => setTempValue(e.target.value)} className="h-8" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-tg`} className="text-xs">{t('retirement.projection.growthPerYear')} %</Label>
            <Input id={`${uid}-tg`} type="number" step="any" value={tempGrowth} onChange={(e) => setTempGrowth(e.target.value)} className="h-8" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-ty`} className="text-xs">{t('retirement.projection.tempYield')}</Label>
            <Input id={`${uid}-ty`} type="number" min="0" step="any" value={tempYield} onChange={(e) => setTempYield(e.target.value)} className="h-8" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-tf`} className="text-xs">{t('retirement.projection.tempFrom', { year: thisYear + (parseInt(tempFrom, 10) || 0) })}</Label>
            <Input id={`${uid}-tf`} type="number" min="0" step="1" value={tempFrom} onChange={(e) => setTempFrom(e.target.value)} className="h-8" />
          </div>
          <Button type="button" size="sm" onClick={addTemp} disabled={!(parseFloat(tempValue) > 0)} className="h-8">
            <Plus size={14} /> {t('retirement.projection.addAsset')}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">{t('retirement.projection.tempHint')}</p>
      </div>
    </div>
  )
}

type Kind = WhatIf['kind']

function WhatIfs({
  whatIfs,
  assets,
  horizon,
  thisYear,
  onChange,
}: {
  whatIfs: WhatIf[]
  assets: ProjectionAsset[]
  horizon: number
  thisYear: number
  onChange: (next: WhatIf[]) => void
}) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<Kind>('expense')
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [fromYear, setFromYear] = useState('0')
  const [toYear, setToYear] = useState('')
  const [assetId, setAssetId] = useState('')
  const [fees, setFees] = useState('0')
  const sellable = assets.filter((a) => a.value > 0)

  const valid =
    kind === 'sell' ? Boolean(assetId) : Boolean(amount) && !Number.isNaN(parseFloat(amount))

  const add = () => {
    const id = crypto.randomUUID()
    const from = Math.max(0, parseInt(fromYear || '0', 10) || 0)
    let item: WhatIf
    if (kind === 'sell') {
      const asset = sellable.find((a) => a.id === assetId)
      item = { id, kind, label: label.trim() || t('retirement.projection.sellLabel', { name: asset?.name ?? '' }), assetId, year: from, feesPercent: parseFloat(fees) || 0 }
    } else if (kind === 'spend') {
      item = { id, kind, label: label.trim() || t('retirement.projection.kind_spend'), monthly: Math.abs(parseFloat(amount)), fromYear: from }
    } else if (kind === 'oneoff') {
      item = { id, kind, label: label.trim() || t('retirement.projection.oneoffLabel'), amount: parseFloat(amount), year: from }
    } else {
      item = { id, kind, label: label.trim() || t(`retirement.projection.kind_${kind}`), monthly: Math.abs(parseFloat(amount)), fromYear: from, toYear: toYear ? parseInt(toYear, 10) : undefined }
    }
    onChange([...whatIfs, item])
    setLabel('')
    setAmount('')
  }

  const describe = (w: WhatIf) => {
    if (w.kind === 'sell') return t('retirement.projection.describeSell', { year: thisYear + w.year, fees: w.feesPercent })
    if (w.kind === 'spend') return t('retirement.projection.describeSpend', { amount: w.monthly, from: thisYear + w.fromYear })
    if (w.kind === 'oneoff') return t('retirement.projection.describeOneoff', { amount: w.amount, year: thisYear + w.year })
    return t('retirement.projection.describeMonthly', { amount: w.monthly, from: thisYear + w.fromYear, to: w.toYear !== undefined ? thisYear + w.toYear : t('retirement.projection.onwards') })
  }

  const field = 'h-8'
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">{t('retirement.projection.whatIfs')}</p>
      {whatIfs.length > 0 && (
        <ul className="space-y-1 mb-3">
          {whatIfs.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-1.5 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{w.label}</span>
                <span className="text-xs text-muted-foreground ml-2">{describe(w)}</span>
              </span>
              <button type="button" onClick={() => onChange(whatIfs.filter((x) => x.id !== w.id))} aria-label={t('common.delete')} className="text-muted-foreground hover:text-rose-500 shrink-0">
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 items-end">
        <div className="space-y-1.5 col-span-2 lg:col-span-1">
          <Label className="text-xs">{t('retirement.projection.whatKind')}</Label>
          <select className={cn('w-full border border-border rounded-md px-2 text-sm bg-card', field)} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="expense">{t('retirement.projection.kind_expense')}</option>
            <option value="spend">{t('retirement.projection.kind_spend')}</option>
            <option value="income">{t('retirement.projection.kind_income')}</option>
            <option value="oneoff">{t('retirement.projection.kind_oneoff')}</option>
            <option value="sell">{t('retirement.projection.kind_sell')}</option>
          </select>
        </div>
        {kind === 'sell' ? (
          <>
            <div className="space-y-1.5 col-span-2 lg:col-span-2">
              <Label className="text-xs">{t('retirement.projection.asset')}</Label>
              <select className={cn('w-full border border-border rounded-md px-2 text-sm bg-card', field)} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">{t('retirement.projection.chooseAsset')}</option>
                {sellable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('retirement.projection.fees')}</Label>
              <Input type="number" min="0" max="100" step="any" value={fees} onChange={(e) => setFees(e.target.value)} className={field} />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('retirement.projection.label')}</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} className={field} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{kind === 'oneoff' ? t('retirement.projection.amountSigned') : t('retirement.projection.amountMonthly')}</Label>
              <Input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
            </div>
          </>
        )}
        <div className="space-y-1.5">
          <Label className="text-xs">{kind === 'expense' || kind === 'income' || kind === 'spend' ? t('retirement.projection.fromYear') : t('retirement.projection.inYear')}</Label>
          <Input type="number" min="0" max={horizon} value={fromYear} onChange={(e) => setFromYear(e.target.value)} className={field} />
        </div>
        {(kind === 'expense' || kind === 'income') && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('retirement.projection.toYear')}</Label>
            <Input type="number" min="0" max={horizon} value={toYear} onChange={(e) => setToYear(e.target.value)} className={field} placeholder="∞" />
          </div>
        )}
        <Button type="button" size="sm" onClick={add} disabled={!valid} className="h-8">
          <Plus size={14} /> {t('retirement.projection.add')}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground mt-2">{t('retirement.projection.yearsHint')}</p>
    </div>
  )
}
