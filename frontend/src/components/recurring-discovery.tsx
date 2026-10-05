import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Search, X } from 'lucide-react'
import { formatCurrency } from '@/lib/format'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DiscoveryMatch, DiscoverySeries, RecurringTransaction } from '@/types'

const CONFIDENCE_STYLE: Record<string, string> = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  medium: 'bg-amber-50 text-amber-700 border-amber-100',
  low: 'bg-muted text-muted-foreground border-border',
}

function useSeriesText() {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const day = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(dateLocale)
  const money = (amount: number | string, currency: string) => mask(formatCurrency(Number(amount), currency, locale))
  const frequency = (f: string | null) => (f ? t(`recurring.${f}`) : t('recurring.discover.irregular'))
  /** "12 charges · last 3 Oct 2026 · varies" */
  const describe = (s: DiscoverySeries) =>
    [
      t('recurring.discover.charges', { count: s.occurrences }),
      t('recurring.discover.lastSeen', { date: day(s.last_date) }),
      s.amount_varies ? t('recurring.discover.varies') : null,
    ]
      .filter(Boolean)
      .join(' · ')
  return { t, day, money, frequency, describe }
}

export function ConfidenceBadge({ level }: { level: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full border', CONFIDENCE_STYLE[level] ?? CONFIDENCE_STYLE.low)}>
      {t(`recurring.discover.confidence_${level}`)}
    </span>
  )
}

/** One inline row under a recurring item: the transactions most likely to be it, with one click to accept. */
export function MatchRow({
  match,
  colSpan,
  pending,
  onAccept,
  onSkip,
}: {
  match: DiscoveryMatch
  colSpan: number
  pending: boolean
  onAccept: () => void
  onSkip: () => void
}) {
  const { t, money, frequency, describe, day } = useSeriesText()
  const s = match.series
  return (
    <tr className="border-b border-border bg-primary/5">
      <td colSpan={colSpan} className="py-2.5 pl-4 sm:pl-5 pr-4 sm:pr-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Search size={13} className="text-primary shrink-0" />
          <div className="min-w-0 flex-1 text-xs">
            <p className="text-foreground">
              <span className="font-medium">{s.name}</span>
              <span className="text-muted-foreground"> · {money(s.typical_amount, s.currency)} · {frequency(s.frequency)}</span>
              <span className="ml-2 align-middle"><ConfidenceBadge level={match.confidence} /></span>
            </p>
            <p className="text-muted-foreground mt-0.5">
              {describe(s)} · {t('recurring.discover.since', { date: day(s.first_date) })}
              {' · '}
              {match.reasons.map((r) => t(`recurring.discover.reason_${r}`)).join(', ')}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button type="button" size="sm" className="h-7 gap-1" onClick={onAccept} disabled={pending}>
              {pending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t('recurring.discover.linkAll', { count: s.occurrences })}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1" onClick={onSkip} disabled={pending}>
              <X size={12} /> {t('recurring.discover.notThis')}
            </Button>
          </div>
        </div>
      </td>
    </tr>
  )
}

