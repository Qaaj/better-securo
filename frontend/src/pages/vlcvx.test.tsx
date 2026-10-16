import { beforeEach, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import VlcvxPage from '@/pages/vlcvx'
import { renderWithProviders } from '@/test/utils'
import type { VlcvxRound, VlcvxSummary } from '@/types'

const api = vi.hoisted(() => ({ vlcvx: { summary: vi.fn(), refresh: vi.fn(), rounds: vi.fn(), round: vi.fn(), breakdown: vi.fn() } }))
vi.mock('@/lib/api', () => api)
vi.mock('@/lib/download', () => ({ downloadText: vi.fn(), printHtml: vi.fn() }))
vi.mock('@/contexts/workspace-context', () => ({ useWorkspace: () => ({ canWrite: true }) }))

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 14 * 86_400_000).toISOString()
const rounds = (protocol: string): VlcvxRound[] =>
  Array.from({ length: 30 }, (_, i) => ({
    round: i + 1, ends_at: day(i), total_amount_dollars: 100_000 + i * 1000, dollar_per_vl: 0.01 + i * 0.0001, scores_total: 40_000_000, proposal: 'p', vote_source: 'x', has_detail: true, bribe_count: 5,
  })).map((r) => (protocol === 'cvx-fxn' ? { ...r, dollar_per_vl: 0.001, total_amount_dollars: 5000 } : r))

const protocol = (name: string, label: string, rounds: number, over: Record<string, unknown> = {}) => ({
  protocol: name, label, rounds, first_round: 1, latest_round: rounds, latest_ends_at: day(29), latest_total_dollars: 129_000, latest_dollar_per_vl: 0.0129, latest_votes: 43_600_000,
  average_dollar_per_vl_12: 0.0123, best_dollar_per_vl: 0.05, total_dollars_all_time: 3_400_000, reward_per_dollar_bribe: 1.68, synced_at: day(29), ...over,
})

const summary = (over: Partial<VlcvxSummary> = {}): VlcvxSummary => ({
  enabled: true, source: 'https://api.llama.airforce', has_data: true,
  protocols: [protocol('cvx-crv', 'Curve gauges', 30), protocol('cvx-fxn', 'f(x) Protocol', 30), protocol('cvx-prisma', 'Prisma', 0)],
  sync: { state: 'idle', started_at: null, finished_at: null, error: null, done: 0, total: 0 }, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api.vlcvx.summary.mockResolvedValue(summary())
  api.vlcvx.refresh.mockResolvedValue({ state: 'running', started_at: null, finished_at: null, error: null, done: 0, total: 0 })
  api.vlcvx.rounds.mockImplementation(async (p: string) => rounds(p))
  api.vlcvx.breakdown.mockResolvedValue({
    tokens: [{ token: 'CRV', total_dollars: 900 }, { token: 'CVX', total_dollars: 100 }],
    by_round: rounds('cvx-crv').map((r) => ({ round: r.round, ends_at: r.ends_at, tokens: { CRV: 90, CVX: 10 }, total_dollars: 100 })),
    top_pools: [{ pool: 'Pool A', total_dollars: 800, rounds: 20, first_round: 1, last_round: 30, best_round_dollars: 90 }], rounds_with_detail: 30,
  })
  api.vlcvx.round.mockResolvedValue({
    ...rounds('cvx-crv')[29], protocol: 'cvx-crv',
    pools: [{ pool: 'Pool A', dollars: 800, tokens: ['CRV', 'CVX'], votes: 30_000_000 }], tokens: [{ token: 'CRV', dollars: 700, amount: 10 }, { token: 'CVX', dollars: 100, amount: 5 }], bribes: [],
  })
})

