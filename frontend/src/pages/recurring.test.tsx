import { beforeEach, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import RecurringPage from '@/pages/recurring'
import { renderWithProviders } from '@/test/utils'
import type { Discovery, DiscoverySeries, RecurringTransaction } from '@/types'

const api = vi.hoisted(() => ({
  recurring: {
    list: vi.fn(),
    discoveries: vi.fn(),
    linkSeries: vi.fn(),
    createFromSeries: vi.fn(),
    dismissDiscovery: vi.fn(),
    resetDismissed: vi.fn(),
    history: vi.fn(),
    generate: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  categories: { list: vi.fn(), listIncludingHidden: vi.fn() },
  categoryGroups: { list: vi.fn() },
  accounts: { list: vi.fn() },
  currencies: { list: vi.fn() },
}))
vi.mock('@/lib/api', () => api)
vi.mock('@/hooks/use-display-locale', () => ({ useDisplayLocale: () => 'en-US', useDateLocale: () => 'en-US' }))
vi.mock('@/hooks/use-privacy-mode', () => ({ usePrivacyMode: () => ({ mask: (v: string) => v, privacyMode: false, MASK: '••••' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { preferences: { currency_display: 'EUR' } } }) }))
vi.mock('@/contexts/workspace-context', () => ({ useWorkspace: () => ({ canWrite: true }) }))

const item = {
  id: 'r1', description: 'Syndic charges', amount: 126, currency: 'EUR', type: 'debit', frequency: 'monthly',
  next_occurrence: '2026-11-02', is_active: true, start_date: '2026-01-02', amount_primary: 126, account_id: 'acc', category_id: null,
} as unknown as RecurringTransaction

const series = (over: Partial<DiscoverySeries> = {}): DiscoverySeries => ({
  key: 'debit|acp|126', name: 'ACP La Minoterie', type: 'debit', frequency: 'monthly', confidence: 'high', occurrences: 6,
  first_date: '2026-01-02', last_date: '2026-06-02', typical_amount: 126, currency: 'EUR', amount_varies: false, day_of_month: 2,
  next_occurrence: '2026-07-02', account_id: 'acc', category_id: null, yearly_amount: 1512, lapsed: false,
  transaction_ids: ['t1', 't2', 't3', 't4', 't5', 't6'], recent: [], ...over,
})

const discovery = (): Discovery => ({
  matches: [{ recurring_id: 'r1', recurring_description: 'Syndic charges', recurring_amount: 126, recurring_currency: 'EUR', recurring_frequency: 'monthly', score: 0.9, confidence: 'high', reasons: ['amount', 'schedule'], series: series() }],
  new_series: [
    series({ key: 'debit|stream|15', name: 'Streaming Co', typical_amount: 15, transaction_ids: ['s1', 's2', 's3'], occurrences: 3 }),
    series({ key: 'debit|old|20', name: 'Old Magazine', lapsed: true, confidence: 'medium' }),
    series({ key: 'debit|maybe|9', name: 'Maybe Thing', confidence: 'low', occurrences: 2 }),
  ],
  dismissed: 2,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.recurring.list.mockResolvedValue([item])
  api.recurring.discoveries.mockResolvedValue(discovery())
  api.recurring.linkSeries.mockResolvedValue(item)
  api.recurring.createFromSeries.mockResolvedValue(item)
  api.recurring.dismissDiscovery.mockResolvedValue(undefined)
  api.recurring.resetDismissed.mockResolvedValue({ restored: 2 })
  api.recurring.update.mockResolvedValue(item)
  api.recurring.history.mockResolvedValue({
    recurring_id: 'r1',
    charges: [
      { id: 'c1', date: '2026-01-02', amount: 120, currency: 'EUR', amount_primary: 120 },
      { id: 'c2', date: '2026-02-02', amount: 120, currency: 'EUR', amount_primary: 120 },
      { id: 'c3', date: '2026-03-02', amount: 132, currency: 'EUR', amount_primary: 132 },
    ],
    count: 3, first_date: '2026-01-02', last_date: '2026-03-02', months_running: 2, total_paid: 372, total_last_12_months: 372,
    average_amount: 124, min_amount: 120, max_amount: 132, first_amount: 120, latest_amount: 132, change_since_first_pct: 10,
    price_changes: [{ date: '2026-03-02', from_amount: 120, to_amount: 132, change_pct: 10 }], amount_varies: false,
    latest_vs_planned_pct: 4.8, overdue_days: 12,
  })
  api.categories.list.mockResolvedValue([])
  api.categories.listIncludingHidden.mockResolvedValue([])
  api.categoryGroups.list.mockResolvedValue([])
  api.accounts.list.mockResolvedValue([{ id: 'acc', name: 'Main', currency: 'EUR' }])
  api.currencies.list.mockResolvedValue([])
})

it('proposes the best match under the item, links all of its transactions with one click', async () => {
  const { user } = renderWithProviders(<RecurringPage />)
  await screen.findByRole('cell', { name: 'Syndic charges' })
  // Nothing is suggested until asked.
  expect(screen.queryByText('ACP La Minoterie')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /Search for matches/ }))
  expect(await screen.findByText('ACP La Minoterie')).toBeInTheDocument()
  expect(screen.getByText(/same amount, same schedule/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Link 6' }))
  await waitFor(() => expect(api.recurring.linkSeries).toHaveBeenCalledWith('r1', ['t1', 't2', 't3', 't4', 't5', 't6']))
})

it('skips a match so it is not offered again', async () => {
  const { user } = renderWithProviders(<RecurringPage />)
  await user.click(await screen.findByRole('button', { name: /Search for matches/ }))
  await user.click(await screen.findByRole('button', { name: 'Not this one' }))
  await waitFor(() => expect(api.recurring.dismissDiscovery).toHaveBeenCalledWith({ kind: 'match', key: 'debit|acp|126', recurring_id: 'r1' }))
})

it('proposes new recurring with one-click create, keeping the shaky ones out of view', async () => {
  const { user } = renderWithProviders(<RecurringPage />)
  await user.click(await screen.findByRole('button', { name: /Search for new recurring/ }))
  const card = (await screen.findByText('New recurring found')).closest('div')!.parentElement!
  expect(within(card).getByText('Streaming Co')).toBeInTheDocument()
  expect(screen.queryByText('Old Magazine')).not.toBeInTheDocument()
  expect(screen.queryByText('Maybe Thing')).not.toBeInTheDocument()

  await user.click(within(card).getByRole('button', { name: 'Create new' }))
  await waitFor(() =>
    expect(api.recurring.createFromSeries).toHaveBeenCalledWith(expect.objectContaining({ description: 'Streaming Co', frequency: 'monthly', account_id: 'acc', transaction_ids: ['s1', 's2', 's3'] })),
  )
})

it('lists what is not assigned at the bottom and can assign, hide and restore', async () => {
  const { user } = renderWithProviders(<RecurringPage />)
  await screen.findByText('Repeating charges not assigned yet')
  // Without searching, the confident one is listed; ended and shaky ones sit behind a toggle.
  expect(screen.getByText('Streaming Co')).toBeInTheDocument()
  expect(screen.queryByText('Old Magazine')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Show less certain and ended \(2\)/ }))
  expect(screen.getByText('Old Magazine')).toBeInTheDocument()
  expect(screen.getByText('Maybe Thing')).toBeInTheDocument()

  await user.selectOptions(screen.getByLabelText('Assign Streaming Co to a recurring item'), 'r1')
  const row = screen.getByText('Streaming Co').closest('li')!
  await user.click(within(row).getByRole('button', { name: 'Assign' }))
  await waitFor(() => expect(api.recurring.linkSeries).toHaveBeenCalledWith('r1', ['s1', 's2', 's3']))

  await user.click(within(row).getByRole('button', { name: 'Dismiss Streaming Co' }))
  await waitFor(() => expect(api.recurring.dismissDiscovery).toHaveBeenCalledWith({ kind: 'series', key: 'debit|stream|15' }))

  await user.click(screen.getByRole('button', { name: 'Restore 2 dismissed' }))
  await waitFor(() => expect(api.recurring.resetDismissed).toHaveBeenCalled())
})

it('shows how long an item has run, its price changes and a late charge, and can take the latest price', async () => {
  const { user } = renderWithProviders(<RecurringPage />)
  await user.click(await screen.findByRole('button', { name: 'Show history of Syndic charges' }))
  expect(await screen.findByText('2 months')).toBeInTheDocument()
  expect(screen.getByText('since 1/2/2026')).toBeInTheDocument()
  expect(screen.getByText(/\+10% since/)).toBeInTheDocument()
  expect(screen.getByText(/\(\+10%\)/)).toBeInTheDocument()
  expect(screen.getByText(/12 days late/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Use latest amount' }))
  await waitFor(() => expect(api.recurring.update).toHaveBeenCalledWith('r1', { amount: 132 }))
})

it('says so when no charges are linked yet', async () => {
  api.recurring.history.mockResolvedValue({ recurring_id: 'r1', charges: [], count: 0, price_changes: [], amount_varies: false, total_paid: 0, total_last_12_months: 0 })
  const { user } = renderWithProviders(<RecurringPage />)
  await user.click(await screen.findByRole('button', { name: 'Show history of Syndic charges' }))
  expect(await screen.findByText(/No charges are linked to this item yet/)).toBeInTheDocument()
})
