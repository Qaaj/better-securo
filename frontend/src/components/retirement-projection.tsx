import { newId } from '@/lib/id'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download, Plus, Save, Trash2 } from 'lucide-react'
import {
  projectRetirement,
  type Assumptions,
  type ProjectionAsset,
  type WhatIf,
} from '@/lib/retirement-projection'
import {
  DEFAULT_PLAN,
  PLAN_KEY,
  SCENARIOS_KEY,
  SIM_KEY,
  buildProjectionInputs,
  read,
  write,
  type Plan,
  type TempAsset,
} from '@/lib/retirement-plan'
import type { IncomeLine, OutgoingLine } from '@/lib/retirement'
import { formatCurrency } from '@/lib/format'
import { downloadText, printHtml } from '@/lib/download'
import { buildFullReportHtml } from '@/lib/retirement-full-report'
import { DEFAULT_SIM, SWEEP_RUNS, bufferSweep, defaultRiskClass, simulate, sweep } from '@/lib/retirement-simulation'
import { buildReport, describeWhatIf, reportToHtml, reportToMarkdown } from '@/lib/retirement-report'
import { AssetsChart, AssetsTable, type ChartMode } from '@/components/retirement-projection-charts'
import { cn } from '@/lib/utils'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { Asset, RecurringTransaction } from '@/types'

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
  const inputs = useMemo(
    () => buildProjectionInputs(plan, items, assets, currency, excluded),
    // The what-ifs only matter to the scenario below.
    [plan.flat, plan.drawable, plan.growth, plan.sellOrder, plan.tempAssets, plan.assumptions, items, assets, currency, excluded], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const { summary, flatSet, projectionAssets, base } = inputs
  const baseline = useMemo(() => projectRetirement({ ...base, whatIfs: [] }), [base])
  const scenario = useMemo(() => projectRetirement({ ...base, whatIfs: plan.whatIfs }), [base, plan.whatIfs])

  const thisYear = new Date().getFullYear()
  const horizon = plan.assumptions.horizonYears
  const money = (v: number) => mask(formatCurrency(v, currency, locale))
  const runway = (years: number | null) =>
    years === null ? t('retirement.projection.beyond', { years: horizon }) : t('retirement.projection.years', { years: years.toFixed(1), calendar: thisYear + Math.floor(years) })

  const chartData = scenario.rows.map((row) => ({
    label: String(thisYear + row.year),
    income: Math.round(row.income),
    outgoing: Math.round(row.outgoing),
    tax: Math.round(row.tax),
  }))
  const axis = (v: number) => (privacyMode ? '' : v === 0 ? '0' : formatCompact(v, currency, locale))
  const startYear = plan.assumptions.drawdownStartYear ?? 0
  const endYear = plan.assumptions.drawdownEndYear
  const names = useMemo(() => Object.fromEntries(projectionAssets.map((a) => [a.id, a.name])), [projectionAssets])
  const drawableIds = useMemo(() => new Set(projectionAssets.filter((a) => a.drawable).map((a) => a.id).concat('__cash__')), [projectionAssets])

  const hasWhatIfs = plan.whatIfs.length > 0

  const makeReport = () => {
    const fixedLines = [
      ...summary.outgoing.filter((l) => !excluded.has(l.item.id) && flatSet.has(l.item.id)).map((l) => ({ label: l.item.description, monthly: l.monthly })),
      ...summary.income.filter((l) => l.kind === 'recurring' && !excluded.has(l.id) && flatSet.has(l.id)).map((l) => ({ label: l.label, monthly: l.monthly })),
      ...projectionAssets.filter((a) => a.fixedFlat && a.fixedMonthly).map((a) => ({ label: a.name, monthly: a.fixedMonthly ?? 0 })),
    ]
    return buildReport({
      t: t as unknown as Parameters<typeof buildReport>[0]['t'],
      currency,
      locale,
      now: new Date(),
      assumptions: plan.assumptions,
      whatIfs: plan.whatIfs,
      scenario,
      baseline,
      assets: projectionAssets,
      fixedLines,
    })
  }
  const stamp = () => new Date().toISOString().slice(0, 10)
  const exportMarkdown = () => downloadText(`retirement-plan-${stamp()}.md`, reportToMarkdown(makeReport()))
  const exportPdf = () => printHtml(reportToHtml(makeReport()))
  const [preparing, setPreparing] = useState(false)
  // The full report carries the stress test, so it is run here with the saved settings first.
  const exportHtml = async () => {
    setPreparing(true)
    try {
      const params = read(SIM_KEY, DEFAULT_SIM)
      const input = { ...base, whatIfs: plan.whatIfs }
      const types = Object.fromEntries(assets.map((x) => [x.id, x.type]))
      const classOf = (id: string) => params.classes[id] ?? defaultRiskClass(types[id] ?? '')
      const result = simulate(input, params, types)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const grid = await sweep(input, params, types, SWEEP_RUNS)
      const buffers = await bufferSweep(input, params, types, SWEEP_RUNS)
      const lineLabel = (id: string) => summary.outgoing.find((l) => l.item.id === id)?.item.description ?? summary.income.find((l) => l.id === id)?.label ?? id
      const html = buildFullReportHtml({
        t: t as unknown as Parameters<typeof buildReport>[0]['t'],
        currency,
        locale,
        now: new Date(),
        assumptions: plan.assumptions,
        whatIfs: plan.whatIfs,
        scenario,
        baseline,
        assets: projectionAssets,
        fixedLines: makeReport().fixed.length
          ? [
              ...summary.outgoing.filter((l) => !excluded.has(l.item.id) && flatSet.has(l.item.id)).map((l) => ({ label: l.item.description, monthly: l.monthly })),
              ...summary.income.filter((l) => l.kind === 'recurring' && !excluded.has(l.id) && flatSet.has(l.id)).map((l) => ({ label: l.label, monthly: l.monthly })),
              ...projectionAssets.filter((x) => x.fixedFlat && x.fixedMonthly).map((x) => ({ label: x.name, monthly: x.fixedMonthly ?? 0 })),
            ]
          : [],
        endedLines: Object.entries(plan.lineEnd ?? {}).map(([id, year]) => ({
          label: id.startsWith('asset:') ? names[id.split(':')[1]] ?? id : lineLabel(id),
          year,
        })),
        simulation: {
          params,
          result,
          grid,
          buffers,
          behaviour: projectionAssets.filter((x) => x.drawable && x.value > 0).map((x) => ({ name: x.name, riskClass: classOf(x.id) })),
          runsPerCell: SWEEP_RUNS,
        },
      })
      downloadText(`retirement-report-${stamp()}.html`, html, 'text/html;charset=utf-8')
    } finally {
      setPreparing(false)
    }
  }
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="outline">
                <Download size={14} /> {t('retirement.projection.export')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={preparing} onSelect={() => void exportHtml()}>
                {preparing ? t('retirement.fullReport.preparing') : t('retirement.fullReport.exportHtml')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={exportPdf}>{t('retirement.projection.exportPdf')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={exportMarkdown}>{t('retirement.projection.exportMarkdown')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="p-4 sm:p-5 space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label={t('retirement.projection.runway')} value={runway(scenario.runwayYears)} tone={scenario.runwayYears === null ? 'positive' : 'negative'} hint={startYear > 0 ? t('retirement.projection.drawingFrom', { year: thisYear + startYear }) : hasWhatIfs ? t('retirement.projection.withWhatIfs') : t('retirement.projection.baselineHint')} />
          {hasWhatIfs && <Stat label={t('retirement.projection.runwayBaseline')} value={runway(baseline.runwayYears)} hint={t('retirement.projection.withoutWhatIfs')} />}
          {scenario.leftAtEnd !== null && endYear !== undefined && (
            <Stat label={t('retirement.projection.leftAtEnd', { year: thisYear + endYear })} value={money(scenario.leftAtEnd)} tone={scenario.leftAtEnd > 0 ? 'positive' : 'negative'} hint={t('retirement.projection.leftAtEndHint')} />
          )}
          {scenario.totalTax > 0 && <Stat label={t('retirement.projection.totalTax')} value={money(scenario.totalTax)} hint={t('retirement.projection.totalTaxHint', { years: horizon })} />}
          <Stat label={t('retirement.projection.drawableNow')} value={money(scenario.drawableNow)} hint={t('retirement.projection.drawableHint')} />
          <Stat label={t('retirement.projection.inYears', { years: horizon })} value={money(scenario.rows[horizon - 1]?.drawable ?? 0)} hint={t('retirement.projection.netWorthIn', { amount: money(scenario.rows[horizon - 1]?.netWorth ?? 0) })} />
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-xs font-medium text-muted-foreground">{t('retirement.projection.chartAssets')}</p>
            <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
              {(['total', 'assets', 'table'] as const).map((m) => (
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
          {chartMode === 'table' ? (
            <AssetsTable
              scenario={scenario}
              names={names}
              drawableIds={drawableIds}
              thisYear={thisYear}
              money={money}
            />
          ) : (
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
          )}
          {chartMode !== 'table' && <p className="text-[11px] text-muted-foreground mt-1">{t('retirement.projection.hoverHint')}</p>}
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
                {scenario.totalTax > 0 && <Line type="monotone" dataKey="tax" name={t('retirement.projection.tax')} stroke="#F59E0B" dot={false} strokeWidth={2} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <Assumptions plan={plan} setAssumption={setAssumption} thisYear={thisYear} />
        <InflationLines
          income={summary.income.filter((l) => !excluded.has(l.id) && (l.kind === 'recurring' || l.asset?.income_mode === 'fixed'))}
          outgoing={summary.outgoing.filter((l) => !excluded.has(l.item.id))}
          flat={flatSet}
          incomeIndexed={plan.assumptions.incomeIndexed}
          money={money}
          onToggle={(id) => {
            const next = new Set(flatSet)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            setPlan({ ...plan, flat: [...next] })
          }}
          ends={plan.lineEnd ?? {}}
          onEnd={(id, year) => {
            const next = { ...(plan.lineEnd ?? {}) }
            if (year === null) delete next[id]
            else next[id] = year
            setPlan({ ...plan, lineEnd: next })
          }}
          thisYear={thisYear}
        />
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
        <TaxFreeAssets
          assets={projectionAssets.filter((a) => a.drawable && a.value > 0)}
          taxFree={plan.taxFree ?? {}}
          show={(plan.assumptions.taxGainsPercent ?? 0) > 0}
          onToggle={(id, value) => setPlan({ ...plan, taxFree: { ...(plan.taxFree ?? {}), [id]: value } })}
        />
        <WhatIfs
          whatIfs={plan.whatIfs}
          assets={projectionAssets}
          horizon={horizon}
          thisYear={thisYear}
          incomeIndexed={plan.assumptions.incomeIndexed}
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
  const number = (key: 'horizonYears' | 'inflationPercent' | 'taxIncomePercent' | 'taxAssetIncomePercent' | 'taxRentPercent' | 'taxGainsPercent' | 'bufferYears', label: string, suffix: string, min: number, max: number) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${uid}-${key}`} className="text-xs">{label}</Label>
      <div className="relative">
        <Input
          id={`${uid}-${key}`}
          type="number"
          step="any"
          min={min}
          max={max}
          value={a[key] ?? 0}
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
      <p className="text-xs font-medium text-muted-foreground mt-4 mb-1">{t('retirement.projection.taxes')}</p>
      <p className="text-[11px] text-muted-foreground mb-2">{t('retirement.projection.taxesHint')}</p>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {number('taxIncomePercent', t('retirement.projection.taxIncome'), '%', 0, 80)}
        {number('taxAssetIncomePercent', t('retirement.projection.taxAssetIncome'), '%', 0, 80)}
        {number('taxRentPercent', t('retirement.projection.taxRent'), '%', 0, 80)}
        {number('taxGainsPercent', t('retirement.projection.taxGains'), '%', 0, 80)}
        {number('bufferYears', t('retirement.projection.bufferYears'), t('retirement.projection.yearsSuffix'), 0, 10)}
      </div>
      <p className="text-[11px] text-muted-foreground mt-2">{t('retirement.projection.bufferHint')}</p>
    </div>
  )
}

/** Which lines rise with inflation. A fixed amount, like a mortgage payment or a
 *  fixed rent, should stay the same, so it can be unticked. Saved with the plan. */
function InflationLines({
  income,
  outgoing,
  flat,
  incomeIndexed,
  money,
  onToggle,
  ends,
  onEnd,
  thisYear,
}: {
  income: IncomeLine[]
  outgoing: OutgoingLine[]
  flat: ReadonlySet<string>
  incomeIndexed: boolean
  money: (v: number) => string
  onToggle: (id: string) => void
  ends: Record<string, number>
  onEnd: (id: string, year: number | null) => void
  thisYear: number
}) {
  const { t } = useTranslation()
  const incomeRows = income.map((l) => ({ id: l.id, label: l.label, monthly: l.monthly }))
  const costRows = outgoing.map((l) => ({ id: l.item.id, label: l.item.description, monthly: l.monthly }))

  const list = (rows: { id: string; label: string; monthly: number }[], disabled: boolean) => {
    const rising = rows.filter((r) => !flat.has(r.id)).reduce((sum, r) => sum + r.monthly, 0)
    const fixed = rows.filter((r) => flat.has(r.id)).reduce((sum, r) => sum + r.monthly, 0)
    return (
      <div>
        <p className="text-xs text-muted-foreground mb-2">
          {disabled
            ? t('retirement.projection.incomeNotIndexed')
            : t('retirement.projection.inflationTotals', { rising: money(rising), fixed: money(fixed) })}
        </p>
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-1 max-h-72 overflow-y-auto pr-1">
          {rows.map((row) => {
            const rises = !disabled && !flat.has(row.id)
            return (
              <li key={row.id}>
                <label className={cn('flex items-center gap-2 text-sm', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
                  <input
                    type="checkbox"
                    checked={rises}
                    disabled={disabled}
                    onChange={() => onToggle(row.id)}
                    className="size-4 accent-primary shrink-0"
                    aria-label={t('retirement.projection.inflationApplies', { name: row.label })}
                  />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <Input
                    type="number"
                    min={thisYear}
                    step="1"
                    value={ends[row.id] ?? ''}
                    placeholder={t('retirement.projection.untilPlaceholder')}
                    onChange={(e) => onEnd(row.id, e.target.value === '' ? null : parseInt(e.target.value, 10) || null)}
                    className="h-7 w-[4.5rem] px-1.5 text-center text-xs shrink-0"
                    aria-label={t('retirement.projection.countsUntil', { name: row.label })}
                    title={t('retirement.projection.countsUntilHint')}
                  />
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{money(row.monthly)}</span>
                </label>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mt-4">{t('retirement.projection.inflationTitle')}</p>
      <p className="text-[11px] text-muted-foreground mb-2">{t('retirement.projection.inflationHint')}</p>
      <Tabs defaultValue="costs">
        <TabsList>
          <TabsTrigger value="income">{t('retirement.projection.tabIncome')}</TabsTrigger>
          <TabsTrigger value="costs">{t('retirement.projection.tabCosts')}</TabsTrigger>
        </TabsList>
        <TabsContent value="income" className="mt-3">{list(incomeRows, !incomeIndexed)}</TabsContent>
        <TabsContent value="costs" className="mt-3">{list(costRows, false)}</TabsContent>
      </Tabs>
    </div>
  )
}

/** Assets whose gains are left out of the tax, such as a tax-sheltered account. */
function TaxFreeAssets({
  assets,
  taxFree,
  show,
  onToggle,
}: {
  assets: ProjectionAsset[]
  taxFree: Record<string, boolean>
  show: boolean
  onToggle: (id: string, value: boolean) => void
}) {
  const { t } = useTranslation()
  if (!show || assets.length === 0) return null
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{t('retirement.projection.taxFreeTitle')}</p>
      <p className="text-[11px] text-muted-foreground mb-2">{t('retirement.projection.taxFreeHint')}</p>
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-1">
        {assets.map((asset) => (
          <li key={asset.id}>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={!!taxFree[asset.id]}
                onChange={(e) => onToggle(asset.id, e.target.checked)}
                className="size-4 accent-primary shrink-0"
                aria-label={t('retirement.projection.taxFreeFor', { name: asset.name })}
              />
              <span className="min-w-0 flex-1 truncate">{asset.name}</span>
              {asset.costBasis === undefined && <span className="text-[10px] text-muted-foreground shrink-0">{t('retirement.projection.noBasis')}</span>}
            </label>
          </li>
        ))}
      </ul>
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
      id: newId(),
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
  incomeIndexed,
  onChange,
}: {
  whatIfs: WhatIf[]
  assets: ProjectionAsset[]
  horizon: number
  thisYear: number
  incomeIndexed: boolean
  onChange: (next: WhatIf[]) => void
}) {
  const { t } = useTranslation()
  const uid = useId()
  const [kind, setKind] = useState<Kind>('expense')
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [fromYear, setFromYear] = useState('0')
  const [toYear, setToYear] = useState('')
  const [assetId, setAssetId] = useState('')
  const [fees, setFees] = useState('0')
  const [inflates, setInflates] = useState(true)
  const sellable = assets.filter((a) => a.value > 0)

  const valid =
    kind === 'sell' ? Boolean(assetId) : Boolean(amount) && !Number.isNaN(parseFloat(amount))

  const add = () => {
    const id = newId()
    const from = Math.max(0, parseInt(fromYear || '0', 10) || 0)
    let item: WhatIf
    if (kind === 'sell') {
      const asset = sellable.find((a) => a.id === assetId)
      item = { id, kind, label: label.trim() || t('retirement.projection.sellLabel', { name: asset?.name ?? '' }), assetId, year: from, feesPercent: parseFloat(fees) || 0 }
    } else if (kind === 'spend') {
      item = { id, kind, label: label.trim() || t('retirement.projection.kind_spend'), monthly: Math.abs(parseFloat(amount)), fromYear: from, inflates }
    } else if (kind === 'oneoff') {
      item = { id, kind, label: label.trim() || t('retirement.projection.oneoffLabel'), amount: parseFloat(amount), year: from }
    } else {
      item = { id, kind, label: label.trim() || t(`retirement.projection.kind_${kind}`), monthly: Math.abs(parseFloat(amount)), fromYear: from, toYear: toYear ? parseInt(toYear, 10) : undefined, inflates }
    }
    onChange([...whatIfs, item])
    setLabel('')
    setAmount('')
  }

  const describe = (w: WhatIf) => describeWhatIf(t as unknown as Parameters<typeof describeWhatIf>[0], w, thisYear)

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
          <Label htmlFor={`${uid}-kind`} className="text-xs">{t('retirement.projection.whatKind')}</Label>
          <select id={`${uid}-kind`} className={cn('w-full border border-border rounded-md px-2 text-sm bg-card', field)} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
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
              <Label htmlFor={`${uid}-asset`} className="text-xs">{t('retirement.projection.asset')}</Label>
              <select id={`${uid}-asset`} className={cn('w-full border border-border rounded-md px-2 text-sm bg-card', field)} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">{t('retirement.projection.chooseAsset')}</option>
                {sellable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-fees`} className="text-xs">{t('retirement.projection.fees')}</Label>
              <Input id={`${uid}-fees`} type="number" min="0" max="100" step="any" value={fees} onChange={(e) => setFees(e.target.value)} className={field} />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-label`} className="text-xs">{t('retirement.projection.label')}</Label>
              <Input id={`${uid}-label`} value={label} onChange={(e) => setLabel(e.target.value)} className={field} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-amount`} className="text-xs">{kind === 'oneoff' ? t('retirement.projection.amountSigned') : t('retirement.projection.amountMonthly')}</Label>
              <Input id={`${uid}-amount`} type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
            </div>
          </>
        )}
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-from`} className="text-xs">{kind === 'expense' || kind === 'income' || kind === 'spend' ? t('retirement.projection.fromYear') : t('retirement.projection.inYear')}</Label>
          <Input id={`${uid}-from`} type="number" min="0" max={horizon} value={fromYear} onChange={(e) => setFromYear(e.target.value)} className={field} />
        </div>
        {(kind === 'expense' || kind === 'income') && (
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-to`} className="text-xs">{t('retirement.projection.toYear')}</Label>
            <Input id={`${uid}-to`} type="number" min="0" max={horizon} value={toYear} onChange={(e) => setToYear(e.target.value)} className={field} placeholder="∞" />
          </div>
        )}
        <Button type="button" size="sm" onClick={add} disabled={!valid} className="h-8">
          <Plus size={14} /> {t('retirement.projection.add')}
        </Button>
      </div>
      {(kind === 'expense' || kind === 'income' || kind === 'spend') && (
        <label className={cn('flex items-center gap-2 text-xs mt-3', kind === 'income' && !incomeIndexed ? 'text-muted-foreground/60 cursor-not-allowed' : 'text-muted-foreground cursor-pointer')}>
          <input
            type="checkbox"
            checked={inflates && !(kind === 'income' && !incomeIndexed)}
            disabled={kind === 'income' && !incomeIndexed}
            onChange={(e) => setInflates(e.target.checked)}
            className="size-4 accent-primary"
          />
          {t('retirement.projection.risesWithInflation')}
        </label>
      )}
      <p className="text-[11px] text-muted-foreground mt-2">{t('retirement.projection.yearsHint')}</p>
    </div>
  )
}
