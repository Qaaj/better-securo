import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { assets as assetsApi } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { formatCurrency } from '@/lib/format'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useWorkspace } from '@/contexts/workspace-context'
import { PageHeader } from '@/components/page-header'
import { AssetPhotos } from '@/components/asset-photos'
import { AssetLocation } from '@/components/asset-location'
import { AssetDetailsCard } from '@/components/asset-details-card'
import { Button } from '@/components/ui/button'
import type { Asset } from '@/types'

const TYPE_KEY: Record<string, string> = {
  real_estate: 'assets.typeRealEstate',
  vehicle: 'assets.typeVehicle',
  valuable: 'assets.typeValuable',
  investment: 'assets.typeInvestment',
  other: 'assets.typeOther',
}

export default function AssetDetailPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation()
  const { canWrite } = useWorkspace()
  const { data: asset, isLoading, isError } = useQuery({ queryKey: ['asset', id], queryFn: () => assetsApi.get(id) })

  if (isLoading) return <p className="text-sm text-muted-foreground py-10 text-center">{t('common.loading')}</p>
  if (isError || !asset) {
    return (
      <div className="py-10 text-center space-y-3">
        <p className="text-sm text-muted-foreground">{t('assets.page.notFound')}</p>
        <Link to="/assets" className="text-sm text-primary hover:underline">{t('assets.page.back')}</Link>
      </div>
    )
  }
  return <AssetPage asset={asset} canWrite={canWrite} />
}

function AssetPage({ asset, canWrite }: { asset: Asset; canWrite: boolean }) {
  const { t } = useTranslation()
  return (
    <div>
      <Link to="/assets" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2">
        <ArrowLeft size={13} /> {t('assets.page.back')}
      </Link>
      <PageHeader section={t(TYPE_KEY[asset.type] ?? 'assets.typeOther')} title={asset.name} />

      <div className="space-y-4">
        <AssetPhotos assetId={asset.id} assetName={asset.name} canWrite={canWrite} />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 space-y-4">
            <Card title={t('assets.page.location')}>
              <AssetLocation key={`${asset.address}|${asset.latitude}|${asset.longitude}`} asset={asset} canWrite={canWrite} />
            </Card>
            <AssetNotes key={asset.notes ?? ''} asset={asset} canWrite={canWrite} />
          </div>
          <div className="lg:col-span-2 space-y-4">
            <AssetFacts asset={asset} />
            <AssetDetailsCard key={JSON.stringify(asset.details ?? {})} asset={asset} canWrite={canWrite} />
          </div>
        </div>
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5">
      <p className="text-sm font-semibold text-foreground mb-3">{title}</p>
      {children}
    </div>
  )
}

/** What the asset is worth and what it brings in, from the figures already kept. */
function AssetFacts({ asset }: { asset: Asset }) {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const money = (v: number) => mask(formatCurrency(v, asset.currency, locale))
  const day = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(dateLocale)
  const rows: [string, string][] = []
  if (asset.current_value != null) rows.push([t('assets.page.worth'), money(asset.current_value)])
  if (asset.purchase_price != null) rows.push([t('assets.page.bought'), `${money(asset.purchase_price)}${asset.purchase_date ? ` · ${day(asset.purchase_date)}` : ''}`])
  if (asset.current_value != null && asset.purchase_price) {
    const gain = asset.current_value - asset.purchase_price
    rows.push([t('assets.page.gain'), `${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))} (${gain >= 0 ? '+' : '−'}${Math.abs((gain / asset.purchase_price) * 100).toFixed(1)}%)`])
  }
  if (asset.growth_type && asset.growth_rate != null && asset.growth_frequency) {
    rows.push([t('assets.page.growth'), asset.growth_type === 'percentage' ? `${asset.growth_rate}% ${asset.growth_frequency}` : `${money(asset.growth_rate)} ${asset.growth_frequency}`])
  }
  if (asset.income_mode === 'yield' && asset.income_rate != null) rows.push([t('assets.page.income'), t('assets.page.yieldA', { rate: asset.income_rate })])
  if (asset.income_mode === 'fixed' && asset.income_amount != null) rows.push([t('assets.page.income'), `${money(asset.income_amount)} ${asset.income_frequency ?? ''}`])
  if (asset.sell_percent_per_year) rows.push([t('assets.page.plannedSale'), t('assets.page.percentAYear', { percent: asset.sell_percent_per_year })])
  if (asset.sell_date) rows.push([t('assets.page.sold'), `${asset.sell_price != null ? money(asset.sell_price) + ' · ' : ''}${day(asset.sell_date)}`])
  if (rows.length === 0) return null
  return (
    <Card title={t('assets.page.facts')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function AssetNotes({ asset, canWrite }: { asset: Asset; canWrite: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [text, setText] = useState(asset.notes ?? '')
  const save = useMutation({
    mutationFn: () => assetsApi.update(asset.id, { notes: text.trim() || null } as Partial<Asset>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['asset', asset.id] })
      toast.success(t('assets.page.saved'))
    },
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })
  if (!canWrite && !asset.notes) return null
  return (
    <Card title={t('assets.page.notes')}>
      <textarea
        className="w-full min-h-28 rounded-md border border-border bg-card px-3 py-2 text-sm disabled:opacity-70"
        value={text}
        disabled={!canWrite}
        maxLength={5000}
        placeholder={t('assets.page.notesPlaceholder')}
        aria-label={t('assets.page.notes')}
        onChange={(e) => setText(e.target.value)}
      />
      {canWrite && (
        <div className="mt-2 flex justify-end">
          <Button type="button" size="sm" disabled={text.trim() === (asset.notes ?? '') || save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </Card>
  )
}
