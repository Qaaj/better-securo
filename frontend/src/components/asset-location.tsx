import { lazy, Suspense, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ExternalLink, Loader2, MapPin, Search } from 'lucide-react'
import { assetPhotos, assets as assetsApi } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Asset, GeocodeResult } from '@/types'

const AssetMap = lazy(() => import('@/components/asset-map'))

/** Where the asset is: an address, found on the map with an OpenStreetMap lookup, shown on a map. */
export function AssetLocation({ asset, canWrite }: { asset: Asset; canWrite: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState(asset.address ?? '')
  const [lat, setLat] = useState(asset.latitude?.toString() ?? '')
  const [lng, setLng] = useState(asset.longitude?.toString() ?? '')
  const [results, setResults] = useState<GeocodeResult[] | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const latitude = lat.trim() === '' ? null : Number(lat)
      const longitude = lng.trim() === '' ? null : Number(lng)
      return assetsApi.update(asset.id, { address: address.trim() || null, latitude, longitude } as Partial<Asset>)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['asset', asset.id] })
      queryClient.invalidateQueries({ queryKey: ['assets'] })
      setEditing(false)
      setResults(null)
    },
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })
  const find = useMutation({
    mutationFn: () => assetPhotos.geocode(address.trim()),
    onSuccess: (found) => {
      setResults(found)
      if (found.length === 0) toast.info(t('assets.page.noAddressFound'))
    },
    onError: (e) => toast.error(extractApiError(e, t('assets.page.lookupFailed'))),
  })

  const valid = (v: string, limit: number) => v.trim() === '' || (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= limit)
  const hasPoint = asset.latitude != null && asset.longitude != null

  return (
    <div className="space-y-3">
      {hasPoint ? (
        <Suspense fallback={<div className="h-72 rounded-lg bg-muted animate-pulse" />}>
          <AssetMap latitude={asset.latitude!} longitude={asset.longitude!} />
        </Suspense>
      ) : (
        <div className="h-40 rounded-lg border-2 border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground">
          <MapPin size={22} />
          <span className="text-sm">{t('assets.page.noLocation')}</span>
        </div>
      )}

      {!editing ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-foreground min-w-0">{asset.address ?? <span className="text-muted-foreground">{t('assets.page.noAddress')}</span>}</p>
          <div className="flex items-center gap-2">
            {hasPoint && (
              <a
                href={`https://www.openstreetmap.org/?mlat=${asset.latitude}&mlon=${asset.longitude}#map=17/${asset.latitude}/${asset.longitude}`}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink size={12} /> {t('assets.page.openInOsm')}
              </a>
            )}
            {canWrite && (
              <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="space-y-1.5">
            <Label htmlFor="asset-address" className="text-xs">{t('assets.page.address')}</Label>
            <div className="flex gap-2">
              <Input id="asset-address" value={address} onChange={(e) => setAddress(e.target.value)} className="h-8" placeholder={t('assets.page.addressPlaceholder')} />
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 shrink-0" disabled={address.trim().length < 3 || find.isPending} onClick={() => find.mutate()}>
                {find.isPending ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                {t('assets.page.findOnMap')}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t('assets.page.lookupPrivacy')}</p>
          </div>
          {results && results.length > 0 && (
            <ul className="rounded-lg border border-border divide-y divide-border text-sm">
              {results.map((r) => (
                <li key={`${r.latitude},${r.longitude}`}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-muted"
                    onClick={() => {
                      setAddress(r.display_name)
                      setLat(r.latitude.toFixed(6))
                      setLng(r.longitude.toFixed(6))
                      setResults(null)
                    }}
                  >
                    {r.display_name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="asset-lat" className="text-xs">{t('assets.page.latitude')}</Label>
              <Input id="asset-lat" value={lat} onChange={(e) => setLat(e.target.value)} className="h-8" inputMode="decimal" aria-invalid={!valid(lat, 90)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-lng" className="text-xs">{t('assets.page.longitude')}</Label>
              <Input id="asset-lng" value={lng} onChange={(e) => setLng(e.target.value)} className="h-8" inputMode="decimal" aria-invalid={!valid(lng, 180)} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setResults(null); setAddress(asset.address ?? ''); setLat(asset.latitude?.toString() ?? ''); setLng(asset.longitude?.toString() ?? '') }}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" disabled={save.isPending || !valid(lat, 90) || !valid(lng, 180) || (lat.trim() === '') !== (lng.trim() === '')} onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
