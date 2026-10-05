import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { recurring as recurringApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Button } from '@/components/ui/button'
import type { RecurringTransaction } from '@/types'

const tooltipStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
}

/** What the charges linked to a recurring item say: how long it has run, what it cost and how its price moved. */
export function RecurringHistoryPanel({
  item,
  primaryCurrency,
  canWrite,
  onUseLatest,
  updating,
}: {
  item: RecurringTransaction
  primaryCurrency: string
  canWrite: boolean
  onUseLatest: (amount: number) => void
  updating: boolean
}) {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask, privacyMode, MASK } = usePrivacyMode()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['recurring-history', item.id],
    queryFn: () => recurringApi.history(item.id),
  })
  const day = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(dateLocale)
  const own = (v: number | string) => mask(formatCurrency(Number(v), item.currency, locale))
  const primary = (v: number | string) => mask(formatCurrency(Number(v), primaryCurrency, locale))
  const pct = (v: number) => `${v > 0 ? '+' : ''}${v}%`

  if (isLoading) {
    return (
      <div className="py-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={13} className="animate-spin" /> {t('recurring.history.loading')}
      </div>
    )
  }
  if (isError || !data) return <p className="py-3 text-xs text-rose-500">{t('common.error')}</p>
  if (data.count === 0) {
    return <p className="py-3 text-xs text-muted-foreground">{t('recurring.history.none')}</p>
  }

  const months = data.months_running ?? 0
  const running = months < 1 ? t('recurring.history.lessThanMonth') : t('recurring.history.months', { count: Math.round(months) })
  const tiles = [
    { label: t('recurring.history.running'), value: running, hint: t('recurring.history.since', { date: data.first_date ? day(data.first_date) : '–' }) },
    { label: t('recurring.history.charges'), value: String(data.count), hint: t('recurring.history.lastOn', { date: data.last_date ? day(data.last_date) : '–' }) },
    { label: t('recurring.history.last12'), value: primary(data.total_last_12_months), hint: t('recurring.history.total', { amount: primary(data.total_paid) }) },
    {
      label: t('recurring.history.price'),
      value: data.latest_amount != null ? own(data.latest_amount) : '–',
      hint:
        data.change_since_first_pct == null
          ? t('recurring.history.onlyOne')
          : data.amount_varies
            ? t('recurring.history.range', { min: own(data.min_amount ?? 0), max: own(data.max_amount ?? 0) })
            : data.change_since_first_pct === 0
              ? t('recurring.history.unchanged')
              : t('recurring.history.sinceFirst', { change: pct(data.change_since_first_pct), first: own(data.first_amount ?? 0) }),
    },
  ]
  const chart = data.charges.map((c) => ({ date: c.date, label: day(c.date), amount: Number(c.amount) }))
  const planned = data.latest_vs_planned_pct
  const suggestsUpdate = canWrite && planned != null && Math.abs(planned) >= 2 && data.latest_amount != null

  return (
    <div className="py-3 space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{tile.label}</p>
            <p className="text-sm font-semibold tabular-nums">{tile.value}</p>
            <p className="text-[11px] text-muted-foreground">{tile.hint}</p>
          </div>
        ))}
      </div>

      {data.overdue_days != null && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700">
          <AlertTriangle size={13} /> {t('recurring.history.overdue', { days: data.overdue_days })}
        </p>
      )}
      {suggestsUpdate && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {t('recurring.history.plannedDiffers', { latest: own(data.latest_amount!), planned: own(item.amount), change: pct(planned!) })}
          </span>
          <Button type="button" size="sm" variant="outline" className="h-7" disabled={updating} onClick={() => onUseLatest(Number(data.latest_amount))}>
            {t('recurring.history.useLatest')}
          </Button>
        </div>
      )}

      {data.price_changes.length > 0 && (
        <ul className="text-xs space-y-0.5">
          {data.price_changes.map((c) => (
            <li key={c.date} className="text-muted-foreground">
              <span className="text-foreground">{day(c.date)}</span> · {own(c.from_amount)} → {own(c.to_amount)}{' '}
              <span className={c.change_pct > 0 ? 'text-rose-500' : 'text-emerald-600'}>({pct(c.change_pct)})</span>
            </li>
          ))}
        </ul>
      )}

      {chart.length > 1 && (
        <div className="h-36">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis
                domain={['auto', 'auto']}
                tickFormatter={(v) => (privacyMode ? '' : String(Math.round(Number(v))))}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                axisLine={false}
                tickLine={false}
                width={44}
              />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => (privacyMode ? MASK : formatCurrency(Number(v), item.currency, locale))} />
              <Line type="stepAfter" dataKey="amount" name={t('recurring.history.price')} stroke="#6366F1" dot={{ r: 2 }} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
