import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Loader2, Play, Plug, Sparkles, X } from 'lucide-react'
import { categories as categoriesApi, categoryGroups as categoryGroupsApi, categorization as api } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CategorySelect } from '@/components/category-select'
import type { CategorizationJob, CategorizationSuggestion, Category, CategoryGroup } from '@/types'

const ACTIVE = new Set(['pending', 'running'])

/** Categories > Automate: runs the local model over the uncategorized
 *  transactions and lets the user review the result merchant by merchant. */
export function CategorizerAutomate() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { canWrite } = useWorkspace()

  const settingsQuery = useQuery({ queryKey: ['categorization', 'settings'], queryFn: api.settings })
  // Edits win over the prefilled server settings.
  const [urlEdit, setUrlEdit] = useState<string | null>(null)
  const [modelEdit, setModelEdit] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const baseUrl = urlEdit ?? settingsQuery.data?.base_url ?? ''
  const model = modelEdit ?? settingsQuery.data?.model ?? ''

  const jobQuery = useQuery({
    queryKey: ['categorization', 'job'],
    queryFn: api.latest,
    refetchInterval: (query) => (query.state.data && ACTIVE.has(query.state.data.status) ? 2000 : false),
  })
  const job = jobQuery.data ?? null
  const running = job != null && ACTIVE.has(job.status)

  const refreshJob = () => queryClient.invalidateQueries({ queryKey: ['categorization'] })

  const testMutation = useMutation({
    mutationFn: () => api.testConnection(baseUrl),
    onSuccess: (data) => {
      setModels(data.models)
      toast.success(t('categories.automate.connected', { count: data.models.length }))
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })

  const startMutation = useMutation({
    mutationFn: () => api.start(baseUrl, model),
    onSuccess: () => refreshJob(),
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancel(id),
    onSuccess: () => refreshJob(),
  })

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('categories.automate.title')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('categories.automate.description')}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[2fr_2fr_auto] gap-3 items-end">
          <div className="space-y-2">
            <Label>{t('categories.automate.serverUrl')}</Label>
            <Input value={baseUrl} onChange={(e) => setUrlEdit(e.target.value)} placeholder="http://host:1234" disabled={running} />
          </div>
          <div className="space-y-2">
            <Label>{t('categories.automate.model')}</Label>
            {models.length > 0 ? (
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                value={model}
                onChange={(e) => setModelEdit(e.target.value)}
                disabled={running}
              >
                {!models.includes(model) && model && <option value={model}>{model}</option>}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <Input value={model} onChange={(e) => setModelEdit(e.target.value)} disabled={running} />
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => testMutation.mutate()} disabled={!baseUrl || testMutation.isPending || !canWrite}>
              {testMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              {t('categories.automate.test')}
            </Button>
            <Button type="button" onClick={() => startMutation.mutate()} disabled={!baseUrl || !model || running || startMutation.isPending || !canWrite}>
              <Play size={14} /> {t('categories.automate.start')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('categories.automate.hint')}</p>
      </div>

      {job && <JobCard job={job} onCancel={() => cancelMutation.mutate(job.id)} cancelling={cancelMutation.isPending} />}
      {job && job.counts.pending + job.counts.accepted + job.counts.rejected > 0 && <ReviewList job={job} canWrite={canWrite} />}
    </div>
  )
}

function JobCard({ job, onCancel, cancelling }: { job: CategorizationJob; onCancel: () => void; cancelling: boolean }) {
  const { t } = useTranslation()
  const pct = job.total_merchants > 0 ? Math.round((job.processed_merchants / job.total_merchants) * 100) : 0
  const active = ACTIVE.has(job.status)
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground flex items-center gap-2">
          {active && <Loader2 size={14} className="animate-spin" />}
          {t(`categories.automate.status.${job.status}`)}
        </p>
        {active && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={cancelling}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full transition-all', job.status === 'failed' ? 'bg-rose-500' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {t('categories.automate.progress', { done: job.processed_merchants, total: job.total_merchants, model: job.model })}
      </p>
      {job.error && <p className="text-xs text-rose-600">{job.error}</p>}
    </div>
  )
}

