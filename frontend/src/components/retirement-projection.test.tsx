import { screen, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { RetirementProjection } from '@/components/retirement-projection'
import { renderWithProviders } from '@/test/utils'
import type { Asset, RecurringTransaction } from '@/types'

vi.mock('@/lib/download', () => ({ downloadText: vi.fn(), printHtml: vi.fn() }))

const items = [
  { id: 'rent', description: 'Rent', amount: 2000, currency: 'EUR', type: 'debit', frequency: 'monthly', is_active: true, amount_primary: null },
] as unknown as RecurringTransaction[]

function asset(over: Partial<Asset>): Asset {
  return {
    id: 'a', name: 'ETF', type: 'etf', currency: 'EUR', current_value: 100_000, current_value_primary: 100_000,
    is_archived: false, sell_date: null, income_mode: null, income_rate: null, income_amount: null,
    income_frequency: null, sell_percent_per_year: null, growth_type: null, growth_rate: null, growth_frequency: null,
    ...over,
  } as Asset
}
const assets = [asset({ id: 'etf', name: 'ETF' }), asset({ id: 'btc', name: 'Bitcoin', type: 'crypto', current_value: 50_000, current_value_primary: 50_000 })]

const props = { items, assets, excluded: new Set<string>(), currency: 'EUR', locale: 'en-US' }

beforeEach(() => window.localStorage.clear())

it('shows the runway, switches the chart to bands per asset and sets a drawdown start', async () => {
  const error = vi.spyOn(console, 'error')
  const { user, container } = renderWithProviders(<RetirementProjection {...props} />)

  // 150k of assets against 24k a year (rising with inflation): a finite runway, a little under 6 years.
  expect(screen.getByText(/^5\.\d years \(until \d{4}\)$/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'By asset' }))
  expect(container.querySelectorAll('.recharts-area').length).toBeGreaterThan(1)

  const start = screen.getByLabelText(/Start selling in year/)
  await user.clear(start)
  await user.type(start, '3')
  expect(screen.getByText(/Selling from \d{4}/)).toBeInTheDocument()

  expect(error).not.toHaveBeenCalled()
  error.mockRestore()
})

it('lets the selling order be set per asset once selling in order', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  expect(screen.queryByLabelText(/Sell order of ETF/)).not.toBeInTheDocument()

  await user.selectOptions(screen.getByDisplayValue('In proportion to value'), 'ordered')
  const etf = screen.getByLabelText('Sell order of ETF')
  await user.type(etf, '1')
  expect(etf).toHaveValue(1)
})

it('adds a fixed-spend what-if and lists it', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  await user.selectOptions(screen.getByDisplayValue('Extra monthly cost'), 'spend')
  await user.type(screen.getAllByRole('spinbutton').find((el) => (el as HTMLInputElement).step === 'any' && el.closest('div')?.textContent?.includes('Per month')) ?? screen.getByLabelText('Per month'), '1000')
  await user.click(screen.getByRole('button', { name: 'Add' }))
  const list = screen.getByText('Spend a fixed amount', { selector: 'span.font-medium' }).closest('li') as HTMLElement
  expect(within(list).getByText(/a month from/)).toBeInTheDocument()
})

it('adds a temporary asset to the list, counts it, and removes it again', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  const runway = () => screen.getByText(/years \(until \d{4}\)|^\d+\+ years$/).textContent

  const before = runway()
  await user.type(screen.getByPlaceholderText('e.g. more bonds'), 'More bonds')
  await user.type(screen.getByLabelText(/Amount \(EUR\)/), '200000')
  await user.click(screen.getByRole('button', { name: 'Add asset' }))

  expect(screen.getByText('More bonds')).toBeInTheDocument()
  expect(screen.getByText('temporary')).toBeInTheDocument()
  expect(runway()).not.toBe(before) // 200k more to sell from lengthens the runway
  expect(JSON.parse(window.localStorage.getItem('retirement:plan') ?? '{}').tempAssets).toHaveLength(1)

  await user.click(screen.getByRole('button', { name: 'Remove More bonds' }))
  expect(screen.queryByText('More bonds')).not.toBeInTheDocument()
  expect(runway()).toBe(before)
})

it('adds a temporary asset that only arrives from a later year', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  await user.type(screen.getByPlaceholderText('e.g. more bonds'), 'Inheritance')
  await user.type(screen.getByLabelText(/Amount \(EUR\)/), '300000')
  const from = screen.getByLabelText(/Available from year/)
  await user.clear(from)
  await user.type(from, '4')
  await user.click(screen.getByRole('button', { name: 'Add asset' }))

  expect(screen.getByText(/temporary · from \d{4}/)).toBeInTheDocument()
  const stored = JSON.parse(window.localStorage.getItem('retirement:plan') ?? '{}')
  expect(stored.tempAssets[0]).toMatchObject({ name: 'Inheritance', value: 300000, fromYear: 4 })
})