function SeriesLine({
  series,
  recurringItems,
  pendingKey,
  onCreate,
  onAssign,
  onDismiss,
  showConfidence = true,
}: {
  series: DiscoverySeries
  recurringItems: RecurringTransaction[]
  pendingKey: string | null
  onCreate: (s: DiscoverySeries) => void
  onAssign: (s: DiscoverySeries, recurringId: string) => void
  onDismiss: (s: DiscoverySeries) => void
  showConfidence?: boolean
}) {
  const { t, money, frequency, describe } = useSeriesText()
  const [target, setTarget] = useState('')
  const busy = pendingKey !== null
  const candidates = recurringItems.filter((r) => r.is_active && r.type === series.type)
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-5 py-2.5 border-b border-border last:border-0">
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm text-foreground truncate">
          <span className="font-medium">{series.name}</span>
          {showConfidence && <span className="ml-2 align-middle"><ConfidenceBadge level={series.confidence} /></span>}
          {series.lapsed && <span className="ml-2 text-[10px] text-muted-foreground border border-border rounded-full px-1.5 py-0.5 align-middle">{t('recurring.discover.ended')}</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {money(series.typical_amount, series.currency)} · {frequency(series.frequency)} · {describe(series)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
        {candidates.length > 0 && (
          <>
            <select
              className="border border-border rounded-md px-2 h-7 text-xs bg-card max-w-44"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label={t('recurring.discover.assignTo', { name: series.name })}
              disabled={busy}
            >
              <option value="">{t('recurring.discover.assignPlaceholder')}</option>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>{r.description}</option>
              ))}
            </select>
            <Button type="button" size="sm" variant="outline" className="h-7" disabled={!target || busy} onClick={() => onAssign(series, target)}>
              {t('recurring.discover.assign')}
            </Button>
          </>
        )}
        <Button type="button" size="sm" className="h-7" disabled={busy || !series.frequency} onClick={() => onCreate(series)}>
          {pendingKey === series.key ? <Loader2 size={12} className="animate-spin" /> : null}
          {t('recurring.discover.create')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => onDismiss(series)} aria-label={t('recurring.discover.dismissFor', { name: series.name })}>
          <X size={12} /> {t('recurring.discover.dismiss')}
        </Button>
      </div>
    </li>
  )
}

interface ListProps {
  recurringItems: RecurringTransaction[]
  pendingKey: string | null
  onCreate: (s: DiscoverySeries) => void
  onAssign: (s: DiscoverySeries, recurringId: string) => void
  onDismiss: (s: DiscoverySeries) => void
}

/** The strongest new patterns, to accept with one click. */
export function NewProposals({ series, ...rest }: { series: DiscoverySeries[] } & ListProps) {
  const { t } = useTranslation()
  return (
    <div className="bg-card rounded-xl border border-primary/30 shadow-sm mb-4 overflow-hidden">
      <div className="px-4 sm:px-5 py-3 border-b border-border">
        <p className="text-sm font-semibold text-foreground">{t('recurring.discover.proposalsTitle')}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{series.length > 0 ? t('recurring.discover.proposalsHint') : t('recurring.discover.proposalsNone')}</p>
      </div>
      {series.length > 0 && (
        <ul>
          {series.map((s) => (
            <SeriesLine key={s.key} series={s} {...rest} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** Repeating charges nothing is assigned to yet: assign, create or dismiss. */
export function UnassignedList({
  series,
  dismissed,
  onReset,
  resetting,
  ...rest
}: {
  series: DiscoverySeries[]
  dismissed: number
  onReset: () => void
  resetting: boolean
} & ListProps) {
  const { t } = useTranslation()
  const [showMore, setShowMore] = useState(false)
  const solid = series.filter((s) => !s.lapsed && s.confidence !== 'low')
  const more = series.filter((s) => s.lapsed || s.confidence === 'low')
  const visible = showMore ? [...solid, ...more] : solid
  if (series.length === 0 && dismissed === 0) return null
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm mt-4 overflow-hidden">
      <div className="px-4 sm:px-5 py-3 border-b border-border flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('recurring.discover.unassignedTitle')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('recurring.discover.unassignedHint')}</p>
        </div>
        <div className="flex items-center gap-2">
          {more.length > 0 && (
            <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setShowMore((v) => !v)}>
              {showMore ? t('recurring.discover.hideMore') : t('recurring.discover.showMore', { count: more.length })}
            </Button>
          )}
          {dismissed > 0 && (
            <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onReset} disabled={resetting}>
              {t('recurring.discover.restore', { count: dismissed })}
            </Button>
          )}
        </div>
      </div>
      {visible.length > 0 ? (
        <ul>
          {visible.map((s) => (
            <SeriesLine key={s.key} series={s} {...rest} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-6">{t('recurring.discover.unassignedNone')}</p>
      )}
    </div>
  )
}
