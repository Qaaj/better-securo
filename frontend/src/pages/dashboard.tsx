import { useState, useEffect, useMemo, useRef } from 'react'
import { getAccountLabel, getAccountName, sortAccountsByAbsoluteBalance, sumAccountBalances } from '@/lib/account-utils'
import { currentMonth, shiftMonth, monthLastDay, monthLabel, monthRange } from '@/lib/month-utils'
import { useTranslation } from 'react-i18next'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { dashboard, transactions, categories as categoriesApi, categoryGroups as categoryGroupsApi, accounts as accountsApi, payees as payeesApi, rules as rulesApi } from '@/lib/api'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { ProjectedTransactionBadge } from '@/components/projected-transaction-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { MonthPicker } from '@/components/ui/monthpicker'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts'
import { CheckCircle2, CalendarIcon, Clock, Paperclip, ArrowUpDown, HelpCircle, EyeClosed, AlertCircle } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/page-header'
import { CategoryIcon } from '@/components/category-icon'
import { AccountIcon } from '@/components/account-icon'
import { TransactionDrillDown, type DrillDownFilter } from '@/components/transaction-drill-down'
import { TransactionDialog, type TransactionSavePayload } from '@/components/transaction-dialog'
import { extractApiError } from '@/lib/api-errors'
import { TransactionCalendarView } from '@/components/transaction-calendar-view'
import { TransactionsViewSwitcher, type TransactionsViewMode } from '@/components/transactions-view-switcher'
import { RuleDialog, type RuleDialogInitialData } from '@/components/rule-dialog'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useIsMobile } from '@/hooks/use-mobile'
import { useAuth } from '@/contexts/auth-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { resolveDateFnsLocale } from '@/lib/date-fns-locale'
import type { Rule, Transaction } from '@/types'
import { formatCurrency } from '@/lib/format'
import { shouldShowPendingBadge } from '@/lib/transaction-status'

function formatDate(dateStr: string, locale = 'pt-BR') {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(locale)
}

