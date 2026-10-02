import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { assets as assetsApi, recurring as recurringApi } from '@/lib/api'
import { computeRetirement, type IncomeKind, type IncomeLine } from '@/lib/retirement'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { PageHeader } from '@/components/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RetirementProjection } from '@/components/retirement-projection'
import { write } from '@/lib/retirement-plan'
import { loadFromServer } from '@/lib/retirement-sync'
import { RetirementSimulator } from '@/components/retirement-simulator'

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
  write(EXCLUDED_KEY, [...ids])
}

/** Brings the saved plans down from the server before the page reads them. */
export default function RetirementPage() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    loadFromServer().finally(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return ready ? <RetirementContent /> : null
}

function RetirementContent() {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const currency = user?.preferences?.currency_display ?? 'USD'
  const [excluded, setExcluded] = useState<Set<string>>(loadExcluded)
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab = requested === 'projection' || requested === 'simulate' ? requested : 'overview'

  const { data: items, isLoading } = useQuery({
    queryKey: ['recurring'],
    queryFn: recurringApi.list,
  })

  const { data: assetList } = useQuery({
    queryKey: ['assets'],
    queryFn: () => assetsApi.list(),
  })

  const summary = useMemo(
    () => computeRetirement(items ?? [], assetList ?? [], currency, excluded),
    [items, assetList, currency, excluded],
  )
  const sections: { kind: IncomeKind; title: string }[] = [
    { kind: 'recurring', title: t('retirement.incomeRecurringTitle') },
    { kind: 'asset-income', title: t('retirement.incomeAssetsTitle') },
    { kind: 'asset-sale', title: t('retirement.incomeSalesTitle') },
  ]

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

      <Tabs value={tab} onValueChange={(value) => setParams(value === 'overview' ? {} : { tab: value })}>
        <TabsList className="mb-4">
          <TabsTrigger value="overview">{t('retirement.tabOverview')}</TabsTrigger>
          <TabsTrigger value="projection">{t('retirement.tabProjection')}</TabsTrigger>
          <TabsTrigger value="simulate">{t('retirement.tabSimulate')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
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
                sections.map(({ kind, title }) => {
                  const lines = summary.income.filter((l) => l.kind === kind)
                  if (lines.length === 0) return null
                  return (
                    <div key={kind}>
                      <p className="px-5 pt-3 pb-1 text-xs font-medium text-muted-foreground">{title}</p>
                      <ul className="divide-y divide-border">
                        {lines.map((line) => (
                          <IncomeRow key={line.id} line={line} counted={!excluded.has(line.id)} onToggle={() => toggle(line.id)} money={money} />
                        ))}
                      </ul>
                    </div>
                  )
                })
              )}
            </Card>

            <Card title={t('retirement.outgoingTitle')} subtitle={t('retirement.outgoingHint')}>
              <ul className="divide-y divide-border max-h-[32rem] overflow-y-auto">
                {summary.outgoing.map((line) => (
                  <ToggleRow
                    key={line.item.id}
                    label={line.item.description}
                    detail={t(`recurring.${line.item.frequency}`)}
                    amount={money(line.monthly)}
                    counted={!excluded.has(line.item.id)}
                    onToggle={() => toggle(line.item.id)}
                    ariaLabel={t('retirement.countOutgoing', { name: line.item.description })}
                  />
                ))}
              </ul>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="projection">
          <p className="text-xs text-muted-foreground mb-3">
            {t('retirement.projection.countedOnOverview')}{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => setParams({})}>
              {t('retirement.tabOverview')}
            </button>
          </p>
          <RetirementProjection items={items ?? []} assets={assetList ?? []} excluded={excluded} currency={currency} locale={locale} />

        </TabsContent>

        <TabsContent value="simulate">
          <p className="text-xs text-muted-foreground mb-3">{t('retirement.simulate.usesPlan')}</p>
          <RetirementSimulator items={items ?? []} assets={assetList ?? []} excluded={excluded} currency={currency} locale={locale} />
        </TabsContent>
      </Tabs>
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
  line: IncomeLine
  counted: boolean
  onToggle: () => void
  money: (value: number) => string
}) {
  const { t } = useTranslation()
  const detail = line.kind === 'recurring'
    ? t(`recurring.${line.frequency}`)
    : line.kind === 'asset-income' && line.asset?.income_mode === 'yield'
      ? t('retirement.assetYield', { rate: line.asset.income_rate, value: money(line.asset.current_value_primary ?? line.asset.current_value ?? 0) })
      : line.kind === 'asset-income'
        ? t('retirement.assetFixed', { frequency: t(`recurring.${line.frequency}`) })
        : t('retirement.assetSale', { percent: line.asset?.sell_percent_per_year, value: money(line.asset?.current_value_primary ?? line.asset?.current_value ?? 0) })
  return (
    <ToggleRow
      label={line.label}
      detail={detail}
      amount={money(line.monthly)}
      counted={counted}
      onToggle={onToggle}
      ariaLabel={t('retirement.countThis', { name: line.label })}
    />
  )
}

/** A line with a checkbox: unticked lines stay listed but drop out of the totals. */
function ToggleRow({
  label,
  detail,
  amount,
  counted,
  onToggle,
  ariaLabel,
}: {
  label: string
  detail: string
  amount: string
  counted: boolean
  onToggle: () => void
  ariaLabel: string
}) {
  return (
    <li className="px-5 py-2.5">
      <label className="flex items-center gap-3 text-sm cursor-pointer">
        <input type="checkbox" checked={counted} onChange={onToggle} className="size-4 accent-primary shrink-0" aria-label={ariaLabel} />
        <span className={cn('min-w-0 flex-1', !counted && 'text-muted-foreground line-through')}>
          <span className="block truncate">{label}</span>
          <span className="block text-xs text-muted-foreground no-underline">{detail}</span>
        </span>
        <span className={cn('shrink-0 tabular-nums', !counted && 'text-muted-foreground')}>{amount}</span>
      </label>
    </li>
  )
}
