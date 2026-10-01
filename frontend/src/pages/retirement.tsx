import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { recurring as recurringApi } from '@/lib/api'
import { computeRetirement, type RetirementLine } from '@/lib/retirement'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { PageHeader } from '@/components/page-header'

const EXCLUDED_KEY = 'retirement:excluded-income'

function loadExcluded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXCLUDED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveExcluded(ids: Set<string>) {
  try {
    window.localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...ids]))
  } catch {
    // Private mode or blocked storage: the choice just does not persist.
  }
}

export default function RetirementPage() {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const currency = user?.preferences?.currency_display ?? 'USD'
  const [excluded, setExcluded] = useState<Set<string>>(loadExcluded)

  const { data: items, isLoading } = useQuery({
    queryKey: ['recurring'],
    queryFn: recurringApi.list,
  })

  const summary = useMemo(() => computeRetirement(items ?? [], currency, excluded), [items, currency, excluded])

  const toggle = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveExcluded(next)
      return next
    })
  }

  const money = (value: number) => mask(formatCurrency(value, currency, locale))
  const covered = summary.coverage != null ? Math.round(summary.coverage * 100) : null
  const shortfall = summary.surplusMonthly < 0

  return (
    <div>
      <PageHeader section={t('nav.groupAnalysis')} title={t('retirement.title')} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Tile label={t('retirement.tileIncome')} value={money(summary.incomeMonthly)} hint={t('retirement.perYear', { amount: money(summary.incomeMonthly * 12) })} />
        <Tile label={t('retirement.tileOutgoing')} value={money(summary.outgoingMonthly)} hint={t('retirement.perYear', { amount: money(summary.outgoingMonthly * 12) })} />
        <Tile
          label={t('retirement.tileCoverage')}
          value={covered != null ? `${covered}%` : '—'}
          hint={t('retirement.coverageHint')}
        />
        <Tile
          label={shortfall ? t('retirement.tileShortfall') : t('retirement.tileSurplus')}
          value={money(Math.abs(summary.surplusMonthly))}
          hint={t('retirement.perYear', { amount: money(Math.abs(summary.surplusMonthly) * 12) })}
          tone={shortfall ? 'negative' : 'positive'}
        />
      </div>

      {summary.skipped > 0 && (
        <p className="text-xs text-amber-700 mb-3">{t('retirement.skipped', { count: summary.skipped })}</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title={t('retirement.incomeTitle')} subtitle={t('retirement.incomeHint')}>
          {summary.income.length === 0 && !isLoading ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              {t('retirement.noIncome')}{' '}
              <Link to="/recurring" className="text-primary hover:underline">{t('retirement.goToRecurring')}</Link>
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {summary.income.map((line) => (
                <IncomeRow key={line.item.id} line={line} counted={!excluded.has(line.item.id)} onToggle={() => toggle(line.item.id)} money={money} />
              ))}
            </ul>
          )}
        </Card>

        <Card title={t('retirement.outgoingTitle')} subtitle={t('retirement.outgoingHint')}>
          <ul className="divide-y divide-border max-h-[32rem] overflow-y-auto">
            {summary.outgoing.map((line) => (
              <li key={line.item.id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">{line.item.description}</span>
                  <span className="block text-xs text-muted-foreground">{t(`recurring.${line.item.frequency}`)}</span>
                </span>
                <span className="shrink-0 tabular-nums">{money(line.monthly)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: 'positive' | 'negative' }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm px-4 sm:px-5 py-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('text-xl font-semibold mt-1', tone === 'positive' && 'text-emerald-600', tone === 'negative' && 'text-rose-500')}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{hint}</p>
    </div>
  )
}

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="px-4 sm:px-5 py-4 border-b border-border">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

function IncomeRow({
  line,
  counted,
  onToggle,
  money,
}: {
  line: RetirementLine
  counted: boolean
  onToggle: () => void
  money: (value: number) => string
}) {
  const { t } = useTranslation()
  return (
    <li className="px-5 py-2.5">
      <label className="flex items-center gap-3 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={counted}
          onChange={onToggle}
          className="size-4 accent-primary shrink-0"
          aria-label={t('retirement.countThis', { name: line.item.description })}
        />
        <span className={cn('min-w-0 flex-1', !counted && 'text-muted-foreground line-through')}>
          <span className="block truncate">{line.item.description}</span>
          <span className="block text-xs text-muted-foreground no-underline">{t(`recurring.${line.item.frequency}`)}</span>
        </span>
        <span className={cn('shrink-0 tabular-nums', !counted && 'text-muted-foreground')}>{money(line.monthly)}</span>
      </label>
    </li>
  )
}
