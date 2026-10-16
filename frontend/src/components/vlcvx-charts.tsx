import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { compact, compactUsd, usd } from '@/lib/vlcvx'
import { cn } from '@/lib/utils'
import type { VlcvxBreakdown, VlcvxRound } from '@/types'

const tooltipStyle: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }
const axisTick = { fontSize: 10, fill: 'var(--muted-foreground)' }
const PALETTE = ['#6366F1', '#10B981', '#F59E0B', '#F43F5E', '#06B6D4', '#8B5CF6', '#94A3B8']

const RANGES = [13, 26, 52, 0] as const
type Range = (typeof RANGES)[number]

const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) : '')
const fullDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

export function RangePicker({ value, onChange }: { value: Range; onChange: (v: Range) => void }) {
  const { t } = useTranslation()
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={cn('px-2.5 py-1', value === r ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}
        >
          {r === 0 ? t('vlcvx.rangeAll') : t('vlcvx.rangeRounds', { count: r })}
        </button>
      ))}
    </div>
  )
}

function Panel({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

/** The history of what the protocol's rounds paid: per vlCVX, in total, in votes, and added up. */
export function PayoutCharts({ rounds }: { rounds: VlcvxRound[] }) {
  const { t } = useTranslation()
  const [range, setRange] = useState<Range>(52)
  const data = useMemo(() => {
    const shown = range === 0 ? rounds : rounds.slice(-range)
    const running = shown.reduce<number[]>((acc, r) => [...acc, (acc.at(-1) ?? 0) + (r.dollar_per_vl ?? 0) * 1000], [])
    return shown.map((r, i) => ({
      round: r.round,
      date: shortDate(r.ends_at),
      full: fullDate(r.ends_at),
      perVl: r.dollar_per_vl ?? 0,
      per1000: (r.dollar_per_vl ?? 0) * 1000,
      total: r.total_amount_dollars ?? 0,
      votes: r.scores_total ?? 0,
      cumulative: running[i],
    }))
  }, [rounds, range])
  const labelFormatter = (_: unknown, payload: readonly { payload?: { round: number; full: string } }[]) => {
    const p = payload?.[0]?.payload
    return p ? `${t('vlcvx.round')} ${p.round} · ${p.full}` : ''
  }
  const picker = <RangePicker value={range} onChange={setRange} />
  return (
    <div className="space-y-4">
      <Panel title={t('vlcvx.chartPayout')} hint={t('vlcvx.chartPayoutHint')} action={picker}>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={axisTick} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis yAxisId="l" tickFormatter={(v) => usd(Number(v), 3)} tick={axisTick} axisLine={false} tickLine={false} width={58} />
              <YAxis yAxisId="r" orientation="right" tickFormatter={(v) => compactUsd(Number(v))} tick={axisTick} axisLine={false} tickLine={false} width={52} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={labelFormatter} formatter={(v, name) => (name === t('vlcvx.perVl') ? usd(Number(v), 4) : usd(Number(v)))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="r" dataKey="total" name={t('vlcvx.totalBribes')} fill="#6366F1" fillOpacity={0.25} isAnimationActive={false} />
              <Line yAxisId="l" type="monotone" dataKey="perVl" name={t('vlcvx.perVl')} stroke="#10B981" strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title={t('vlcvx.chartCumulative')} hint={t('vlcvx.chartCumulativeHint')}>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={axisTick} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v) => usd(Number(v))} tick={axisTick} axisLine={false} tickLine={false} width={52} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={labelFormatter} formatter={(v) => usd(Number(v), 2)} />
                <Area type="monotone" dataKey="cumulative" name={t('vlcvx.cumulativePer1000')} stroke="#F59E0B" fill="#F59E0B" fillOpacity={0.2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title={t('vlcvx.chartVotes')} hint={t('vlcvx.chartVotesHint')}>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={axisTick} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v) => compact(Number(v))} tick={axisTick} axisLine={false} tickLine={false} width={44} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={labelFormatter} formatter={(v) => `${compact(Number(v))} vlCVX`} />
                <Area type="monotone" dataKey="votes" name={t('vlcvx.votes')} stroke="#06B6D4" fill="#06B6D4" fillOpacity={0.2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
    </div>
  )
}

/** What the bribes were paid in, round by round. */
export function TokenChart({ breakdown }: { breakdown: VlcvxBreakdown }) {
  const { t } = useTranslation()
  const [range, setRange] = useState<Range>(26)
  const top = useMemo(() => breakdown.tokens.slice(0, 6).map((x) => x.token), [breakdown])
  const data = useMemo(() => {
    const rows = breakdown.by_round.filter((r) => r.total_dollars > 0)
    const shown = range === 0 ? rows : rows.slice(-range)
    return shown.map((r) => {
      const row: Record<string, number | string> = { round: r.round, date: shortDate(r.ends_at), full: fullDate(r.ends_at) }
      let other = 0
      for (const [token, dollars] of Object.entries(r.tokens)) {
        if (top.includes(token)) row[token] = dollars
        else other += dollars
      }
      row.Other = other
      return row
    })
  }, [breakdown, range, top])
  const keys = [...top, 'Other']
  return (
    <Panel title={t('vlcvx.chartTokens')} hint={t('vlcvx.chartTokensHint')} action={<RangePicker value={range} onChange={setRange} />}>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={axisTick} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis tickFormatter={(v) => compactUsd(Number(v))} tick={axisTick} axisLine={false} tickLine={false} width={52} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(_, payload) => {
                const p = payload?.[0]?.payload as { round: number; full: string } | undefined
                return p ? `${t('vlcvx.round')} ${p.round} · ${p.full}` : ''
              }}
              formatter={(v) => usd(Number(v))}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {keys.map((key, i) => (
              <Bar key={key} dataKey={key} stackId="t" fill={PALETTE[i % PALETTE.length]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  )
}

export { Panel }