function ReviewList({ job, canWrite }: { job: CategorizationJob; canWrite: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const currency = user?.preferences?.currency_display ?? 'USD'

  const { data: categoriesList } = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list, refetchOnWindowFocus: false })
  const { data: groupsList } = useQuery({ queryKey: ['categoryGroups'], queryFn: categoryGroupsApi.list, refetchOnWindowFocus: false })

  // The key is the job alone. Keying it on live counters would throw the list
  // away on every poll or accepted row, and with it the choices being made.
  const listKey = ['categorization', 'suggestions', job.id] as const
  const { data: suggestions } = useQuery({
    queryKey: listKey,
    queryFn: () => api.suggestions(job.id),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    // New suggestions only arrive while the job runs.
    refetchInterval: ACTIVE.has(job.status) ? 4000 : false,
  })

  // The financial queries behind the dashboard are refreshed once things go
  // quiet, not after every row.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current) }, [])
  const scheduleFinancialRefresh = () => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => invalidateFinancialQueries(queryClient), 2500)
  }

  // A row you acted on leaves the list at once; nothing else is refetched, so
  // the rows you are still working on keep their state and position.
  const removeRow = (id: string) => {
    queryClient.setQueryData<{ items: CategorizationSuggestion[]; total: number }>(listKey, (old) =>
      old ? { items: old.items.filter((s) => s.id !== id), total: Math.max(0, old.total - 1) } : old,
    )
    queryClient.setQueryData<CategorizationJob | null>(['categorization', 'job'], (old) =>
      old ? { ...old, counts: { ...old.counts, pending: Math.max(0, old.counts.pending - 1) } } : old,
    )
    scheduleFinancialRefresh()
  }
  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['categorization'] })
    invalidateFinancialQueries(queryClient)
  }
  const acceptAll = useMutation({
    mutationFn: () => api.acceptAll(job.id, 'high'),
    onSuccess: (r) => {
      toast.success(t('categories.automate.acceptedAll', { suggestions: r.suggestions, transactions: r.transactions }))
      refreshAll()
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })

  const items = suggestions?.items ?? []
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('categories.automate.reviewTitle')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('categories.automate.reviewCounts', { pending: job.counts.pending, accepted: job.counts.accepted })}
          </p>
        </div>
        {canWrite && job.counts.pending > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={() => acceptAll.mutate()} disabled={acceptAll.isPending}>
            {acceptAll.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {t('categories.automate.acceptHigh')}
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">{t('categories.automate.nothingToReview')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((s) => (
            <SuggestionRow
              key={s.id}
              suggestion={s}
              categories={categoriesList ?? []}
              groups={groupsList ?? []}
              canWrite={canWrite}
              money={(v) => mask(formatCurrency(Number(v), currency, locale))}
              onDone={() => removeRow(s.id)}
            />
          ))}
        </ul>
      )}
      {suggestions && suggestions.total > items.length && (
        <p className="px-5 py-3 text-xs text-muted-foreground border-t border-border">
          {t('categories.automate.showing', { shown: items.length, total: suggestions.total })}
        </p>
      )}
    </div>
  )
}

function SuggestionRow({
  suggestion,
  categories,
  groups,
  canWrite,
  money,
  onDone,
}: {
  suggestion: CategorizationSuggestion
  categories: Category[]
  groups: CategoryGroup[]
  canWrite: boolean
  money: (value: string | number) => string
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [categoryEdit, setCategoryEdit] = useState<string | null>(null)
  const categoryId = categoryEdit ?? suggestion.suggested_category_id ?? ''

  const accept = useMutation({
    mutationFn: () => api.accept(suggestion.id, categoryId || undefined),
    onSuccess: onDone,
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })
  const reject = useMutation({ mutationFn: () => api.reject(suggestion.id), onSuccess: onDone })

  const tone = suggestion.confidence === 'high' ? 'text-emerald-600' : suggestion.confidence === 'low' ? 'text-rose-500' : 'text-amber-600'
  return (
    <li className="px-4 sm:px-5 py-3 flex flex-col lg:flex-row lg:items-center gap-3">
      <div className="min-w-0 lg:flex-1">
        <p className="text-sm font-medium truncate">{suggestion.sample_description}</p>
        <p className="text-xs text-muted-foreground">
          {t('categories.automate.rowMeta', { count: suggestion.tx_count, total: money(suggestion.total_amount_primary) })}
          {' · '}
          {t(`categories.automate.source.${suggestion.source}`)}
          {' · '}
          <span className={tone}>{t(`categories.automate.confidence.${suggestion.confidence}`)}</span>
        </p>
      </div>
      <div className="lg:w-64">
        <CategorySelect
          value={categoryId}
          onChange={setCategoryEdit}
          categories={categories}
          groups={groups}
          allowNone={false}
          disabled={!canWrite}
          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground"
        />
      </div>
      {canWrite && (
        <div className="flex gap-2 shrink-0">
          <Button type="button" size="sm" onClick={() => accept.mutate()} disabled={!categoryId || accept.isPending || reject.isPending}>
            {accept.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {t('categories.automate.accept')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => reject.mutate()} disabled={accept.isPending || reject.isPending} title={t('categories.automate.skip')}>
            <X size={14} />
          </Button>
        </div>
      )}
    </li>
  )
}