it('keeps a cost fixed from the Costs tab: the runway lengthens and the choice is saved with the plan', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  const runwayText = () => screen.getByText(/^\d+\.\d years \(until \d{4}\)$/).textContent ?? ''
  const before = parseFloat(runwayText())

  await user.click(screen.getByRole('tab', { name: 'Costs' }))
  const box = screen.getByRole('checkbox', { name: 'Inflation applies to Rent' })
  expect(box).toBeChecked()
  await user.click(box)
  expect(box).not.toBeChecked()

  // Rent no longer rises with inflation, so the assets last longer.
  expect(parseFloat(runwayText())).toBeGreaterThan(before)
  expect(JSON.parse(window.localStorage.getItem('retirement:plan') ?? '{}').flat).toEqual(['rent'])
  expect(screen.getByText(/Staying the same: .*2,000/)).toBeInTheDocument()
})

it('shows income lines under the Income tab, and disables them when income is not indexed', async () => {
  const credit = { id: 'pension', description: 'Pension', amount: 1000, currency: 'EUR', type: 'credit', frequency: 'monthly', is_active: true, amount_primary: null } as unknown as RecurringTransaction
  const { user } = renderWithProviders(<RetirementProjection {...props} items={[...items, credit]} />)
  await user.click(screen.getByRole('tab', { name: 'Income' }))
  const box = screen.getByRole('checkbox', { name: 'Inflation applies to Pension' })
  expect(box).toBeEnabled()

  await user.click(screen.getByRole('checkbox', { name: /Income rises with inflation too/ }))
  expect(screen.getByRole('checkbox', { name: 'Inflation applies to Pension' })).toBeDisabled()
  expect(screen.getByText(/Income does not rise with inflation/)).toBeInTheDocument()
})

it('switches the chart to a table of years against assets', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  await user.click(screen.getByRole('button', { name: 'Table' }))
  expect(screen.getByRole('table')).toBeInTheDocument()
  expect(screen.getByRole('columnheader', { name: 'Bitcoin' })).toBeInTheDocument()
  expect(screen.getAllByRole('row').length).toBe(2 + 30)
})

it('lets an extra cost stay the same instead of rising with inflation', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  const box = screen.getByRole('checkbox', { name: 'Rises with inflation' })
  expect(box).toBeChecked()
  await user.click(box)
  await user.type(screen.getByLabelText('Per month'), '500')
  await user.click(screen.getByRole('button', { name: 'Add' }))

  expect(screen.getByText(/stays the same/)).toBeInTheDocument()
  expect(JSON.parse(window.localStorage.getItem('retirement:plan') ?? '{}').whatIfs[0]).toMatchObject({ kind: 'expense', monthly: 500, inflates: false })
})

it('keeps the inflation box for an extra income off while income is not indexed', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  await user.selectOptions(screen.getByDisplayValue('Extra monthly cost'), 'income')
  expect(screen.getByRole('checkbox', { name: 'Rises with inflation' })).toBeEnabled()
  await user.click(screen.getByRole('checkbox', { name: /Income rises with inflation too/ }))
  expect(screen.getByRole('checkbox', { name: 'Rises with inflation' })).toBeDisabled()
})

it('exports the plan as Markdown and as a print-ready PDF page', async () => {
  const { downloadText, printHtml } = await import('@/lib/download')
  const { user } = renderWithProviders(<RetirementProjection {...props} />)

  await user.click(screen.getByRole('button', { name: /Export/ }))
  await user.click(screen.getByRole('menuitem', { name: 'Markdown (.md)' }))
  expect(downloadText).toHaveBeenCalledTimes(1)
  const [filename, text] = vi.mocked(downloadText).mock.calls[0]
  expect(filename).toMatch(/^retirement-plan-\d{4}-\d{2}-\d{2}\.md$/)
  expect(text).toContain('# Retirement plan')
  expect(text).toContain('| ETF ')

  await user.click(screen.getByRole('button', { name: /Export/ }))
  await user.click(screen.getByRole('menuitem', { name: 'PDF (print)' }))
  expect(printHtml).toHaveBeenCalledTimes(1)
  const html = vi.mocked(printHtml).mock.calls[0][0]
  expect(html).toContain('<svg')
  expect(html).toContain('Year by year')
})

it('has a living and travel figure whose change shows up in the runway steps', async () => {
  const { user } = renderWithProviders(<RetirementProjection {...props} />)
  await user.type(screen.getByLabelText(/A month, in EUR/), '2000')
  expect(await screen.findByText('Now')).toBeInTheDocument()
  expect(screen.getByText('+20%')).toBeInTheDocument()
  expect(screen.getByText('−20%')).toBeInTheDocument()
  expect(JSON.parse(window.localStorage.getItem('retirement:plan') ?? '{}').living).toEqual({ monthly: 2000, inflates: true })
})
