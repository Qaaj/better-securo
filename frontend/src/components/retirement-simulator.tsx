import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { buildProjectionInputs, read, write, DEFAULT_PLAN, PLAN_KEY } from '@/lib/retirement-plan'
import {
  DEFAULT_SIM,
  RISK_CLASSES,
  BUFFER_YEARS,
  SWEEP_CRASH,
  SWEEP_SPEND,
  defaultRiskClass,
  simulate,
  bufferSweep,
  sweep,
  type BufferCell,
  type RiskClass,
  type SimParams,
  type SweepCell,
} from '@/lib/retirement-simulation'
import { formatCurrency } from '@/lib/format'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Asset, RecurringTransaction } from '@/types'

const SIM_KEY = 'retirement:simulation'
const SWEEP_RUNS = 300

const tooltipStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
}

function formatCompact(value: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function toneFor(rate: number) {
  return rate >= 0.9 ? 'positive' : rate >= 0.7 ? 'warn' : 'negative'
}

/** A background that runs green to red with the success rate. */
function cellColor(rate: number) {
  const hue = Math.round(rate * 120)
  return `hsl(${hue} 65% 45% / 0.35)`
}

/** Runs the saved retirement plan through many random futures. */
export function RetirementSimulator({
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
  const [params, setParamsState] = useState<SimParams>(() => read(SIM_KEY, DEFAULT_SIM))
  const setParams = (next: SimParams) => {
    setParamsState(next)
    write(SIM_KEY, next)
  }
  const set = <K extends keyof SimParams>(key: K, value: SimParams[K]) => setParams({ ...params, [key]: value })

  // The plan made on the Projection tab, with its what-ifs, is what gets simulated.
  const plan = useMemo(() => read(PLAN_KEY, DEFAULT_PLAN), [])
  const { projectionAssets, base } = useMemo(
    () => buildProjectionInputs(plan, items, assets, currency, excluded),
    [plan, items, assets, currency, excluded],
  )
  const input = useMemo(() => ({ ...base, whatIfs: plan.whatIfs }), [base, plan.whatIfs])
  const types = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.type])), [assets])
  const horizon = plan.assumptions.horizonYears
  const thisYear = new Date().getFullYear()

  const [result, setResult] = useState<ReturnType<typeof simulate> | null>(null)
  // The sweep result belongs to the exact inputs it was run for; a change makes it stale until the next one lands.
  const [swept, setSwept] = useState<{ input: unknown; params: SimParams; types: unknown; cells: SweepCell[] } | null>(null)
  const cells = swept && swept.input === input && swept.params === params && swept.types === types ? swept.cells : null
  const [buffered, setBuffered] = useState<{ input: unknown; params: SimParams; types: unknown; cells: BufferCell[] } | null>(null)
  const bufferCells = buffered && buffered.input === input && buffered.params === params && buffered.types === types ? buffered.cells : null

  useEffect(() => {
    const timer = setTimeout(() => setResult(simulate(input, params, types)), 200)
    return () => clearTimeout(timer)
  }, [input, params, types])

  useEffect(() => {
    const signal = { cancelled: false }
    const timer = setTimeout(() => {
      sweep(input, params, types, SWEEP_RUNS, signal).then((done) => {
        if (!signal.cancelled) setSwept({ input, params, types, cells: done })
      })
    }, 400)
    return () => {
      signal.cancelled = true
      clearTimeout(timer)
    }
  }, [input, params, types])

  useEffect(() => {
    const signal = { cancelled: false }
    const timer = setTimeout(() => {
      bufferSweep(input, params, types, SWEEP_RUNS, signal).then((done) => {
        if (!signal.cancelled) setBuffered({ input, params, types, cells: done })
      })
    }, 600)
    return () => {
      signal.cancelled = true
      clearTimeout(timer)
    }
  }, [input, params, types])

  const money = (v: number) => mask(formatCurrency(v, currency, locale))
  const axis = (v: number) => (privacyMode ? '' : v === 0 ? '0' : formatCompact(v, currency, locale))
  const percent = (v: number) => `${Math.round(v * 100)}%`

  const view = result ? (params.todaysMoney ? result.real : result.nominal) : null
  const bandData = (view?.bands ?? []).map((b) => ({
    label: String(thisYear + b.year),
    wide: [Math.max(0, Math.round(b.p10)), Math.round(b.p90)],
    mid: [Math.max(0, Math.round(b.p25)), Math.round(b.p75)],
    median: Math.round(b.p50),
  }))
  const depletedData = (result?.depletedBy ?? []).map((share, year) => ({ label: String(thisYear + year), share: Math.round(share * 1000) / 10 }))

  const risky = projectionAssets.filter((a) => a.value > 0)
  const classOf = (id: string): RiskClass => params.classes[id] ?? defaultRiskClass(types[id] ?? '')

  const rate = result?.successRate ?? null
  const tone = rate === null ? 'text-foreground' : toneFor(rate) === 'positive' ? 'text-emerald-600' : toneFor(rate) === 'warn' ? 'text-amber-600' : 'text-rose-600'

  // The highest tested spending level that still lasts 90% of the time, at the chosen crash chance.
  const resilientSpend = useMemo(() => {
    if (!cells) return null
    const row = cells.filter((c) => c.crash === closestCrash(params.crashChancePercent))
    const ok = row.filter((c) => c.successRate >= 0.9).map((c) => c.spend)
    return ok.length ? Math.max(...ok) : 0
  }, [cells, params.crashChancePercent])

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-border">
          <p className="text-sm font-semibold text-foreground">{t('retirement.simulate.title')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('retirement.simulate.subtitle', { years: horizon, runs: params.runs })}</p>
        </div>

        <div className="p-4 sm:p-5 space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('retirement.simulate.successRate')}</p>
              <p className={`text-2xl font-semibold mt-1 ${tone}`}>{rate === null ? '…' : percent(rate)}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{t('retirement.simulate.successHint', { years: horizon })}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('retirement.simulate.typicalEnd')}</p>
              <p className="text-lg font-semibold mt-1">{view ? money(view.medianEnd) : '…'}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{t('retirement.simulate.typicalEndHint')}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('retirement.simulate.badEnd')}</p>
              <p className="text-lg font-semibold mt-1">{view ? money(view.worstCaseEnd) : '…'}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{t('retirement.simulate.badEndHint')}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('retirement.simulate.runsOut')}</p>
              <p className="text-lg font-semibold mt-1">
                {result == null ? '…' : result.medianRunOutYear === null ? t('retirement.simulate.never') : String(thisYear + result.medianRunOutYear)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">{t('retirement.simulate.runsOutHint')}</p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-xs font-medium text-muted-foreground">{t('retirement.simulate.fanTitle')}</p>
              <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
                {([true, false] as const).map((today) => (
                  <button
                    key={String(today)}
                    type="button"
                    onClick={() => set('todaysMoney', today)}
                    className={`px-2.5 py-1 ${params.todaysMoney === today ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}
                  >
                    {today ? t('retirement.simulate.todaysMoney') : t('retirement.simulate.futureMoney')}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={bandData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tickFormatter={axis} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} width={64} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v) => (privacyMode ? MASK : Array.isArray(v) ? `${formatCurrency(Number(v[0]), currency, locale)} – ${formatCurrency(Number(v[1]), currency, locale)}` : formatCurrency(Number(v), currency, locale))}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="wide" name={t('retirement.simulate.band8')} stroke="none" fill="#6366F1" fillOpacity={0.15} isAnimationActive={false} />
                  <Area type="monotone" dataKey="mid" name={t('retirement.simulate.band5')} stroke="none" fill="#6366F1" fillOpacity={0.3} isAnimationActive={false} />
                  <Line type="monotone" dataKey="median" name={t('retirement.simulate.median')} stroke="#6366F1" dot={false} strokeWidth={2} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">{params.todaysMoney ? t('retirement.simulate.fanHintToday') : t('retirement.simulate.fanHint')}</p>
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">{t('retirement.simulate.depletedTitle')}</p>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={depletedData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tickFormatter={(v) => `${v}%`} domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
                  <Area type="monotone" dataKey="share" name={t('retirement.simulate.depletedShare')} stroke="#F43F5E" fill="#F43F5E" fillOpacity={0.2} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5">
        <p className="text-sm font-semibold text-foreground">{t('retirement.simulate.sweepTitle')}</p>
        <p className="text-xs text-muted-foreground mt-0.5 mb-3">{t('retirement.simulate.sweepSubtitle')}</p>
        {!cells || cells.length < SWEEP_SPEND.length * SWEEP_CRASH.length ? (
          <p className="text-xs text-muted-foreground">{t('retirement.simulate.sweeping', { done: cells?.length ?? 0, total: SWEEP_SPEND.length * SWEEP_CRASH.length })}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="text-xs border-separate border-spacing-1">
                <thead>
                  <tr>
                    <th className="text-left font-medium text-muted-foreground pr-2">{t('retirement.simulate.crashRow')}</th>
                    {SWEEP_SPEND.map((s) => (
                      <th key={s} className="font-medium text-muted-foreground px-2">{Math.round(s * 100)}%</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {SWEEP_CRASH.map((crash) => (
                    <tr key={crash}>
                      <th className="text-left font-medium text-muted-foreground pr-2">{t('retirement.simulate.crashChance', { percent: crash })}</th>
                      {SWEEP_SPEND.map((spend) => {
                        const cell = cells.find((c) => c.crash === crash && c.spend === spend)
                        return (
                          <td
                            key={spend}
                            className="rounded text-center px-2 py-1.5 tabular-nums"
                            style={{ background: cell ? cellColor(cell.successRate) : undefined }}
                            title={t('retirement.simulate.cellTitle', { spend: Math.round(spend * 100), crash })}
                          >
                            {cell ? percent(cell.successRate) : ''}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-foreground mt-3">
              {resilientSpend === null
                ? ''
                : resilientSpend === 0
                  ? t('retirement.simulate.resilientNone', { crash: closestCrash(params.crashChancePercent) })
                  : t('retirement.simulate.resilient', { spend: Math.round(resilientSpend * 100), crash: closestCrash(params.crashChancePercent) })}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">{t('retirement.simulate.sweepHint', { runs: SWEEP_RUNS })}</p>
          </>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5">
        <p className="text-sm font-semibold text-foreground">{t('retirement.simulate.bufferTitle')}</p>
        <p className="text-xs text-muted-foreground mt-0.5 mb-3">{t('retirement.simulate.bufferSubtitle')}</p>
        {!bufferCells || bufferCells.length < BUFFER_YEARS.length ? (
          <p className="text-xs text-muted-foreground">{t('retirement.simulate.sweeping', { done: bufferCells?.length ?? 0, total: BUFFER_YEARS.length })}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-xs border-separate border-spacing-1">
              <thead>
                <tr>
                  <th className="text-left font-medium text-muted-foreground pr-3">{t('retirement.simulate.bufferRow')}</th>
                  {bufferCells.map((c) => (
                    <th key={c.years} className="font-medium text-muted-foreground px-2">{c.years === 0 ? t('retirement.simulate.noBuffer') : t('retirement.simulate.bufferYearsCell', { years: c.years })}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th className="text-left font-medium text-muted-foreground pr-3">{t('retirement.simulate.successRate')}</th>
                  {bufferCells.map((c) => (
                    <td key={c.years} className="rounded text-center px-2 py-1.5 tabular-nums" style={{ background: cellColor(c.successRate) }}>{percent(c.successRate)}</td>
                  ))}
                </tr>
                <tr>
                  <th className="text-left font-medium text-muted-foreground pr-3">{t('retirement.simulate.bufferTypical')}</th>
                  {bufferCells.map((c) => (
                    <td key={c.years} className="text-center px-2 py-1.5 tabular-nums">{money(c.medianEnd)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground mt-2">{t('retirement.simulate.bufferHint', { runs: SWEEP_RUNS })}</p>
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">{t('retirement.simulate.paramsTitle')}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setParams({ ...DEFAULT_SIM, classes: params.classes })}>
            {t('retirement.simulate.reset')}
          </Button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label={t('retirement.simulate.runs')} value={params.runs} min={200} max={20000} step={500} onChange={(v) => set('runs', v)} />
          <Field label={t('retirement.simulate.seed')} value={params.seed} min={0} step={1} onChange={(v) => set('seed', v)} />
          <Field label={t('retirement.simulate.volatility')} hint={t('retirement.simulate.volatilityHint')} value={params.volatilityScale} min={0} max={3} step={0.25} onChange={(v) => set('volatilityScale', v)} />
          <Field label={t('retirement.simulate.crashChanceLabel')} hint={t('retirement.simulate.crashChanceHint')} value={params.crashChancePercent} min={0} max={50} step={1} onChange={(v) => set('crashChancePercent', v)} />
          <Field label={t('retirement.simulate.crashMin')} value={params.crashMinPercent} min={5} max={90} step={5} onChange={(v) => setParams({ ...params, crashMinPercent: v, crashMaxPercent: Math.max(v, params.crashMaxPercent) })} />
          <Field label={t('retirement.simulate.crashMax')} value={params.crashMaxPercent} min={5} max={90} step={5} onChange={(v) => setParams({ ...params, crashMaxPercent: v, crashMinPercent: Math.min(v, params.crashMinPercent) })} />
          <Field label={t('retirement.simulate.slumpYears')} hint={t('retirement.simulate.slumpYearsHint')} value={params.slumpYears} min={0} max={10} step={1} onChange={(v) => set('slumpYears', v)} />
          <Field label={t('retirement.simulate.slumpCut')} hint={t('retirement.simulate.slumpCutHint')} value={params.slumpCutPercent} min={0} max={100} step={10} onChange={(v) => set('slumpCutPercent', v)} />
          <Field label={t('retirement.simulate.inflationSpread')} hint={t('retirement.simulate.inflationSpreadHint')} value={params.inflationSpread} min={0} max={6} step={0.5} onChange={(v) => set('inflationSpread', v)} />
          <Field label={t('retirement.simulate.spikeChance')} hint={t('retirement.simulate.spikeChanceHint')} value={params.spikeChancePercent} min={0} max={30} step={1} onChange={(v) => set('spikeChancePercent', v)} />
          <Field label={t('retirement.simulate.spikeExtra')} hint={t('retirement.simulate.spikeExtraHint')} value={params.spikeExtraPoints} min={0} max={20} step={1} onChange={(v) => set('spikeExtraPoints', v)} />
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">{t('retirement.simulate.classesTitle')}</p>
          <p className="text-[11px] text-muted-foreground mb-2">{t('retirement.simulate.classesHint')}</p>
          <div className="divide-y divide-border rounded-lg border border-border">
            {risky.map((asset) => (
              <div key={asset.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="truncate">
                  {asset.name}
                  <span className="text-xs text-muted-foreground"> · {money(asset.value)} · {asset.growthPercent ?? 0}%</span>
                </span>
                <select
                  className="border border-border rounded-md px-2 py-1 text-xs bg-card"
                  aria-label={t('retirement.simulate.classFor', { name: asset.name })}
                  value={classOf(asset.id)}
                  onChange={(e) => set('classes', { ...params.classes, [asset.id]: e.target.value as RiskClass })}
                >
                  {RISK_CLASSES.map((c) => (
                    <option key={c} value={c}>{t(`retirement.simulate.class_${c}`)}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('retirement.simulate.disclaimer')}</p>
      </div>
    </div>
  )
}

/** The sweep grid's crash chance nearest to what is set. */
function closestCrash(percent: number) {
  return SWEEP_CRASH.reduce((best, c) => (Math.abs(c - percent) < Math.abs(best - percent) ? c : best), SWEEP_CRASH[0])
}

function Field({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max?: number
  step: number
  onChange: (value: number) => void
}) {
  const id = `sim-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      <Input
        id={id}
        type="number"
        className="h-8"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(Math.min(max ?? Infinity, Math.max(min, n)))
        }}
      />
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  )
}
