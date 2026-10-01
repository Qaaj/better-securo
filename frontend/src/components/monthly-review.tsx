import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { reports as reportsApi } from '@/lib/api'
import { localDateString } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Button } from '@/components/ui/button'
import type { MonthlyReview, ReviewCategoryLine, ReviewInsight } from '@/types'

const TOP_CATEGORIES = 10

function monthIso(date: string): string {
  return `${date.slice(0, 7)}-01`
}

function shiftMonth(iso: string, months: number): string {
  const [y, m] = iso.split('-').map(Number)
  const index = y * 12 + (m - 1) + months
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`
}

function lastDay(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
}

/** How a month went, in plain words, against the user's own usual month. */
export function MonthlyReviewPanel() {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  const thisMonth = monthIso(localDateString())
  const [month, setMonth] = useState(thisMonth)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['monthly-review', month],
    queryFn: () => reportsApi.monthlyReview(month),
    placeholderData: (previous) => previous,
  })

  const [y, m] = month.split('-').map(Number)
  const label = new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('reports.review.title')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('reports.review.subtitle')}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="outline" size="icon" className="h-8 w-8" onClick={() => setMonth(shiftMonth(month, -1))} aria-label={t('reports.review.previous')}>
            <ChevronLeft size={16} />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium capitalize">{label}</span>
          <Button type="button" variant="outline" size="icon" className="h-8 w-8" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth} aria-label={t('reports.review.next')}>
            <ChevronRight size={16} />
          </Button>
        </div>
      </div>

      {isError && <p className="text-sm text-rose-500">{t('reports.loadError')}</p>}
      {!data && isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {data && <ReviewBody review={data} month={month} locale={locale} mask={mask} />}
    </div>
  )
}

function ReviewBody({ review, month, locale, mask }: { review: MonthlyReview; month: string; locale: string; mask: (value: string) => string }) {
  const { t } = useTranslation()
  // A review reads better in whole amounts than with cents.
  const money = (v: number) =>
    mask(new Intl.NumberFormat(locale, { style: 'currency', currency: review.currency, maximumFractionDigits: 0 }).format(Math.round(v)))
  const { this_month: now, usual } = review
  const empty = now.income === 0 && now.expenses === 0

  if (empty) {
    return <p className="bg-card rounded-xl border border-border px-5 py-8 text-sm text-muted-foreground text-center">{t('reports.review.empty')}</p>
  }

  return (
    <>
      <Headline review={review} money={money} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FigureTile label={t('reports.review.income')} value={money(now.income)} compare={usual ? pctChange(now.income, usual.income) : null} higherIsGood />
        <FigureTile label={t('reports.review.spent')} value={money(now.expenses)} compare={usual ? pctChange(now.expenses, usual.expenses) : null} higherIsGood={false} />
        <FigureTile label={t('reports.review.saved')} value={money(now.saved)} compare={null} tone={now.saved >= 0 ? 'positive' : 'negative'} hint={now.savings_rate != null ? t('reports.review.ofIncome', { pct: Math.round(now.savings_rate * 100) }) : undefined} />
      </div>

      <WorthALook insights={review.insights ?? []} month={month} money={money} />
      <WhereItWent review={review} month={month} money={money} />
      <WhatChanged review={review} money={money} locale={locale} />
      <FixedOrFlexible review={review} money={money} />

      {review.moved_count > 0 && (
        <p className="text-xs text-muted-foreground px-1">
          {t('reports.review.moved', { amount: money(review.moved_between_accounts), count: review.moved_count })}
        </p>
      )}

      <YearTable review={review} money={money} locale={locale} />
    </>
  )
}

/** The change as a share of the comparison, or null when there is nothing to compare to. */
function pctChange(value: number, base: number): number | null {
  if (!base) return null
  return Math.round(((value - base) / base) * 100)
}

function Headline({ review, money }: { review: MonthlyReview; money: (v: number) => string }) {
  const { t } = useTranslation()
  const { this_month: now, usual } = review
  const change = usual ? pctChange(now.expenses, usual.expenses) : null
  const sentences: string[] = [t('reports.review.headlineSpent', { amount: money(now.expenses) })]
  if (usual && change !== null) {
    sentences.push(
      Math.abs(change) < 3
        ? t('reports.review.vsUsualSame', { usual: money(usual.expenses) })
        : change > 0
          ? t('reports.review.vsUsualMore', { pct: change, usual: money(usual.expenses) })
          : t('reports.review.vsUsualLess', { pct: Math.abs(change), usual: money(usual.expenses) }),
    )
  } else {
    sentences.push(t('reports.review.noUsual'))
  }
  sentences.push(
    now.income > 0
      ? now.saved >= 0
        ? t('reports.review.headlineSaved', { saved: money(now.saved), earned: money(now.income) })
        : t('reports.review.headlineOver', { over: money(-now.saved), earned: money(now.income) })
      : t('reports.review.headlineNoIncome'),
  )
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm px-5 py-4">
      <p className="text-base leading-relaxed text-foreground">{sentences.join(' ')}</p>
      {review.usual_months > 0 && review.usual_months < 12 && (
        <p className="text-xs text-muted-foreground mt-1">{t('reports.review.usualBasis', { months: review.usual_months })}</p>
      )}
    </div>
  )
}

function FigureTile({
  label,
  value,
  compare,
  higherIsGood,
  tone,
  hint,
}: {
  label: string
  value: string
  compare: number | null
  higherIsGood?: boolean
  tone?: 'positive' | 'negative'
  hint?: string
}) {
  const { t } = useTranslation()
  const good = compare !== null && (compare > 0) === Boolean(higherIsGood)
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm px-4 sm:px-5 py-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('text-xl font-semibold mt-1', tone === 'positive' && 'text-emerald-600', tone === 'negative' && 'text-rose-500')}>{value}</p>
      {compare !== null && Math.abs(compare) >= 1 ? (
        <p className={cn('text-xs mt-1', good ? 'text-emerald-600' : 'text-rose-500')}>
          {compare > 0 ? '↑' : '↓'} {t('reports.review.vsUsual', { pct: Math.abs(compare) })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground mt-1">{hint ?? ' '}</p>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
      <p className="px-4 sm:px-5 py-3 border-b border-border text-sm font-semibold text-foreground">{title}</p>
      <div className="px-4 sm:px-5 py-3">{children}</div>
    </div>
  )
}

function WorthALook({ insights, month, money }: { insights: ReviewInsight[]; month: string; money: (v: number) => string }) {
  const { t } = useTranslation()
  if (insights.length === 0) return null
  const sentence = (i: ReviewInsight): string => {
    if (i.kind === 'duplicate') return t('reports.review.insightDuplicate', { description: i.description, count: i.count, amount: money(i.amount) })
    if (i.kind === 'unusual') {
      const times = i.previous ? Math.round((i.amount / i.previous) * 10) / 10 : 0
      return t('reports.review.insightUnusual', { description: i.description, amount: money(i.amount), times, usual: money(i.previous ?? 0) })
    }
    const pct = i.previous ? Math.round(((i.amount - i.previous) / i.previous) * 100) : 0
    return t(pct >= 0 ? 'reports.review.insightPriceUp' : 'reports.review.insightPriceDown', {
      description: i.description, previous: money(i.previous ?? 0), amount: money(i.amount), pct: Math.abs(pct),
    })
  }
  return (
    <Section title={t('reports.review.worthTitle')}>
      <ul className="space-y-2">
        {insights.map((i, n) => (
          <li key={`${i.kind}-${i.description}-${n}`} className="text-sm">
            <Link
              to={`/transactions?q=${encodeURIComponent(i.description.slice(0, 30))}&from=${month}&to=${lastDay(month)}`}
              className="hover:underline"
            >
              {sentence(i)}
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground mt-2">{t('reports.review.worthHint')}</p>
    </Section>
  )
}

function WhereItWent({ review, month, money }: { review: MonthlyReview; month: string; money: (v: number) => string }) {
  const { t } = useTranslation()
  const lines = review.categories.filter((c) => c.amount > 0)
  const top = lines.slice(0, TOP_CATEGORIES)
  const rest = lines.slice(TOP_CATEGORIES)
  const restAmount = rest.reduce((sum, c) => sum + c.amount, 0)
  const restUsual = rest.reduce((sum, c) => sum + c.usual, 0)
  const rows: ReviewCategoryLine[] = restAmount > 0
    ? [...top, { category_id: null, name: t('reports.review.otherCategories', { count: rest.length }), icon: null, color: null, amount: restAmount, usual: restUsual, delta: restAmount - restUsual, share: restAmount / (review.this_month.expenses || 1) }]
    : top
  const widest = Math.max(1, ...rows.map((r) => r.share))
  const showUncategorized = review.uncategorized_share >= 0.1

  return (
    <Section title={t('reports.review.whereTitle')}>
      {showUncategorized && (
        <p className="text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-lg px-3 py-2 mb-3">
          {t('reports.review.uncategorized', { pct: Math.round(review.uncategorized_share * 100), amount: money(review.uncategorized_expenses) })}{' '}
          <Link to="/categories?tab=automate" className="underline font-medium">{t('reports.review.categorizeIt')}</Link>
        </p>
      )}
      <ul className="space-y-2.5">
        {rows.map((row, i) => {
          const name = row.name ?? t('reports.review.notCategorized')
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{name}</span>
                <span className="shrink-0 tabular-nums">{money(row.amount)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${Math.max(2, (row.share / widest) * 100)}%`, background: row.color ?? 'var(--muted-foreground)' }} />
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {Math.round(row.share * 100)}% · {review.usual_months > 0 ? t('reports.review.usualAmount', { amount: money(row.usual) }) : ''}
                {review.usual_months > 0 && Math.abs(row.delta) >= 1 && (
                  <span className={cn('ml-1.5', row.delta > 0 ? 'text-rose-500' : 'text-emerald-600')}>{row.delta > 0 ? '↑' : '↓'} {money(Math.abs(row.delta))}</span>
                )}
              </p>
            </>
          )
          return (
            <li key={row.category_id ?? `${name}-${i}`}>
              {row.category_id ? (
                <Link to={`/transactions?category_id=${row.category_id}&from=${month}&to=${lastDay(month)}`} className="block hover:bg-muted/40 -mx-2 px-2 py-1 rounded-md">{body}</Link>
              ) : (
                <div className="-mx-2 px-2 py-1">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function WhatChanged({ review, money, locale }: { review: MonthlyReview; money: (v: number) => string; locale: string }) {
  const { t } = useTranslation()
  const nothing = !review.movers_up.length && !review.movers_down.length && !review.new_merchants.length && !review.large_transactions.length
  const mover = (c: ReviewCategoryLine, up: boolean) => (
    <li key={c.category_id ?? c.name} className="flex justify-between gap-3 text-sm">
      <span className="truncate">{c.name ?? t('reports.review.notCategorized')}</span>
      <span className={cn('shrink-0 tabular-nums', up ? 'text-rose-500' : 'text-emerald-600')}>{up ? '↑' : '↓'} {money(Math.abs(c.delta))}</span>
    </li>
  )
  const group = (title: string, items: React.ReactNode[]) =>
    items.length > 0 && (
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1.5">{title}</p>
        <ul className="space-y-1">{items}</ul>
      </div>
    )
  return (
    <Section title={t('reports.review.changedTitle')}>
      {nothing ? (
        <p className="text-sm text-muted-foreground">{t('reports.review.nothingStandsOut')}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          {group(t('reports.review.spendingMore'), review.movers_up.map((c) => mover(c, true)))}
          {group(t('reports.review.spendingLess'), review.movers_down.map((c) => mover(c, false)))}
          {group(
            t('reports.review.newMerchants'),
            review.new_merchants.map((x) => (
              <li key={x.name} className="flex justify-between gap-3 text-sm"><span className="truncate">{x.name}</span><span className="shrink-0 tabular-nums">{money(x.amount)}</span></li>
            )),
          )}
          {group(
            t('reports.review.biggest'),
            review.large_transactions.map((x) => (
              <li key={x.id} className="flex justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{x.description} <span className="text-xs text-muted-foreground">{new Date(x.date).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}</span></span>
                <span className="shrink-0 tabular-nums">{money(x.amount)}</span>
              </li>
            )),
          )}
        </div>
      )}
    </Section>
  )
}

function FixedOrFlexible({ review, money }: { review: MonthlyReview; money: (v: number) => string }) {
  const { t } = useTranslation()
  const total = review.recurring_expenses + review.other_expenses
  if (total <= 0) return null
  const fixedShare = Math.round((review.recurring_expenses / total) * 100)
  return (
    <Section title={t('reports.review.fixedTitle')}>
      <div className="h-3 rounded-full overflow-hidden bg-muted flex">
        <div className="bg-primary h-full" style={{ width: `${fixedShare}%` }} />
      </div>
      <div className="flex justify-between gap-3 text-sm mt-2">
        <span><span className="inline-block size-2 rounded-full bg-primary mr-1.5" />{t('reports.review.recurringBills')}: {money(review.recurring_expenses)} ({fixedShare}%)</span>
        <span className="text-muted-foreground">{t('reports.review.everythingElse')}: {money(review.other_expenses)}</span>
      </div>
      <p className="text-[11px] text-muted-foreground mt-1.5">{t('reports.review.fixedHint')}</p>
    </Section>
  )
}

function YearTable({ review, money, locale }: { review: MonthlyReview; money: (v: number) => string; locale: string }) {
  const { t } = useTranslation()
  const year = review.month.slice(0, 4)
  const totals = review.year.reduce((acc, r) => ({ income: acc.income + r.income, expenses: acc.expenses + r.expenses, saved: acc.saved + r.saved }), { income: 0, expenses: 0, saved: 0 })
  const cell = 'py-1.5 text-right tabular-nums'
  return (
    <Section title={t('reports.review.yearTitle', { year })}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left font-medium py-1.5">{t('reports.review.monthColumn')}</th>
              <th className="text-right font-medium py-1.5">{t('reports.review.income')}</th>
              <th className="text-right font-medium py-1.5">{t('reports.review.spent')}</th>
              <th className="text-right font-medium py-1.5">{t('reports.review.saved')}</th>
            </tr>
          </thead>
          <tbody>
            {review.year.map((r) => (
              <tr key={r.month} className="border-b border-border last:border-0">
                <td className="py-1.5 capitalize">{new Date(`${r.month}-01T12:00:00`).toLocaleDateString(locale, { month: 'long' })}</td>
                <td className={cell}>{money(r.income)}</td>
                <td className={cell}>{money(r.expenses)}</td>
                <td className={cn(cell, r.saved < 0 ? 'text-rose-500' : 'text-emerald-600')}>{money(r.saved)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium border-t border-border">
              <td className="py-1.5">{t('reports.review.total')}</td>
              <td className={cell}>{money(totals.income)}</td>
              <td className={cell}>{money(totals.expenses)}</td>
              <td className={cn(cell, totals.saved < 0 ? 'text-rose-500' : 'text-emerald-600')}>{money(totals.saved)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
  )
}

