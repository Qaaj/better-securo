import { screen, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MonthlyReviewPanel } from '@/components/monthly-review'
import { renderWithProviders } from '@/test/utils'
import type { MonthlyReview } from '@/types'

const api = vi.hoisted(() => ({ reports: { monthlyReview: vi.fn() } }))
vi.mock('@/lib/api', () => ({ reports: api.reports }))
vi.mock('@/hooks/use-display-locale', () => ({ useDisplayLocale: () => 'en-US', useDateLocale: () => 'en-US' }))
vi.mock('@/hooks/use-privacy-mode', () => ({ usePrivacyMode: () => ({ mask: (v: string) => v, privacyMode: false, MASK: '••••' }) }))

const figures = (income: number, expenses: number) => ({ income, expenses, saved: income - expenses, savings_rate: income ? (income - expenses) / income : null })

function review(over: Partial<MonthlyReview> = {}): MonthlyReview {
  return {
    month: '2026-06-01', currency: 'EUR',
    this_month: figures(3000, 2400), previous_month: figures(3000, 2000), usual: figures(3000, 2000), usual_months: 12,
    categories: [
      { category_id: 'food', name: 'Groceries', icon: null, color: '#10B981', amount: 900, usual: 600, delta: 300, share: 0.375 },
      { category_id: 'bus', name: 'Transport', icon: null, color: '#6366F1', amount: 100, usual: 200, delta: -100, share: 0.0417 },
      { category_id: null, name: null, icon: null, color: null, amount: 1400, usual: 1200, delta: 200, share: 0.5833 },
    ],
    movers_up: [{ category_id: 'food', name: 'Groceries', icon: null, color: null, amount: 900, usual: 600, delta: 300, share: 0.375 }],
    movers_down: [{ category_id: 'bus', name: 'Transport', icon: null, color: null, amount: 100, usual: 200, delta: -100, share: 0.04 }],
    new_merchants: [{ name: 'Brand New Gadget', amount: 400, count: 1 }],
    large_transactions: [{ id: 't1', date: '2026-06-08', description: 'Brand New Gadget', amount: 400, category_name: null }],
    recurring_expenses: 1200, other_expenses: 1200, uncategorized_expenses: 1400, uncategorized_share: 0.5833,
    moved_between_accounts: 700, moved_count: 2,
    year: [{ month: '2026-05', income: 3000, expenses: 2000, saved: 1000 }, { month: '2026-06', income: 3000, expenses: 2400, saved: 600 }],
    insights: [],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.reports.monthlyReview.mockResolvedValue(review())
})

it('says in words how the month went against the usual month', async () => {
  renderWithProviders(<MonthlyReviewPanel />)
  expect(await screen.findByText(/You spent €2,400\. That is 20% more than your usual month \(€2,000\)\. You earned €3,000 and kept €600 of it\./)).toBeInTheDocument()
  expect(screen.getByText('↑ 20% vs usual')).toBeInTheDocument() // spending up: shown as bad
})

it('lists where the money went, links categories to their transactions and flags what is not categorized', async () => {
  renderWithProviders(<MonthlyReviewPanel />)
  const groceries = await screen.findByRole('link', { name: /Groceries/ })
  expect(groceries).toHaveAttribute('href', expect.stringContaining('/transactions?category_id=food&from='))
  expect(screen.getByText('Not categorized')).toBeInTheDocument()
  expect(screen.getByText(/58% of this month's spending/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Categorize it' })).toHaveAttribute('href', '/categories?tab=automate')
})

it('shows what changed: movers, new merchants and the biggest purchases', async () => {
  renderWithProviders(<MonthlyReviewPanel />)
  await screen.findByText('What changed?')
  expect(screen.getByText('Spending more on')).toBeInTheDocument()
  expect(screen.getByText('Spending less on')).toBeInTheDocument()
  expect(screen.getByText('New this month')).toBeInTheDocument()
  expect(screen.getAllByText('Brand New Gadget').length).toBeGreaterThanOrEqual(2)
})