it('shows the latest round, what one vlCVX earned and the history', async () => {
  renderWithProviders(<VlcvxPage />)
  expect(await screen.findByText('Round 30 paid')).toBeInTheDocument()
  expect(screen.getByText('$129,000')).toBeInTheDocument()
  expect(screen.getByText('$0.0129')).toBeInTheDocument()
  expect(screen.getByText('43.6M vlCVX')).toBeInTheDocument()
  expect(screen.getByText('$3.4M')).toBeInTheDocument()
  expect(screen.getByText('What one vlCVX earned each round')).toBeInTheDocument()
  // A protocol with no rounds is not offered.
  expect(screen.queryByRole('button', { name: /Prisma/ })).not.toBeInTheDocument()
  expect(screen.getByText(/Data from/)).toHaveTextContent('Llama Airforce')
})

it('switches protocol and loads that protocol\'s breakdown', async () => {
  const { user } = renderWithProviders(<VlcvxPage />)
  await screen.findByText('Round 30 paid')
  await user.click(screen.getByRole('button', { name: /f\(x\) Protocol/ }))
  await waitFor(() => expect(api.vlcvx.breakdown).toHaveBeenCalledWith('cvx-fxn'))
})

it('lists every round and opens one with its pools and tokens', async () => {
  const { user } = renderWithProviders(<VlcvxPage />)
  await user.click(await screen.findByRole('tab', { name: 'Rounds' }))
  await user.click(await screen.findByRole('button', { name: 'Open round 30' }))
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByText('Pool A')).toBeInTheDocument()
  expect(within(dialog).getByText('$800')).toBeInTheDocument()
  expect(within(dialog).getByText('CRV, CVX')).toBeInTheDocument()
  expect(api.vlcvx.round).toHaveBeenCalledWith('cvx-crv', 30)
})

it('shows what was paid in and the pools bribed most', async () => {
  const { user } = renderWithProviders(<VlcvxPage />)
  await user.click(await screen.findByRole('tab', { name: 'Bribes' }))
  expect(await screen.findByText('Tokens paid')).toBeInTheDocument()
  expect(await screen.findByText('Pool A')).toBeInTheDocument()
  expect(screen.getByText('$900')).toBeInTheDocument()
})

it('simulates holding vlCVX from the rounds, with the yield once a price is entered', async () => {
  const { user } = renderWithProviders(<VlcvxPage />)
  await user.click(await screen.findByRole('tab', { name: 'Simulator' }))
  expect(await screen.findByText('Collected so far, by round ahead')).toBeInTheDocument()
  expect(screen.getByText('Enter a CVX price')).toBeInTheDocument()
  expect(screen.getByText('If you had held 10,000 vlCVX')).toBeInTheDocument()
  const price = screen.getByLabelText('CVX price (USD)')
  await user.type(price, '2.5')
  await waitFor(() => expect(screen.queryByText('Enter a CVX price')).not.toBeInTheDocument())
  // Prisma is not counted unless picked, f(x) is.
  expect(screen.getByLabelText('f(x) Protocol')).toBeChecked()
})

it('offers to load the data when there is none, and starts a sync', async () => {
  api.vlcvx.summary.mockResolvedValue(summary({ has_data: false, protocols: [] }))
  const { user } = renderWithProviders(<VlcvxPage />)
  expect(await screen.findByText('No vlCVX data yet')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Refresh data' }))
  await waitFor(() => expect(api.vlcvx.refresh).toHaveBeenCalled())
})

it('says so when the data source is switched off, and shows sync progress', async () => {
  api.vlcvx.summary.mockResolvedValue(summary({ enabled: false }))
  renderWithProviders(<VlcvxPage />)
  expect(await screen.findByText(/switched off/)).toBeInTheDocument()
})

it('shows the progress of a running sync on the button', async () => {
  api.vlcvx.summary.mockResolvedValue(summary({ sync: { state: 'running', started_at: null, finished_at: null, error: null, done: 12, total: 227 } }))
  renderWithProviders(<VlcvxPage />)
  expect(await screen.findByRole('button', { name: 'Syncing… 12 of 227' })).toBeDisabled()
})