function parseHashtags(notes: string | null): string[] {
  if (!notes) return []
  const matches = notes.match(/#[\w\u00C0-\u017E-]+/g)
  return matches ?? []
}

const MONTH_REGEX = /^\d{4}-\d{2}$/
const MONTH_STRING_LENGTH = 7

function parseMonthFromParams(params: URLSearchParams): string | null {
  const monthParam = params.get('month')
  if (monthParam && MONTH_REGEX.test(monthParam)) {
    return monthParam
  }

  const fromParam = params.get('from')
  if (fromParam && fromParam.length >= MONTH_STRING_LENGTH) {
    const parsedMonth = fromParam.substring(0, MONTH_STRING_LENGTH)
    if (MONTH_REGEX.test(parsedMonth)) {
      return parsedMonth
    }
  }

  return null
}


export default function DashboardPage() {
  const { t, i18n } = useTranslation()
  const { mask, privacyMode, MASK } = usePrivacyMode()
  const isMobile = useIsMobile()
  const { user } = useAuth()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const displayName = user?.preferences?.display_name || ''
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()

  const greeting = (() => {
    const hour = new Date().getHours()
    const key = hour < 12 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : 'greetingEvening'
    const base = t(`dashboard.${key}`)
    return displayName ? `${base}, ${displayName}` : base
  })()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    return parseMonthFromParams(searchParams) ?? currentMonth()
  })
  const [drillDown, setDrillDown] = useState<DrillDownFilter | null>(null)
  // Transactions section view, mirroring the transactions page: the choice
  // lives in the URL so the section can be refreshed, bookmarked or shared.
  const [txViewMode, setTxViewMode] = useState<TransactionsViewMode>(() => (
    searchParams.get('view') === 'calendar' ? 'calendar' : 'list'
  ))
  const [calendarSelectedDate, setCalendarSelectedDate] = useState<string>(() => searchParams.get('day') ?? '')

  const prevSearchRef = useRef<string | null>(null)

  // Sync state from URL when navigating (e.g. back/forward button)
  useEffect(() => {
    const search = searchParams.toString()
    if (prevSearchRef.current === search) return
    const isInitial = prevSearchRef.current === null
    prevSearchRef.current = search

    const parsedMonth = parseMonthFromParams(searchParams)
    if (parsedMonth) {
      setSelectedMonth(parsedMonth)
    } else if (!isInitial) {
      setSelectedMonth(currentMonth())
    }
    setTxViewMode(searchParams.get('view') === 'calendar' ? 'calendar' : 'list')
    setCalendarSelectedDate(searchParams.get('day') ?? '')
  }, [searchParams])

  // Sync selectedMonth and the transactions view back to URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (selectedMonth) {
      params.set('month', selectedMonth)
      params.delete('from')
      params.delete('to')
    } else {
      params.delete('month')
    }

    if (txViewMode === 'calendar') {
      params.set('view', 'calendar')
      if (calendarSelectedDate) params.set('day', calendarSelectedDate)
      else params.delete('day')
    } else {
      params.delete('view')
      params.delete('day')
    }

    setSearchParams(params, { replace: true })
  }, [selectedMonth, txViewMode, calendarSelectedDate, setSearchParams])
  const [editingTx, setEditingTx] = useState<Transaction | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createRuleOpen, setCreateRuleOpen] = useState(false)
  const [createRuleInitialData, setCreateRuleInitialData] = useState<RuleDialogInitialData | undefined>(undefined)
  const queryClient = useQueryClient()
  const [headerCalOpen, setHeaderCalOpen] = useState(false)
  const [hoveredDay, setHoveredDay] = useState<number | null>(null)
  const dateFnsLocale = resolveDateFnsLocale(i18n.resolvedLanguage ?? i18n.language)
  const { from: monthStart, to: monthEnd } = monthRange(selectedMonth)
  const monthParam = monthStart
  const uiLocale = i18n.resolvedLanguage ?? i18n.language
  const monthLabelStr = monthLabel(selectedMonth, uiLocale)

  const handleMonthChange = (newMonth: string) => {
    setSelectedMonth(newMonth)
}

  // Active Collection filter (issue #105): scope dashboard cards to its
  // accounts. undefined when "All accounts".
  const { activeAccountIds, activeWalletIds } = useCollectionFilter()
  const acctIds = activeAccountIds ?? undefined
  const walletIds = activeWalletIds ?? undefined
  // A wallet-only collection (active, but with zero accounts) has no account
  // data — skip the account-only cards so they render empty instead of
  // silently falling back to "all accounts".
  const noAccounts = activeAccountIds !== null && activeAccountIds.length === 0

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['dashboard', 'summary', selectedMonth, activeAccountIds, activeWalletIds],
    queryFn: () => dashboard.summary(monthParam, undefined, acctIds, walletIds),
  })

  const { data: spending, isLoading: spendingLoading } = useQuery({
    queryKey: ['dashboard', 'spending', selectedMonth, activeAccountIds],
    queryFn: () => dashboard.spendingByCategory(monthParam, acctIds),
    enabled: !noAccounts,
  })

  const prevMonth = shiftMonth(selectedMonth, -1)

  const { data: balanceHistory, isLoading: balanceHistoryLoading } = useQuery({
    queryKey: ['dashboard', 'balance-history', selectedMonth, activeAccountIds],
    queryFn: () => dashboard.balanceHistory(monthParam, acctIds),
    enabled: !noAccounts,
  })

  const { data: currentMonthTxs, isLoading: currentTxLoading } = useQuery({
    queryKey: ['transactions', 'cumulative', selectedMonth, activeAccountIds],
    queryFn: () => transactions.list({
      from: monthStart,
      to: monthEnd,
      limit: 500,
      exclude_transfers: true,
      account_ids: acctIds,
    }),
    enabled: !noAccounts,
  })

  // Same month grid the transactions page renders, scoped to the active
  // collection's accounts. Only fetched while the calendar is on screen.
  const calendarAccountIds = acctIds && acctIds.length > 0 ? acctIds : undefined
  const { data: calendarData, isLoading: calendarLoading } = useQuery({
    queryKey: ['transactions', 'calendar', selectedMonth, activeAccountIds],
    enabled: txViewMode === 'calendar' && !noAccounts,
    queryFn: () => transactions.calendar({
      month: monthStart,
      account_ids: calendarAccountIds,
    }),
  })

  const { data: projectedTxs, isLoading: projectedTxLoading } = useQuery({
    queryKey: ['dashboard', 'projected-transactions', selectedMonth],
    queryFn: () => dashboard.projectedTransactions({ month: monthParam }),
  })

  const { data: categoriesList } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  })

  const { data: categoryGroupsList } = useQuery({
    queryKey: ['categoryGroups'],
    queryFn: categoryGroupsApi.list,
  })

  const { data: accountsList, isLoading: accountsLoading, isError: accountsError } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
  })

  const { data: payeesList } = useQuery({
    queryKey: ['payees'],
    queryFn: payeesApi.list,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: TransactionSavePayload & { id: string }) =>
      transactions.update(id, data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingTx(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => transactions.delete(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingTx(null)
    },
  })

  const unlinkTransferMutation = useMutation({
    mutationFn: (pairId: string) => transactions.unlinkTransfer(pairId),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingTx(null)
    },
  })

  const createRuleMutation = useMutation({
    mutationFn: (data: Omit<Rule, 'id' | 'user_id'>) => rulesApi.create(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      setCreateRuleOpen(false)
      setCreateRuleInitialData(undefined)
      const applied = result.applied_count ?? 0
      if (applied > 0) {
        invalidateFinancialQueries(queryClient)
        queryClient.invalidateQueries({ queryKey: ['payees'] })
        toast.success(t('rules.createdAndApplied', { count: applied }))
      } else {
        toast.success(t('rules.created'))
      }
    },
    onError: (error: unknown) => {
      const err = error as { response?: { status?: number } }
      if (err?.response?.status === 409) {
        toast.error(t('rules.duplicateName'))
      } else {
        toast.error(t('common.error'))
      }
    },
  })

  const handleCreateRuleFromTransaction = (tx: Transaction) => {
    const conditions = [
      { field: 'description', op: 'contains', value: tx.description },
    ]
    if (tx.payee_id) {
      conditions.push({ field: 'payee_id', op: 'equals', value: tx.payee_id })
    }
    const actions = tx.category_id
      ? [{ op: 'set_category', value: tx.category_id }]
      : [{ op: 'set_category', value: '' }]
    const tags = parseHashtags(tx.notes)
    if (tags.length > 0) {
      actions.push({ op: 'append_notes', value: tags.join(' ') })
    }
    setCreateRuleInitialData({ conditions, actions })
    setCreateRuleOpen(true)
  }

  // Calendar rows carry only an id, so the full transaction is fetched before
  // the edit dialog opens (same as the transactions page).
  const handleOpenCalendarTransaction = async (id: string) => {
    try {
      const tx = await transactions.get(id)
      setEditingTx(tx)
      setDialogOpen(true)
    } catch {
      toast.error(t('common.error'))
    }
  }


  const cumulativeData = useMemo(() => {
    if (!balanceHistory) return []
    const daysInMonth = monthLastDay(selectedMonth)
    const result: { day: number; current: number | null; previous: number }[] = []
    let lastPrevBalance = 0
    for (let day = 1; day <= daysInMonth; day++) {
      const cur = balanceHistory.current.find(d => d.day === day)
      const prev = balanceHistory.previous.find(d => d.day === day)
      if (prev?.balance != null) {
        lastPrevBalance = prev.balance
      }
      result.push({
        day,
        current: cur?.balance ?? null,
        previous: prev?.balance ?? lastPrevBalance,
      })
    }
    return result
  }, [balanceHistory, selectedMonth])

  const lastCurrentPoint = [...cumulativeData].reverse().find(d => d.current !== null)
  const lastDay = lastCurrentPoint?.day ?? 0
  const currentStartBalance = balanceHistory?.current.find(d => d.day === 1)?.balance ?? 0
  const currentLatestBalance = lastCurrentPoint?.current ?? 0
  const monthVariation = currentLatestBalance - currentStartBalance

  const primaryCurrency = summary?.primary_currency ?? userCurrency
  const totalBalance = summary?.total_balance_primary ?? Object.values(summary?.total_balance ?? {}).reduce((a, b) => a + Number(b), 0)
  const projectedBalance = summary?.projected_balance_primary ?? Object.values(summary?.projected_balance ?? {}).reduce((a, b) => a + Number(b), 0)
  const hasProjectedBalance = Math.abs(projectedBalance - totalBalance) >= 0.01
  const assetsValue = summary?.assets_value_primary ?? Object.values(summary?.assets_value ?? {}).reduce((a, b) => a + b, 0)

  // Available balance: checking/savings accounts only — what's actually
  // spendable today, as opposed to `totalBalance` (net worth: accounts +
  // investments - open card bills). Scoped to the active Collection filter,
  // same as the rest of the dashboard.
  const availableBalanceAccounts = useMemo(() => {
    const all = accountsList ?? []
    const scoped = activeAccountIds ? all.filter((a) => activeAccountIds.includes(a.id)) : all
    return scoped.filter((a) => a.type === 'checking' || a.type === 'savings')
  }, [accountsList, activeAccountIds])
  const availableBalance = availableBalanceAccounts.reduce(
    (sum, a) => sum + Number(a.balance_primary ?? a.current_balance), 0,
  )
  const sortedAvailableBalanceAccounts = useMemo(
    () => sortAccountsByAbsoluteBalance(availableBalanceAccounts, (a) => a.balance_primary ?? a.current_balance),
    [availableBalanceAccounts],
  )
  // While accounts are loading or failed to load, treat their balance
  // components as unavailable rather than silently rendering zero.
  const accountsUnavailable = accountsLoading || accountsError
  const creditCardBalance = sumAccountBalances((accountsList ?? [])
    .filter((a) => (activeAccountIds ? activeAccountIds.includes(a.id) : true) && a.type === 'credit_card'))
  // Net worth's "Available balance" breakdown row: every non-card account
  // (unlike the headline `availableBalance`, which is checking/savings only),
  // so it reconciles with `totalBalance` — which sums all account types.
  const nonCardAccountsBalance = (accountsList ?? [])
    .filter((a) => (activeAccountIds ? activeAccountIds.includes(a.id) : true) && a.type !== 'credit_card')
    .reduce((sum, a) => sum + Number(a.balance_primary ?? a.current_balance), 0)

  // Savings rate & projection
  const income = Number(summary?.monthly_income_primary ?? summary?.monthly_income ?? 0)
  const expenses = Number(summary?.monthly_expenses_primary ?? summary?.monthly_expenses ?? 0)
  // What the month is still expected to close at, once recurring entries that
  // have not posted yet are counted. Rendered only when it differs from the
  // realised figure, so a month with nothing pending stays quiet.
  const projectedIncome = Number(summary?.projected_income_primary ?? summary?.projected_income ?? income)
  const projectedExpenses = Number(summary?.projected_expenses_primary ?? summary?.projected_expenses ?? expenses)
  const savingsRate = income > 0 ? ((income - expenses) / income) * 100 : 0
  const isCurrentMonth = selectedMonth === currentMonth()
  const daysElapsed = isCurrentMonth ? new Date().getDate() : monthLastDay(selectedMonth)
  const daysInMonth = monthLastDay(selectedMonth)
  const projectedSpend = expenses > 0 && isCurrentMonth && daysElapsed > 0
    ? (expenses / daysElapsed) * daysInMonth
    : null

  // Uncategorized data
  const uncategorizedCount = summary?.pending_categorization ?? 0
  const uncategorizedAmount = summary?.pending_categorization_amount ?? 0

  const [catSortDesc, setCatSortDesc] = useState(true)

  // Merged category bars data
  const mergedCategories = useMemo(() => {
    if (!spending) return []
    return spending
      .filter(s => s.category_id !== null)
      .map(s => {
        // The category widget must show the same spend set as its drill-down:
        // settled transactions plus pending/future rows and recurring
        // projections. The API keeps `total` as settled-only for callers that
        // need the actual/forecast split, while `projected_total` is the
        // user-visible all-in amount.
        const actual = s.projected_total
        return {
          category_id: s.category_id!,
          category_name: s.category_name,
          category_icon: s.category_icon,
          category_color: s.category_color,
          actual,
        }
      })
      .sort((a, b) => catSortDesc ? b.actual - a.actual : a.actual - b.actual)
  }, [spending, catSortDesc])

  const [txPage, setTxPage] = useState(1)
  const [txSortDesc, setTxSortDesc] = useState(true)
  useEffect(() => setTxPage(1), [selectedMonth])

  type DisplayRow = {
    key: string
    description: string
    date: string
    type: 'debit' | 'credit'
    amount: number
    amountPrimary: number | null
    currency: string
    categoryIcon: string | null
    categoryName: string | null
    categoryColor: string | null
    accountId: string | null
    isProjected: boolean
    attachmentCount: number
    isIgnored: boolean
    installmentNumber: number | null
    totalInstallments: number | null
    showPendingBadge: boolean
  }

  const [txPerPage, setTxPerPage] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('securo.dashboard.pageSize')
      return stored ? Number(stored) : 10
    } catch {
      return 10
    }
  })
  const allDisplayRows = useMemo(() => {
    const rows: DisplayRow[] = []
    for (const tx of currentMonthTxs?.items ?? []) {
      rows.push({
        key: tx.id,
        description: tx.description,
        date: tx.date,
        type: tx.type,
        amount: Number(tx.amount),
        amountPrimary: tx.amount_primary != null ? Number(tx.amount_primary) : null,
        currency: tx.currency,
        categoryIcon: tx.category?.icon ?? null,
        categoryName: tx.category?.name ?? null,
        categoryColor: tx.category?.color ?? null,
        accountId: tx.account_id ?? null,
        isProjected: false,
        attachmentCount: tx.attachment_count ?? 0,
        isIgnored: tx.is_ignored,
        installmentNumber: tx.installment_number,
        totalInstallments: tx.total_installments,
        showPendingBadge: shouldShowPendingBadge(tx),
      })
    }
    for (const pt of projectedTxs ?? []) {
      rows.push({
        key: `proj-${pt.recurring_id}-${pt.date}`,
        description: pt.description,
        date: pt.date,
        type: pt.type,
        amount: pt.amount,
        amountPrimary: pt.amount_primary ?? null,
        currency: pt.currency,
        categoryIcon: pt.category_icon,
        categoryName: pt.category_name,
        categoryColor: pt.category_color ?? null,
        accountId: pt.account_id,
        isProjected: true,
        attachmentCount: 0,
        isIgnored: false,
        installmentNumber: null,
        totalInstallments: null,
        showPendingBadge: false,
      })
    }
    rows.sort((a, b) => txSortDesc ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date))
    return rows
  }, [currentMonthTxs, projectedTxs, txSortDesc])

  const txTotalPages = Math.ceil(allDisplayRows.length / txPerPage)
  const pagedRows = allDisplayRows.slice((txPage - 1) * txPerPage, txPage * txPerPage)
  const txListLoading = currentTxLoading || projectedTxLoading

  // Savings rate display
  const savingsRateColor = income === 0 && expenses > 0
    ? 'text-rose-500'
    : savingsRate > 0
      ? 'text-emerald-600'
      : savingsRate < 0
        ? 'text-rose-500'
        : 'text-muted-foreground'

  const savingsRateDisplay = income === 0 && expenses > 0
    ? '---'
    : `${savingsRate.toFixed(0)}%`

  return (
    <div>
      {/* Header */}
      <PageHeader
        section={greeting}
        title={monthLabel(selectedMonth, uiLocale).replace(/^\w/, c => c.toUpperCase())}
        action={
          <div className="flex items-center gap-1">
            <button
              className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:border-border hover:text-foreground transition-all text-base"
              onClick={() => handleMonthChange(shiftMonth(selectedMonth, -1))}
            >&#8249;</button>
            <Popover open={headerCalOpen} onOpenChange={setHeaderCalOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-2 border border-border rounded-lg px-3 py-1.5 text-sm bg-card text-foreground hover:bg-muted/50 transition-all cursor-pointer min-w-[180px]"
                >
                  <CalendarIcon className="size-3.5 text-muted-foreground" />
                  {monthLabel(selectedMonth, uiLocale).replace(/^\w/, c => c.toUpperCase())}
                </button>
              </PopoverTrigger>
              <PopoverContent align="center" className="w-auto p-0">
                <MonthPicker
                  locale={dateFnsLocale}
                  selectedMonth={new Date(`${selectedMonth}-01T00:00:00`)}
                  onMonthSelect={(date) => {
                    if (!date) return
                    const newMonth = format(date, 'yyyy-MM')
                    setSelectedMonth(newMonth)
                    setHeaderCalOpen(false)
                  }}
                />
              </PopoverContent>
            </Popover>
            <button
              className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:border-border hover:text-foreground transition-all text-base"
              onClick={() => handleMonthChange(shiftMonth(selectedMonth, 1))}
            >&#8250;</button>
          </div>
        }
      />

      {/* Hero Card: Available Balance + secondary indicators */}
      <div className="bg-card rounded-xl border border-border shadow-sm mb-5 px-5 pt-5 pb-4">
        {/* Available balance in checking/savings accounts */}
        <div className="pb-4 mb-4 border-b border-border">
          <p className="text-xs font-semibold text-muted-foreground mb-1">{t('dashboard.availableBalance')}</p>
          {summaryLoading || accountsUnavailable ? (
            <Skeleton className="h-9 w-40" />
          ) : (
            <>
              {/* Neutral while positive. Size and weight carry the headline;
                  colour is left to mean direction (income, expenses) and
                  exception (a negative balance), so it still says something
                  when it does appear. */}
              <p className={`text-3xl font-bold tabular-nums leading-tight ${availableBalance < 0 ? 'text-rose-500' : 'text-foreground'}`}>
                {mask(formatCurrency(availableBalance, primaryCurrency, locale))}
              </p>
              {sortedAvailableBalanceAccounts.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {sortedAvailableBalanceAccounts.map((acc) => {
                    const bal = Number(acc.balance_primary ?? acc.current_balance)
                    const balCurrency = acc.balance_primary != null ? primaryCurrency : acc.currency
                    // A link, not a click handler: the chip is a navigation
                    // target, so it gets keyboard focus and cmd-click into a
                    // new tab for free. Scale on hover only, which the
                    // compositor handles without touching layout.
                    return (
                      <Link
                        key={acc.id}
                        to={`/accounts/${acc.id}`}
                        className="group inline-flex items-center gap-1 text-[11px] pl-1 pr-2 py-0.5 rounded-full border border-border bg-background transition-transform duration-150 ease-out hover:scale-105 hover:border-foreground/25 focus:outline-none focus-visible:ring-ring/30 focus-visible:ring-[2px]"
                      >
                        {/* The bank mark is what the eye actually sorts on in a
                            row of chips; the name is the confirmation. Falls
                            back to the account-type icon, so manual accounts
                            and providers without a logo still line up. */}
                        <AccountIcon account={acc} size="xs" className="w-4 h-4 rounded-md" />
                        {/* getAccountLabel, not getAccountName: two accounts can
                            share a name, and the mask suffix is what tells them
                            apart in a row of chips. */}
                        <span className="text-muted-foreground group-hover:text-foreground transition-colors">{getAccountLabel(acc)}</span>
                        <span className={`font-semibold tabular-nums ${bal < 0 ? 'text-rose-500' : 'text-foreground'}`}>
                          {mask(formatCurrency(bal, balCurrency, locale))}
                        </span>
                      </Link>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Secondary indicators */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-4">
          {/* Income */}
          <button
            type="button"
            className="min-w-0 text-left cursor-pointer hover:opacity-70 transition-opacity"
            onClick={() => setDrillDown({
              title: t('dashboard.drillDownIncome', { month: monthLabelStr }),
              type: 'credit',
              from: monthStart,
              to: monthEnd,
            })}
          >
            <p className="text-xs font-medium text-muted-foreground mb-1 min-h-[16px] flex items-center">{t('dashboard.monthlyIncome')}</p>
            {summaryLoading ? (
              <Skeleton className="h-6 w-20" />
            ) : (
              <>
                <p className="text-xl font-bold tabular-nums text-emerald-600">
                  +{mask(formatCurrency(income, primaryCurrency, locale))}
                </p>
                {Math.abs(projectedIncome - income) >= 0.01 && (
                  <p className="text-xs text-muted-foreground tabular-nums mt-1">
                    {t('dashboard.projectedIncome')} {mask(formatCurrency(projectedIncome, primaryCurrency, locale))}
                  </p>
                )}
              </>
            )}
          </button>

          {/* Expenses */}
          <button
            type="button"
            className="relative min-w-0 text-left cursor-pointer hover:opacity-70 transition-opacity before:content-[''] before:hidden sm:before:block before:absolute before:-left-2.5 before:top-1.5 before:bottom-1.5 before:w-px before:bg-border"
            onClick={() => setDrillDown({
              title: t('dashboard.drillDownExpenses', { month: monthLabelStr }),
              type: 'debit',
              from: monthStart,
              to: monthEnd,
            })}
          >
            <p className="text-xs font-medium text-muted-foreground mb-1 min-h-[16px] flex items-center">{t('dashboard.monthlyExpenses')}</p>
            {summaryLoading ? (
              <Skeleton className="h-6 w-20" />
            ) : (
              <>
                <p className="text-xl font-bold tabular-nums text-rose-500">
                  -{mask(formatCurrency(expenses, primaryCurrency, locale))}
                </p>
                {Math.abs(projectedExpenses - expenses) >= 0.01 && (
                  <p className="text-xs text-muted-foreground tabular-nums mt-1">
                    {t('dashboard.projectedExpenses')} {mask(formatCurrency(projectedExpenses, primaryCurrency, locale))}
                  </p>
                )}
              </>
            )}
          </button>

          {/* Net worth */}
          <div className="relative min-w-0 before:content-[''] before:hidden sm:before:block before:absolute before:-left-2.5 before:top-1.5 before:bottom-1.5 before:w-px before:bg-border">
            <p className="text-xs font-medium text-muted-foreground mb-1 min-h-[16px] flex items-center gap-1">
              {t('dashboard.netWorth')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground transition-colors text-[9px] font-bold leading-none"
                  >
                    i
                  </button>
                </TooltipTrigger>
                <TooltipContent className="w-56">
                  <p>{t('dashboard.netWorthTooltip')}</p>
                  <div className="mt-1.5 pt-1.5 border-t border-background/20 space-y-0.5">
                    <div className="flex justify-between gap-3">
                      <span>{t('dashboard.availableBalance')}</span>
                      <span>{mask(formatCurrency(nonCardAccountsBalance, primaryCurrency, locale))}</span>
                    </div>
                    {assetsValue > 0 && (
                      <div className="flex justify-between gap-3">
                        <span>{t('dashboard.assetsValue')}</span>
                        <span>{mask(formatCurrency(assetsValue, primaryCurrency, locale))}</span>
                      </div>
                    )}
                    {creditCardBalance !== 0 && (
                      <div className="flex justify-between gap-3">
                        <span>{t('dashboard.creditCardBalance')}</span>
                        <span>{mask(formatCurrency(creditCardBalance, primaryCurrency, locale))}</span>
                      </div>
                    )}
                    {hasProjectedBalance && (
                      <div className="flex justify-between gap-3">
                        <span>{t('dashboard.projectedBalance')}</span>
                        <span>{mask(formatCurrency(projectedBalance, primaryCurrency, locale))}</span>
                      </div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </p>
            {/* Net worth stays neutral so the secondary row does not out-shout
                the headline above it. It is the larger number here; colouring
                it too pulled the eye away from available balance. */}
            {summaryLoading || accountsUnavailable ? (
              <Skeleton className="h-6 w-24" />
            ) : (
              <p className={`text-lg sm:text-xl font-bold tabular-nums ${totalBalance < 0 ? 'text-rose-500' : 'text-foreground'}`}>
                {mask(formatCurrency(totalBalance, primaryCurrency, locale))}
              </p>
            )}
          </div>

          {/* Savings rate */}
          <div className="relative min-w-0 before:content-[''] before:hidden sm:before:block before:absolute before:-left-2.5 before:top-1.5 before:bottom-1.5 before:w-px before:bg-border">
            <p className="text-xs font-medium text-muted-foreground mb-1 min-h-[16px] flex items-center">{t('dashboard.savingsRate')}</p>
            {summaryLoading ? (
              <Skeleton className="h-6 w-16" />
            ) : (
              <>
                <p className={`text-xl font-bold tabular-nums ${savingsRateColor}`}>
                  {savingsRateDisplay}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('dashboard.savingsRateCaption')}</p>
              </>
            )}
          </div>
        </div>

        {/* Spending projection */}
        {projectedSpend !== null && !summaryLoading && (
          <p className="text-xs text-muted-foreground mt-3">
            {t('dashboard.spendingProjection', { amount: mask(formatCurrency(projectedSpend, primaryCurrency, locale)) })}
          </p>
        )}
      </div>

      {/* Uncategorized banner */}
      {!summaryLoading && (
        uncategorizedCount > 0 ? (
          <button
            type="button"
            className="w-full flex items-center justify-between gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg px-4 py-2.5 mb-5 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors"
            onClick={() => setDrillDown({
              title: t('dashboard.drillDownUncategorized'),
              uncategorized: true,
            })}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {/* An icon, not the count: the sentence beside it already states
                  the number, and a fixed 24px circle clipped it from four
                  digits on. Severity still reads through the tint. */}
              <AlertCircle
                size={16}
                className={`shrink-0 ${uncategorizedCount >= 20 ? 'text-amber-600 dark:text-amber-400' : 'text-amber-500 dark:text-amber-500'}`}
              />
              <span className="text-sm text-amber-900 dark:text-amber-200 truncate">
                {t('dashboard.uncategorizedCta', { count: uncategorizedCount })}
                {uncategorizedAmount > 0 && (
                  <span className="text-amber-700/70 dark:text-amber-300/70"> · {mask(formatCurrency(uncategorizedAmount, userCurrency, locale))}</span>
                )}
              </span>
            </div>
            <span className="shrink-0 text-sm font-semibold text-amber-600 dark:text-amber-400 hover:underline">
              {t('dashboard.categorizeNow')} &rarr;
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-lg px-4 py-2.5 mb-5">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            <span className="text-sm text-emerald-900 dark:text-emerald-200">{t('dashboard.allCategorized')}</span>
          </div>
        )
      )}

      {/* Charts: Category Spending Bars + Balance Evolution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5" style={{ gridAutoRows: 'minmax(380px, auto)' }}>
        {/* Category Spending Bars */}
        <div className="bg-card rounded-xl border border-border shadow-sm flex flex-col max-h-[420px]">
          <div className="px-5 py-4 border-b border-border shrink-0 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">{t('dashboard.spendingByCategory')}</p>
            <button
              onClick={() => setCatSortDesc(v => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <ArrowUpDown size={13} />
              {catSortDesc ? t('dashboard.sortHighest') : t('dashboard.sortLowest')}
            </button>
          </div>
          <div className="p-3 overflow-y-auto flex-1">
            {spendingLoading ? (
              <div className="space-y-3 p-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : mergedCategories.length > 0 ? (
              <div className="space-y-1.5">
                {mergedCategories.map((item) => {
                  return (
                    <div
                      key={item.category_id}
                      className="rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer"
                      onClick={() => setDrillDown({
                        title: t('dashboard.drillDownCategory', { category: item.category_name, month: monthLabelStr }),
                        category_id: item.category_id,
                        type: 'debit',
                        from: monthStart,
                        to: monthEnd,
                      })}
                    >
                      <div className="flex items-center gap-3">
                        <CategoryIcon icon={item.category_icon} color={item.category_color} size="lg" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-sm font-semibold text-foreground truncate">{item.category_name}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-sm font-bold tabular-nums text-foreground">{mask(formatCurrency(item.actual, userCurrency, locale))}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-12">{t('dashboard.noData')}</p>
            )}
          </div>
        </div>

        {/* Cumulative Spending Comparison */}
        <div className="bg-card rounded-xl border border-border shadow-sm max-h-[420px] flex flex-col">
          <div className="px-5 pt-5 pb-3 shrink-0">
            <div className="flex items-start justify-between mb-0.5">
              <div>
                <p className="text-base font-bold text-foreground">{t('dashboard.balanceFlow')}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(`${selectedMonth}-01T00:00:00`).toLocaleDateString(dateLocale)} → {new Date(`${selectedMonth}-${String(lastCurrentPoint?.day ?? monthLastDay(selectedMonth)).padStart(2, '0')}T00:00:00`).toLocaleDateString(dateLocale)}
                </p>
              </div>
              {!balanceHistoryLoading && lastCurrentPoint && (
                <div className="text-right">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{t('dashboard.balancePeriodVariation')}</p>
                  <span className={`text-lg font-bold tabular-nums ${monthVariation >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                    {mask(`${monthVariation > 0 ? '+' : ''}${formatCurrency(monthVariation, userCurrency, locale)}`)}
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 mt-2">
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block w-3 h-0.5 rounded-full bg-emerald-500" />
                {t('dashboard.balanceCurrentMonthLegend')}
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block w-3 border-t-2 border-dashed border-slate-400" />
                {t('dashboard.balancePreviousMonthLegend')}
              </span>
            </div>
          </div>
          <div className="px-1 pb-4 flex-1 min-h-0">
            {balanceHistoryLoading ? (
              <Skeleton className="h-full w-full" />
            ) : cumulativeData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={cumulativeData}
                  margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                  className="cursor-pointer"
                  onMouseMove={(state) => {
                    const idx = state?.activeTooltipIndex
                    if (typeof idx === 'number') {
                      const point = cumulativeData[idx]
                      if (point) setHoveredDay(point.day)
                    }
                  }}
                  onMouseLeave={() => setHoveredDay(null)}
                  onClick={(_state) => {
                    // Access activePayload from the underlying native event target chart state
                    const chartState = _state as unknown as { activePayload?: Array<{ payload: { day: number } }> }
                    const payload = chartState?.activePayload ?? []
                    if (payload[0]) {
                      const day = String(payload[0].payload.day).padStart(2, '0')
                      const dateStr = `${selectedMonth}-${day}`
                      setDrillDown({
                        title: t('dashboard.drillDownDay', { date: new Date(dateStr + 'T00:00:00').toLocaleDateString(dateLocale) }),
                        from: dateStr,
                        to: dateStr,
                      })
                    }
                  }}
                >
                  <defs>
                    <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10B981" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#10B981" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                    axisLine={false}
                    tickLine={false}
                    interval={3}
                  />
                  <YAxis
                    tickFormatter={(v) => {
                      if (privacyMode) return ''
                      if (v === 0) return '0'
                      return formatCurrency(v, userCurrency, locale).replace(/,00$/, '').replace(/\.00$/, '')
                    }}
                    tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                    tickCount={5}
                    domain={[
                      (dataMin: number) => dataMin < 0 ? Math.floor(dataMin / 100) * 100 : 0,
                      (dataMax: number) => Math.ceil(dataMax / 100) * 100,
                    ]}
                  />
                  <RechartsTooltip
                    formatter={(value, name) => [
                      value !== null ? (privacyMode ? MASK : formatCurrency(Number(value), userCurrency, locale)) : '\u2014',
                      name === 'current' ? monthLabel(selectedMonth, uiLocale).split(' ')[0] : monthLabel(prevMonth, uiLocale).split(' ')[0],
                    ]}
                    labelFormatter={(day) => t('dashboard.day', { day })}
                    contentStyle={{
                      background: 'var(--card)',
                      color: 'var(--foreground)',
                      border: '1px solid var(--border)',
                      borderRadius: '0.75rem',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                      fontSize: '12px',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="current"
                    stroke="#10B981"
                    strokeWidth={2}
                    fill="url(#cumGrad)"
                    dot={false}
                    activeDot={{ r: 3, fill: '#10B981' }}
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="previous"
                    stroke="#94A3B8"
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={false}
                    activeDot={{ r: 3, fill: '#94A3B8' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-12">{t('dashboard.noData')}</p>
            )}
          </div>
          {!balanceHistoryLoading && lastCurrentPoint && (() => {
            const footerDay = hoveredDay ?? lastDay
            const footerPrev = balanceHistory?.previous.find(d => d.day === footerDay)?.balance ?? 0
            const footerCurrent = cumulativeData.find(d => d.day === footerDay)?.current ?? totalBalance
            const footerPct = footerPrev !== 0 ? ((footerCurrent - footerPrev) / Math.abs(footerPrev)) * 100 : null
            if (footerPrev === 0 || footerPct === null) return null
            return (
              <div className="px-5 pb-4 pt-0 shrink-0">
                <p className="text-xs text-muted-foreground">
                  {t('dashboard.balanceFlowVsPrev', {
                    month: monthLabel(prevMonth, uiLocale).split(' ')[0],
                    day: footerDay,
                    amount: mask(formatCurrency(footerPrev, userCurrency, locale)),
                    delta: `${footerPct >= 0 ? '+' : ''}${footerPct.toFixed(1)}%`,
                  })}
                  {' '}
                  <span className={footerPct >= 0 ? 'text-emerald-600' : 'text-rose-500'}>
                    {footerPct >= 0 ? '\u25B2' : '\u25BC'}
                  </span>
                </p>
              </div>
            )
          })()}
        </div>
      </div>

      {/* Period Transactions */}
      <div>
        {/* One control bar for both views, so the switch never moves between them. */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">{t('dashboard.periodTransactions')}</p>
          <div className="flex items-center gap-3">
            <TransactionsViewSwitcher
              value={txViewMode}
              onChange={setTxViewMode}
              listLabel={t('transactions.listView')}
              calendarLabel={t('transactions.calendarView')}
            />
            {txViewMode === 'list' && (
              <button
                onClick={() => { setTxSortDesc(v => !v); setTxPage(1) }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <ArrowUpDown size={13} />
                {txSortDesc ? t('dashboard.sortNewest') : t('dashboard.sortOldest')}
              </button>
            )}
          </div>
        </div>

        {txViewMode === 'calendar' && (
          <TransactionCalendarView
            calendar={calendarData}
            isLoading={calendarLoading}
            locale={locale}
            dateLocale={dateLocale}
            mask={mask}
            selectedDate={calendarSelectedDate}
            onSelectedDateChange={setCalendarSelectedDate}
            onOpenTransaction={handleOpenCalendarTransaction}
            accounts={accountsList}
            userCurrency={userCurrency}
          />
        )}

        {txViewMode === 'list' && (
        <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
          {txListLoading ? (
            <div className="p-5 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : pagedRows.length > 0 ? (
            <>
              {isMobile ? (
                <div>
                  {pagedRows.map((row) => (
                    <div
                      key={row.key}
                      className={`flex items-center gap-3 pl-3 pr-3 py-3 border-b border-border last:border-0 bg-card ${
                        row.isProjected ? '' : 'cursor-pointer active:bg-muted/60'
                      }`}
                      onClick={() => {
                        if (row.isProjected) return
                        const tx = currentMonthTxs?.items.find((t) => t.id === row.key)
                        if (tx) { setEditingTx(tx); setDialogOpen(true) }
                      }}
                    >
                      {/* Category Icon */}
                      <div className="shrink-0">
                        <CategoryIcon icon={row.categoryIcon} color={row.categoryColor} size="md" />
                      </div>

                      {/* Content */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-semibold text-foreground truncate leading-tight">{row.description}</p>
                          {row.isProjected && (
                            <ProjectedTransactionBadge />
                          )}
                          {row.installmentNumber != null && row.totalInstallments != null && (
                            <span className="inline-flex items-center text-[9px] font-bold tabular-nums text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/20 border border-amber-200 dark:border-amber-500/30 px-1 py-0.5 rounded-full shrink-0">
                              {row.installmentNumber}/{row.totalInstallments}
                            </span>
                          )}
                          {row.showPendingBadge && (
                            <span
                              title={t('transactions.pending')}
                              className="shrink-0 inline-flex items-center justify-center rounded-full border border-amber-200 bg-amber-50 p-0.5 dark:border-amber-500/30 dark:bg-amber-500/10"
                            >
                              <Clock size={12} className="text-amber-500" role="img" aria-label={t('transactions.pending')} />
                            </span>
                          )}
                          {row.isIgnored && (
                            <EyeClosed className="h-3 w-3 text-gray-500 shrink-0" />
                          )}
                          {row.attachmentCount > 0 && (
                            <Paperclip size={11} className="text-muted-foreground shrink-0" />
                          )}
                        </div>
                        {row.accountId && (() => {
                          const acc = accountsList?.find((a) => a.id === row.accountId)
                          if (!acc) return null
                          return (
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <AccountIcon account={acc} size="xs" />
                              <span className="text-xs text-muted-foreground truncate">{getAccountName(acc)}</span>
                            </div>
                          )
                        })()}
                        {!row.accountId && (
                          <p className="text-xs text-muted-foreground mt-0.5">{formatDate(row.date, dateLocale)}</p>
                        )}
                      </div>

                      {/* Amount */}
                      <div className="shrink-0 text-right">
                        <span className={`text-sm font-bold tabular-nums ${row.isIgnored ? 'text-gray-500' : row.type === 'credit' ? 'text-emerald-600' : 'text-rose-500'}`}>
                          {mask(`${row.isIgnored ? ' ' : row.type === 'credit' ? '+' : '\u2212'}${formatCurrency(Math.abs(row.amount), row.currency, locale)}`)}
                        </span>
                        {row.currency !== userCurrency && row.amountPrimary != null && (
                          <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                            {mask(formatCurrency(Math.abs(row.amountPrimary), userCurrency, locale))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent">
                    <TableHead className="pl-5 text-xs font-medium text-muted-foreground hidden sm:table-cell">{t('transactions.date')}</TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground">{t('transactions.description')}</TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground hidden sm:table-cell">{t('transactions.account')}</TableHead>
                    <TableHead className="pr-5 text-right text-xs font-medium text-muted-foreground">{t('transactions.amount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedRows.map((row) => (
                    <TableRow
                      key={row.key}
                      className={`border-b border-border last:border-0 ${
                        row.isProjected
                          ? ''
                          : 'cursor-pointer hover:bg-muted'
                      }`}
                      onClick={() => {
                        if (row.isProjected) return
                        const tx = currentMonthTxs?.items.find((t) => t.id === row.key)
                        if (tx) { setEditingTx(tx); setDialogOpen(true) }
                      }}
                    >
                      <TableCell className="py-2.5 pl-5 text-sm text-muted-foreground tabular-nums whitespace-nowrap hidden sm:table-cell">
                        {formatDate(row.date, dateLocale)}
                      </TableCell>
                      <TableCell className="py-2.5 pl-5 sm:pl-0">
                        <div className="flex items-center gap-3">
                          <CategoryIcon icon={row.categoryIcon} color={row.categoryColor} size="lg" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold text-foreground truncate">{row.description}</p>
                              {row.isProjected && (
                                <ProjectedTransactionBadge />
                              )}
                              {row.installmentNumber != null && row.totalInstallments != null && (
                                <span className="inline-flex items-center text-[10px] font-bold tabular-nums text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/20 border border-amber-200 dark:border-amber-500/30 px-1.5 py-0.5 rounded-full shrink-0">
                                  {row.installmentNumber}/{row.totalInstallments}
                                </span>
                              )}
                              {row.showPendingBadge && (
                                <span
                                  title={t('transactions.pending')}
                                  className="shrink-0 inline-flex items-center justify-center rounded-full border border-amber-200 bg-amber-50 p-0.5 dark:border-amber-500/30 dark:bg-amber-500/10"
                                >
                                  <Clock size={12} className="text-amber-500" role="img" aria-label={t('transactions.pending')} />
                                </span>
                              )}
                              {row.isIgnored && (
                                <span className="ml-2 inline-flex items-center gap-1 text-xs text-gray-600 font-normal bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">
                                <EyeClosed className="h-3 w-3" />
                                {t('transactions.ignored')}
                                <span title={t('transactions.ignoreTransferHint')}><HelpCircle className="h-3 w-3 text-blue-400" /></span>
                                </span>
                              )}
                              {row.attachmentCount > 0 && (
                                <Paperclip size={12} className="text-muted-foreground shrink-0" />
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground sm:hidden">{formatDate(row.date, dateLocale)}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-2.5 text-sm text-muted-foreground hidden sm:table-cell">
                        {(() => {
                          const acc = row.accountId
                            ? accountsList?.find((a) => a.id === row.accountId)
                            : undefined
                          if (!acc) return <span className="text-muted-foreground">—</span>
                          return (
                            <span className="flex items-center gap-2 min-w-0">
                              <AccountIcon account={acc} size="sm" />
                              <span className="truncate">{getAccountName(acc)}</span>
                            </span>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="py-2.5 pr-5 text-right">
                        <span className={`text-sm font-semibold tabular-nums ${row.isIgnored ? 'text-gray-500' : row.type === 'credit' ? 'text-emerald-600' : 'text-rose-500'}`}>
                          {mask(`${row.isIgnored ? ' ' : row.type === 'credit' ? '+' : '-'}${formatCurrency(Math.abs(row.amount), row.currency, locale)}`)}
                        </span>
                        {row.currency !== userCurrency && row.amountPrimary != null && (
                          <span className="block text-[10px] text-muted-foreground tabular-nums">
                            {mask(formatCurrency(Math.abs(row.amountPrimary), userCurrency, locale))}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              )}
              {allDisplayRows.length > 10 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-5 py-4 border-t border-border">
                  <div className="hidden sm:block w-32" />
                  {txTotalPages > 1 ? (
                    <div className="flex items-center justify-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={txPage <= 1}
                        onClick={() => setTxPage(txPage - 1)}
                      >
                        {t('dashboard.previous')}
                      </Button>
                      <span className="text-sm text-muted-foreground">
                        {txPage} / {txTotalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={txPage >= txTotalPages}
                        onClick={() => setTxPage(txPage + 1)}
                      >
                        {t('dashboard.next')}
                      </Button>
                    </div>
                  ) : (
                    <div className="hidden sm:block" />
                  )}

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{t('common.rowsPerPage', 'Rows per page')}</span>
                    <Select
                      value={String(txPerPage)}
                      onValueChange={(val) => {
                        const nextLimit = Number(val)
                        setTxPerPage(nextLimit)
                        setTxPage(1)
                        try {
                          localStorage.setItem('securo.dashboard.pageSize', String(nextLimit))
                        } catch {
                          // ignored
                        }
                      }}
                    >
                      <SelectTrigger className="w-[70px] h-8 text-xs">
                        <SelectValue placeholder={txPerPage} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="20">20</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-sm text-center py-8">{t('dashboard.noTransactions')}</p>
          )}
        </div>
        )}
      </div>

      <TransactionDrillDown
        filter={
          drillDown
            ? {
                ...drillDown,
                // Keep drill-downs consistent with the collection-scoped cards
                // they open from (e.g. "Categorize now").
                account_ids:
                  drillDown.account_ids ?? (acctIds && acctIds.length > 0 ? acctIds : undefined),
              }
            : null
        }
        onClose={() => setDrillDown(null)}
        onTransactionClick={(tx) => { setEditingTx(tx); setDialogOpen(true) }}
      />

      <TransactionDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingTx(null) }}
        transaction={editingTx}
        categories={categoriesList ?? []}
        categoryGroups={categoryGroupsList ?? []}
        accounts={(accountsList ?? []).map((a: { id: string; name: string; display_name?: string | null }) => ({ id: a.id, name: getAccountName(a) }))}
        onSave={(data) => {
          if (editingTx) updateMutation.mutate({ id: editingTx.id, ...data })
        }}
        onDelete={() => {
          if (editingTx) deleteMutation.mutate(editingTx.id)
        }}
        onUnlinkTransfer={(pairId) => unlinkTransferMutation.mutate(pairId)}
        onCreateRule={(tx) => {
          setDialogOpen(false)
          setEditingTx(null)
          handleCreateRuleFromTransaction(tx)
        }}
        loading={updateMutation.isPending || deleteMutation.isPending || unlinkTransferMutation.isPending}
        error={updateMutation.error ? extractApiError(updateMutation.error) : deleteMutation.error ? extractApiError(deleteMutation.error) : null}
        isSynced={editingTx?.source === 'sync'}
      />

      <RuleDialog
        key={createRuleOpen ? 'rule-open' : 'rule-closed'}
        open={createRuleOpen}
        onClose={() => { setCreateRuleOpen(false); setCreateRuleInitialData(undefined) }}
        rule={null}
        categories={categoriesList ?? []}
        categoryGroups={categoryGroupsList ?? []}
        accounts={(accountsList ?? []).map((a: { id: string; name: string; display_name?: string | null }) => ({ id: a.id, name: getAccountName(a) }))}
        payees={payeesList ?? []}
        onSave={(data) => createRuleMutation.mutate(data as Omit<Rule, 'id' | 'user_id'>)}
        loading={createRuleMutation.isPending}
        initialData={createRuleInitialData}
      />
    </div>
  )
}