it('splits recurring bills from the rest and says what was left out as transfers', async () => {
  renderWithProviders(<MonthlyReviewPanel />)
  await screen.findByText('Fixed or flexible?')
  expect(screen.getByText(/Recurring bills: €1,200 \(50%\)/)).toBeInTheDocument()
  expect(screen.getByText(/€700 moved between your own accounts \(2 transfers\)/)).toBeInTheDocument()
})

it('has a table of the year so far with a total', async () => {
  renderWithProviders(<MonthlyReviewPanel />)
  const table = (await screen.findByText('2026 so far')).closest('div')!.parentElement!.querySelector('table')!
  expect(within(table).getByText('Total')).toBeInTheDocument()
  expect(within(table).getAllByRole('row')).toHaveLength(1 + 2 + 1) // header, two months, total
})

it('steps between months and will not go past the current one', async () => {
  const { user } = renderWithProviders(<MonthlyReviewPanel />)
  await screen.findByText(/You spent/)
  expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled()
  const first = api.reports.monthlyReview.mock.calls[0][0] as string
  await user.click(screen.getByRole('button', { name: 'Previous month' }))
  await vi.waitFor(() => expect(api.reports.monthlyReview).toHaveBeenCalledTimes(2))
  expect(api.reports.monthlyReview.mock.calls[1][0]).not.toBe(first)
  expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled()
})

it('says so when there is not enough history, and when the month is empty', async () => {
  api.reports.monthlyReview.mockResolvedValue(review({ usual: null, previous_month: null, usual_months: 0, movers_up: [], movers_down: [] }))
  const { unmount } = renderWithProviders(<MonthlyReviewPanel />)
  expect(await screen.findByText(/not enough earlier history/)).toBeInTheDocument()
  unmount()

  api.reports.monthlyReview.mockResolvedValue(review({ this_month: figures(0, 0) }))
  renderWithProviders(<MonthlyReviewPanel />)
  expect(await screen.findByText('No income or spending recorded this month.')).toBeInTheDocument()
})

it('shows what is worth a second look, each linking to the matching transactions', async () => {
  api.reports.monthlyReview.mockResolvedValue(review({
    insights: [
      { kind: 'duplicate', description: 'Hardware Store', amount: 65, previous: null, count: 2, dates: ['2026-06-10', '2026-06-12'] },
      { kind: 'price_change', description: 'Streaming Plus', amount: 13, previous: 10, count: 1, dates: ['2026-06-03'] },
      { kind: 'price_change', description: 'Cheaper Plan', amount: 8, previous: 10, count: 1, dates: ['2026-06-03'] },
      { kind: 'unusual', description: 'Corner Restaurant', amount: 240, previous: 24, count: 1, dates: ['2026-06-09'] },
    ],
  }))
  renderWithProviders(<MonthlyReviewPanel />)
  expect(await screen.findByText('Worth a look')).toBeInTheDocument()
  expect(screen.getByText('Hardware Store was charged 2 times for €65 within a few days. A double charge?')).toBeInTheDocument()
  expect(screen.getByText('Streaming Plus went up from €10 to €13 (+30%).')).toBeInTheDocument()
  expect(screen.getByText('Cheaper Plan went down from €10 to €8 (−20%).')).toBeInTheDocument()
  expect(screen.getByText('Corner Restaurant: €240 is 10× what you usually pay there (€24).')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /Hardware Store was charged/ })).toHaveAttribute('href', expect.stringContaining('/transactions?q=Hardware%20Store&from='))
})

it('leaves the section out when there is nothing to look at', async () => {
  renderWithProviders(<MonthlyReviewPanel />)
  await screen.findByText(/You spent/)
  expect(screen.queryByText('Worth a look')).not.toBeInTheDocument()
})
