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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CategorizationJob, CategorizationSuggestion, Category, CategoryGroup } from '@/types'

const ACTIVE = new Set(['pending', 'running'])
const RULES_KEY = 'categorizer:create-rules'
const SORT_KEY = 'categorizer:sort'
type SuggestionSort = 'value' | 'count'

function loadSort(): SuggestionSort {
  try {
    return window.localStorage.getItem(SORT_KEY) === 'count' ? 'count' : 'value'
  } catch {
    return 'value'
  }
}

function loadCreateRules(): boolean {
  try {
    return window.localStorage.getItem(RULES_KEY) === '1'
  } catch {
    return false
  }
}

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
  // Remembered between visits: whether accepting also makes a rule for the merchant.
  const [createRules, setCreateRules] = useState(loadCreateRules)
  // Highest total value first by default; changing it is the only thing that reloads the list.
  const [sort, setSort] = useState<SuggestionSort>(loadSort)
  const changeSort = (value: SuggestionSort) => {
    setSort(value)
    try {
      window.localStorage.setItem(SORT_KEY, value)
    } catch {
      // Blocked storage: the choice just does not persist.
    }
  }
  const changeCreateRules = (value: boolean) => {
    setCreateRules(value)
    try {
      window.localStorage.setItem(RULES_KEY, value ? '1' : '0')
    } catch {
      // Blocked storage: the choice just does not persist.
    }
  }

  const { data: categoriesList } = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list, refetchOnWindowFocus: false })
  const { data: groupsList } = useQuery({ queryKey: ['categoryGroups'], queryFn: categoryGroupsApi.list, refetchOnWindowFocus: false })

  // The key is the job alone. Keying it on live counters would throw the list
  // away on every poll or accepted row, and with it the choices being made.
  const listKey = ['categorization', 'suggestions', job.id, sort] as const
  const { data: suggestions } = useQuery({
    queryKey: listKey,
    queryFn: () => api.suggestions(job.id, 50, sort),
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
    mutationFn: () => api.acceptAll(job.id, 'high', createRules),
    onSuccess: (r) => {
      toast.success(t('categories.automate.acceptedAll', { suggestions: r.suggestions, transactions: r.transactions }) + (createRules ? ' ' + t('categories.automate.rulesAdded', { count: r.rules_created }) : ''))
      refreshAll()
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })

  const retroRules = useMutation({
    mutationFn: () => api.createRulesForAccepted(),
    onSuccess: (r) => {
      toast.success(t('categories.automate.rulesForAcceptedDone', { created: r.created, considered: r.considered }))
      queryClient.invalidateQueries({ queryKey: ['rules'] })
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
        {job.counts.pending > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t('categories.automate.sortLabel')}
            <select
              className="border border-border rounded-md px-2 py-1 text-xs bg-card text-foreground"
              value={sort}
              onChange={(e) => changeSort(e.target.value as SuggestionSort)}
            >
              <option value="value">{t('categories.automate.sortValue')}</option>
              <option value="count">{t('categories.automate.sortCount')}</option>
            </select>
          </label>
        )}
        {canWrite && job.counts.pending > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer" title={t('categories.automate.createRulesHint')}>
              <input type="checkbox" checked={createRules} onChange={(e) => changeCreateRules(e.target.checked)} className="size-4 accent-primary" />
              {t('categories.automate.createRules')}
            </label>
            {job.counts.accepted > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => retroRules.mutate()} disabled={retroRules.isPending} title={t('categories.automate.rulesForAcceptedHint')}>
                {retroRules.isPending && <Loader2 size={14} className="animate-spin" />}
                {t('categories.automate.rulesForAccepted')}
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => acceptAll.mutate()} disabled={acceptAll.isPending}>
              {acceptAll.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {t('categories.automate.acceptHigh')}
            </Button>
          </div>
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
              createRule={createRules}
              money={(v) => mask(formatCurrency(Number(v), currency, locale))}
              onDone={() => removeRow(s.id)}
            />
          ))}
        </ul>
      )}
      {suggestions && suggestions.total > items.length && (
        <p className="px-5 py-3 text-xs text-muted-foreground border-t border-border">
          {t(sort === 'value' ? 'categories.automate.showingByValue' : 'categories.automate.showing', { shown: items.length, total: suggestions.total })}
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
  createRule,
  money,
  onDone,
}: {
  suggestion: CategorizationSuggestion
  categories: Category[]
  groups: CategoryGroup[]
  canWrite: boolean
  createRule: boolean
  money: (value: string | number) => string
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [categoryEdit, setCategoryEdit] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const categoryId = categoryEdit ?? suggestion.suggested_category_id ?? ''

  const accept = useMutation({
    mutationFn: () => api.accept(suggestion.id, categoryId || undefined, createRule),
    onSuccess: (result) => {
      if (createRule && !result.rule_created) toast.info(t('categories.automate.noRule'))
      onDone()
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })
  const reject = useMutation({ mutationFn: () => api.reject(suggestion.id), onSuccess: onDone })

  const tone = suggestion.confidence === 'high' ? 'text-emerald-600' : suggestion.confidence === 'low' ? 'text-rose-500' : 'text-amber-600'
  return (
    <li className="px-4 sm:px-5 py-3 flex flex-col lg:flex-row lg:items-center gap-3">
      <div className="min-w-0 lg:flex-1">
        <p className="text-sm font-medium truncate">{suggestion.sample_description}</p>
        <p className="text-xs text-muted-foreground">
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            onClick={() => setInspecting(true)}
            title={t('categories.automate.inspect')}
          >
            {t('categories.automate.rowCount', { count: suggestion.tx_count })}
          </button>
          {' · '}
          {money(suggestion.total_amount_primary)}
          {' · '}
          {t(`categories.automate.source.${suggestion.source}`)}
          {' · '}
          <span className={tone}>{t(`categories.automate.confidence.${suggestion.confidence}`)}</span>
        </p>
      </div>
      {inspecting && <SuggestionTransactionsDialog suggestion={suggestion} onClose={() => setInspecting(false)} />}
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

/** The transactions behind a suggestion, for checking before accepting. */
function SuggestionTransactionsDialog({ suggestion, onClose }: { suggestion: CategorizationSuggestion; onClose: () => void }) {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  const { data, isLoading } = useQuery({
    queryKey: ['categorization', 'suggestion-transactions', suggestion.id],
    queryFn: () => api.transactions(suggestion.id),
    refetchOnWindowFocus: false,
  })
  const items = data?.items ?? []
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-3xl max-h-[calc(100dvh-2rem)] flex flex-col">
        <DialogHeader>
          <DialogTitle className="truncate">{suggestion.sample_description}</DialogTitle>
          <DialogDescription>{t('categories.automate.inspectDescription', { count: data?.total ?? suggestion.tx_count })}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 size={14} className="animate-spin" /> {t('common.loading')}</div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6">{t('categories.automate.inspectEmpty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="text-left font-medium py-2 pr-3">{t('transactions.date')}</th>
                  <th className="text-left font-medium py-2 pr-3">{t('transactions.description')}</th>
                  <th className="text-left font-medium py-2 pr-3 hidden sm:table-cell">{t('transactions.account')}</th>
                  <th className="text-right font-medium py-2">{t('transactions.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((tx) => (
                  <tr key={tx.id} className="border-b border-border last:border-0 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{new Date(tx.date).toLocaleDateString(locale)}</td>
                    <td className="py-2 pr-3 break-words">{tx.description}</td>
                    <td className="py-2 pr-3 hidden sm:table-cell text-muted-foreground">{tx.account_name}</td>
                    <td className={cn('py-2 text-right whitespace-nowrap tabular-nums', tx.type === 'credit' ? 'text-emerald-600' : '')}>
                      {mask(`${tx.type === 'credit' ? '+' : '−'}${formatCurrency(Number(tx.amount), tx.currency, locale)}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {data && data.total > items.length && (
          <p className="text-xs text-muted-foreground">{t('categories.automate.showing', { shown: items.length, total: data.total })}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
