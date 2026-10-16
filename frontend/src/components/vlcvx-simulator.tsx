import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Panel } from '@/components/vlcvx-charts'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PERIODS_PER_YEAR, alignPeriods, backtest, pct, project, usd } from '@/lib/vlcvx'
import type { VlcvxProtocolSummary, VlcvxRound } from '@/types'

const KEY = 'vlcvx:simulator'
const tooltipStyle: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }
const axisTick = { fontSize: 10, fill: 'var(--muted-foreground)' }

interface Settings {
  price: string
  protocols: string[] | null
  lookback: number
  horizon: number
}
const DEFAULTS: Settings = { price: '', protocols: null, lookback: 26, horizon: 52 }

function load(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

/** What holding vlCVX would pay: replayed over past rounds, and projected by drawing from them at random. */
export function VlcvxSimulator({ protocols, byProtocol, amount }: { protocols: VlcvxProtocolSummary[]; byProtocol: Record<string, VlcvxRound[]>; amount: number }) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<Settings>(load)
  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {
      // Storage blocked: the settings just do not persist.
    }
  }, [settings])
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value }))

  // Prisma stopped paying in 2024; count only protocols that are still live unless the person picks it.
  const available = useMemo(() => protocols.filter((p) => p.rounds > 0), [protocols])
  const included = useMemo(
    () => settings.protocols ?? available.filter((p) => p.protocol !== 'cvx-prisma').map((p) => p.protocol),
    [settings.protocols, available],
  )
  const price = parseFloat(settings.price) > 0 ? parseFloat(settings.price) : null

  const periods = useMemo(() => alignPeriods(byProtocol, included), [byProtocol, included])
  const projection = useMemo(() => project(periods, { lookback: settings.lookback, horizon: settings.horizon, amount, price }), [periods, settings.lookback, settings.horizon, amount, price])
  const windows = [4, 13, 26, 52, periods.length].filter((n, i, all) => n > 0 && all.indexOf(n) === i && n <= periods.length)

  const toggle = (protocol: string) => set('protocols', included.includes(protocol) ? included.filter((p) => p !== protocol) : [...included, protocol])
  const fan = (projection?.fan ?? []).map((f) => ({ ...f, band: [f.p10, f.p90] }))

  return (
    <div className="space-y-4">
      <Panel title={t('vlcvx.simTitle')} hint={t('vlcvx.simHint')}>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="vl-price" className="text-xs">{t('vlcvx.simPrice')}</Label>
            <Input id="vl-price" type="number" min="0" step="any" className="h-8" value={settings.price} placeholder={t('vlcvx.simPricePlaceholder')} onChange={(e) => set('price', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vl-lookback" className="text-xs">{t('vlcvx.simLookback')}</Label>
            <select id="vl-lookback" className="w-full border border-border rounded-md px-2 h-8 text-sm bg-card" value={settings.lookback} onChange={(e) => set('lookback', Number(e.target.value))}>
              {[13, 26, 52, 104].map((n) => (
                <option key={n} value={n}>{t('vlcvx.simLastRounds', { count: n })}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vl-horizon" className="text-xs">{t('vlcvx.simHorizon')}</Label>
            <select id="vl-horizon" className="w-full border border-border rounded-md px-2 h-8 text-sm bg-card" value={settings.horizon} onChange={(e) => set('horizon', Number(e.target.value))}>
              {[13, 26, 52, 104].map((n) => (
                <option key={n} value={n}>{t('vlcvx.simRoundsAhead', { count: n })}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <span className="text-xs font-medium">{t('vlcvx.simProtocols')}</span>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {available.map((p) => (
                <label key={p.protocol} className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input type="checkbox" className="size-3.5 accent-primary" checked={included.includes(p.protocol)} onChange={() => toggle(p.protocol)} aria-label={p.label} />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {!projection ? (
        <p className="text-sm text-muted-foreground text-center py-6">{t('vlcvx.simNoData')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label={t('vlcvx.simPerRound')} value={usd(projection.expectedPerPeriod)} hint={t('vlcvx.simPerRoundHint', { count: projection.sample.length })} />
            <Stat label={t('vlcvx.simPerYear')} value={usd(projection.perYear.p50)} hint={t('vlcvx.simRange', { low: usd(projection.perYear.p10), high: usd(projection.perYear.p90) })} />
            <Stat label={t('vlcvx.simTotal', { count: settings.horizon })} value={usd(projection.total.p50)} hint={t('vlcvx.simRange', { low: usd(projection.total.p10), high: usd(projection.total.p90) })} />
            <Stat
              label={t('vlcvx.simApr')}
              value={projection.apr ? pct(projection.apr.p50) : '–'}
              hint={projection.apr ? t('vlcvx.simRange', { low: pct(projection.apr.p10), high: pct(projection.apr.p90) }) : t('vlcvx.simAprNeedsPrice')}
            />
          </div>

          <Panel title={t('vlcvx.simFanTitle')} hint={t('vlcvx.simFanHint')}>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={fan} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="period" tick={axisTick} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tickFormatter={(v) => usd(Number(v))} tick={axisTick} axisLine={false} tickLine={false} width={64} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => t('vlcvx.simAfterRounds', { count: Number(v) })} formatter={(v) => (Array.isArray(v) ? `${usd(Number(v[0]))} – ${usd(Number(v[1]))}` : usd(Number(v)))} />
                  <Area type="monotone" dataKey="band" name={t('vlcvx.simBand')} stroke="none" fill="#6366F1" fillOpacity={0.2} isAnimationActive={false} />
                  <Line type="monotone" dataKey="p50" name={t('vlcvx.simMiddle')} stroke="#6366F1" strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </>
      )}

      <Panel title={t('vlcvx.backtestTitle', { amount: amount.toLocaleString('en-US') })} hint={t('vlcvx.backtestHint')}>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs tabular-nums">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">{t('vlcvx.backtestHeld')}</th>
                <th className="text-right font-medium px-3 py-2">{t('vlcvx.backtestPaid')}</th>
                <th className="text-right font-medium px-3 py-2">{t('vlcvx.backtestPerRound')}</th>
                <th className="text-right font-medium px-3 py-2">{t('vlcvx.backtestPerYear')}</th>
                <th className="text-right font-medium px-3 py-2">{t('vlcvx.simApr')}</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((count) => {
                const b = backtest(periods, count, amount, price)
                return (
                  <tr key={count} className="border-t border-border">
                    <td className="px-3 py-1.5">{count === periods.length && count !== 4 && count !== 13 && count !== 26 && count !== 52 ? t('vlcvx.backtestAll', { count }) : t('vlcvx.backtestRounds', { count })}</td>
                    <td className="text-right px-3 py-1.5">{usd(b.dollars)}</td>
                    <td className="text-right px-3 py-1.5">{usd(b.perPeriod)}</td>
                    <td className="text-right px-3 py-1.5">{usd(b.perYear)}</td>
                    <td className="text-right px-3 py-1.5">{b.apr != null ? pct(b.apr) : '–'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">{t('vlcvx.simDisclaimer', { perYear: PERIODS_PER_YEAR })}</p>
      </Panel>

    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums mt-0.5">{value}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>
    </div>
  )
}
