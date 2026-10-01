import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Repeat, Sparkles } from 'lucide-react'
import { categories as categoriesApi, categoryGroups as categoryGroupsApi, recurring as recurringApi } from '@/lib/api'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { extractApiError } from '@/lib/api-errors'
import { formatCurrency } from '@/lib/format'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePickerInput } from '@/components/ui/date-picker-input'
import { CategorySelect } from '@/components/category-select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { RecurringSuggestion, RecurringTransaction, Transaction } from '@/types'

const FREQUENCIES: RecurringTransaction['frequency'][] = ['monthly', 'yearly', 'quarterly', 'semiannual', 'biweekly', 'weekly']
const WITH_DAY_OF_MONTH = new Set(['monthly', 'quarterly', 'semiannual'])

/** Turns a transaction into a recurring item. As soon as it opens it looks for
 *  the transaction's siblings (same name, ideally same amount) to suggest how
 *  often it repeats. */
export function MakeRecurringDialog({
  transaction,
  open,
  onClose,
  onCreated,
}: {
  transaction: Transaction
  open: boolean
  onClose: () => void
  onCreated?: () => void
}) {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const queryClient = useQueryClient()

  const suggestionQuery = useQuery({
    queryKey: ['recurring-suggestion', transaction.id],
    queryFn: () => recurringApi.suggestion(transaction.id),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  })
  const { data: categoriesList } = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list, enabled: open })
  const { data: categoryGroupsList } = useQuery({ queryKey: ['categoryGroups'], queryFn: categoryGroupsApi.list, enabled: open })

  // The suggestion fills the form until the user edits a field; edits (null =
  // untouched) always win over it.
  const suggestion = suggestionQuery.data
  const [description, setDescription] = useState(transaction.description)
  const [amountEdit, setAmountEdit] = useState<string | null>(null)
  const [frequencyEdit, setFrequencyEdit] = useState<RecurringTransaction['frequency'] | null>(null)
  const [dayEdit, setDayEdit] = useState<string | null>(null)
  const [lastDateEdit, setLastDateEdit] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState(transaction.category_id ?? '')

  const amount = amountEdit
    ?? (suggestion?.typical_amount != null && !suggestion.amount_varies
      ? String(Number(suggestion.typical_amount))
      : String(transaction.amount))
  const frequency = frequencyEdit ?? suggestion?.frequency ?? 'monthly'
  const dayOfMonth = dayEdit ?? (suggestion?.day_of_month ? String(suggestion.day_of_month) : '')
  const lastDate = lastDateEdit ?? suggestion?.last_date ?? transaction.date

  const createMutation = useMutation({
    mutationFn: () =>
      recurringApi.create({
        description,
        amount: Number(amount),
        currency: transaction.currency,
        type: transaction.type,
        frequency,
        day_of_month: WITH_DAY_OF_MONTH.has(frequency) && dayOfMonth ? Number(dayOfMonth) : null,
        start_date: lastDate,
        account_id: transaction.account_id ?? undefined,
        category_id: categoryId || null,
        skip_first: true,
        source_transaction_id: transaction.id,
      }),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['recurring'] })
      queryClient.invalidateQueries({ queryKey: ['transactions'] })
      toast.success(t('recurring.created'))
      onCreated?.()
      onClose()
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })

  const selectClass = 'w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary'

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat size={16} /> {t('recurring.makeRecurring')}
          </DialogTitle>
          <DialogDescription>{t('recurring.makeRecurringDescription')}</DialogDescription>
        </DialogHeader>

        <SuggestionBanner
          loading={suggestionQuery.isLoading}
          failed={suggestionQuery.isError}
          suggestion={suggestion}
          currency={transaction.currency}
          locale={locale}
        />

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            createMutation.mutate()
          }}
        >
          <div className="space-y-2">
            <Label>{t('recurring.description')}</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('recurring.amount')} ({transaction.currency})</Label>
              <Input type="number" step="0.01" value={amount} onChange={(e) => setAmountEdit(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>{t('recurring.frequency')}</Label>
              <select className={selectClass} value={frequency} onChange={(e) => setFrequencyEdit(e.target.value as RecurringTransaction['frequency'])}>
                {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`recurring.${f}`)}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('recurring.lastOccurrence')}</Label>
              <DatePickerInput value={lastDate} onChange={setLastDateEdit} className="w-full justify-start" />
            </div>
            {WITH_DAY_OF_MONTH.has(frequency) && (
              <div className="space-y-2">
                <Label>{t('recurring.dayOfMonth')}</Label>
                <Input type="number" min="1" max="31" value={dayOfMonth} onChange={(e) => setDayEdit(e.target.value)} />
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t('recurring.category')}</Label>
            <CategorySelect
              value={categoryId}
              onChange={setCategoryId}
              categories={categoriesList ?? []}
              groups={categoryGroupsList ?? []}
              currentCategory={transaction.category ?? undefined}
              allowNone={true}
              className={selectClass}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={createMutation.isPending || !transaction.account_id}>
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('recurring.makeRecurring')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SuggestionBanner({
  loading,
  failed,
  suggestion,
  currency,
  locale,
}: {
  loading: boolean
  failed: boolean
  suggestion?: RecurringSuggestion
  currency: string
  locale: string
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2">
        <Loader2 size={14} className="animate-spin" /> {t('recurring.suggestionLooking')}
      </div>
    )
  }
  if (failed || !suggestion) return null
  if (!suggestion.frequency) {
    return (
      <div className="text-sm text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2">
        {suggestion.occurrences > 1
          ? t('recurring.suggestionIrregular', { count: suggestion.occurrences })
          : t('recurring.suggestionNone')}
      </div>
    )
  }
  return (
    <div className="text-sm bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-md px-3 py-2 space-y-1">
      <p className="flex items-center gap-2 font-medium text-emerald-800 dark:text-emerald-200">
        <Sparkles size={14} />
        {t('recurring.suggestionFound', {
          frequency: t(`recurring.${suggestion.frequency}`).toLowerCase(),
          count: suggestion.occurrences,
          basis: t(`recurring.basis_${suggestion.match_basis}`),
        })}
      </p>
      <p className="text-xs text-emerald-800/80 dark:text-emerald-200/80">
        {t('recurring.suggestionDetail', { gap: suggestion.average_gap_days, confidence: t(`recurring.confidence_${suggestion.confidence}`) })}
        {suggestion.amount_varies && suggestion.typical_amount != null
          ? ` · ${t('recurring.suggestionVaries', { amount: formatCurrency(Number(suggestion.typical_amount), currency, locale) })}`
          : ''}
      </p>
    </div>
  )
}
