import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { assets as assetsApi } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { customEntries, fieldsFor, type DetailField } from '@/lib/asset-details'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Asset } from '@/types'

type Details = NonNullable<Asset['details']>

function toStrings(details: Asset['details']): Record<string, string> {
  return Object.fromEntries(Object.entries(details ?? {}).map(([k, v]) => [k, v == null ? '' : String(v)]))
}

/** Turn what was typed into saved values: numbers where the field is numeric, nothing for an empty field. */
function toDetails(field: DetailField | undefined, text: string): string | number | null {
  const value = text.trim()
  if (value === '') return null
  if ((field?.kind === 'number' || field?.kind === 'year') && Number.isFinite(Number(value))) return Number(value)
  return value
}

/** Technical details by type, plus free fields of the person's own. */
export function AssetDetailsCard({ asset, canWrite }: { asset: Asset; canWrite: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>(() => toStrings(asset.details))
  const [custom, setCustom] = useState<[string, string][]>(() => customEntries(asset.type, asset.details))

  const fields = fieldsFor(asset.type, values)

  const build = (): Details => {
    const result: Details = {}
    // Keep what the template does not show (a car's fields on a boat), then what is typed.
    for (const [key, text] of Object.entries(values)) {
      if (customEntries(asset.type, values).some(([k]) => k === key)) continue
      const v = toDetails(fields.find((f) => f.key === key), text)
      if (v !== null) result[key] = v
    }
    for (const [key, text] of custom) {
      const name = key.trim()
      if (name && text.trim() !== '') result[name] = text.trim()
    }
    return result
  }
  const draft = build()
  const dirty = JSON.stringify(draft) !== JSON.stringify(asset.details ?? {})

  const save = useMutation({
    mutationFn: () => assetsApi.update(asset.id, { details: draft } as Partial<Asset>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['asset', asset.id] })
      queryClient.invalidateQueries({ queryKey: ['assets'] })
      toast.success(t('assets.page.saved'))
    },
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })

  if (fields.length === 0 && custom.length === 0 && !canWrite) return null

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5">
      <p className="text-sm font-semibold text-foreground">{t('assets.page.technical')}</p>
      <p className="text-xs text-muted-foreground mt-0.5 mb-3">{t('assets.page.technicalHint')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {fields.map((field) => {
          const id = `detail-${field.key.replace(/\W+/g, '-').toLowerCase()}`
          return (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={id} className="text-xs">
                {field.key}
                {field.unit && <span className="text-muted-foreground"> ({field.unit})</span>}
              </Label>
              {field.kind === 'select' ? (
                <select
                  id={id}
                  className="w-full border border-border rounded-md px-2 h-8 text-sm bg-card disabled:opacity-70"
                  value={values[field.key] ?? ''}
                  disabled={!canWrite}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                >
                  <option value="">–</option>
                  {field.options!.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <Input
                  id={id}
                  className="h-8"
                  type={field.kind === 'text' ? 'text' : 'number'}
                  step="any"
                  value={values[field.key] ?? ''}
                  disabled={!canWrite}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                />
              )}
            </div>
          )
        })}
      </div>

      {(custom.length > 0 || canWrite) && (
        <div className="mt-4">
          <p className="text-xs font-medium text-muted-foreground mb-2">{t('assets.page.ownFields')}</p>
          <div className="space-y-2">
            {custom.map(([key, text], i) => (
              <div key={i} className="flex gap-2">
                <Input
                  className="h-8 w-40 shrink-0"
                  value={key}
                  placeholder={t('assets.page.fieldName')}
                  aria-label={t('assets.page.fieldName')}
                  disabled={!canWrite}
                  onChange={(e) => setCustom((c) => c.map((row, j) => (j === i ? [e.target.value, row[1]] : row)))}
                />
                <Input
                  className="h-8"
                  value={text}
                  placeholder={t('assets.page.fieldValue')}
                  aria-label={`${key || t('assets.page.fieldName')} ${t('assets.page.fieldValue')}`}
                  disabled={!canWrite}
                  onChange={(e) => setCustom((c) => c.map((row, j) => (j === i ? [row[0], e.target.value] : row)))}
                />
                {canWrite && (
                  <button type="button" className="text-muted-foreground hover:text-rose-500 shrink-0" aria-label={t('common.delete')} onClick={() => setCustom((c) => c.filter((_, j) => j !== i))}>
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {canWrite && (
            <Button type="button" size="sm" variant="outline" className="mt-2 h-7 gap-1" onClick={() => setCustom((c) => [...c, ['', '']])}>
              <Plus size={12} /> {t('assets.page.addField')}
            </Button>
          )}
        </div>
      )}

      {canWrite && (
        <div className="mt-4 flex justify-end">
          <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  )
}
