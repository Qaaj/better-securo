import { screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { AssetsTable, YearTooltip } from '@/components/retirement-projection-charts'
import { projectRetirement } from '@/lib/retirement-projection'
import { renderWithProviders } from '@/test/utils'

it('lists every asset, the income, the outgoings and what was sold for the hovered year', () => {
  const p = projectRetirement({
    recurringIncomeMonthly: 500,
    outgoingMonthly: 2_000,
    assets: [
      { id: 'etf', name: 'ETF', value: 100_000, drawable: true, yieldPercent: 2, sellOrder: 1 },
      { id: 'btc', name: 'Bitcoin', value: 50_000, drawable: true, sellOrder: 2 },
      { id: 'house', name: 'House', value: 300_000, drawable: false },
    ],
    assumptions: { horizonYears: 2, inflationPercent: 0, incomeIndexed: true, drawdownStartYear: 0, sellStrategy: 'ordered' },
    whatIfs: [],
  })
  renderWithProviders(
    <YearTooltip
      row={p.rows[0]}
      year={2027}
      names={{ etf: 'ETF', btc: 'Bitcoin', house: 'House' }}
      drawableIds={new Set(['etf', 'btc'])}
      money={(v) => `€${Math.round(v)}`}
    />,
  )
  expect(screen.getByText('2027')).toBeInTheDocument()
  expect(screen.getByText('Drawdown')).toBeInTheDocument()
  expect(screen.getAllByText('ETF').length).toBeGreaterThan(0)
  expect(screen.getByText('Bitcoin')).toBeInTheDocument()
  expect(screen.getByText(/Other assets \(not sold from\): €300000/)).toBeInTheDocument()
  expect(screen.getByText('Yields and rent')).toBeInTheDocument()
  expect(screen.getByText('Outgoing')).toBeInTheDocument()
  // 24k out against 6k recurring and 2k of yield: 16k sold, all from the first asset in order.
  expect(screen.getByText('Sold to cover the shortfall')).toBeInTheDocument()
  expect(p.rows[0].drawn.etf).toBeCloseTo(16_000)
  expect(p.rows[0].drawn.btc ?? 0).toBe(0)
})

it('flags a year the assets could not pay for', () => {
  const p = projectRetirement({
    recurringIncomeMonthly: 0, outgoingMonthly: 10_000,
    assets: [{ id: 'a', name: 'Little', value: 10_000, drawable: true }],
    assumptions: { horizonYears: 1, inflationPercent: 0, incomeIndexed: true },
    whatIfs: [],
  })
  renderWithProviders(<YearTooltip row={p.rows[0]} year={2027} names={{ a: 'Little' }} drawableIds={new Set(['a'])} money={(v) => `€${Math.round(v)}`} />)
  expect(screen.getByText('Could not be paid')).toBeInTheDocument()
})

it('shows a row per year and a column per asset, with the pool total and the flows', () => {
  const p = projectRetirement({
    recurringIncomeMonthly: 0,
    outgoingMonthly: 1_000,
    assets: [
      { id: 'etf', name: 'ETF', value: 100_000, drawable: true },
      { id: 'btc', name: 'Bitcoin', value: 50_000, drawable: true },
      { id: 'house', name: 'House', value: 300_000, drawable: false },
    ],
    assumptions: { horizonYears: 3, inflationPercent: 0, incomeIndexed: true },
    whatIfs: [],
  })
  renderWithProviders(
    <AssetsTable scenario={p} names={{ etf: 'ETF', btc: 'Bitcoin', house: 'House' }} drawableIds={new Set(['etf', 'btc'])} thisYear={2027} money={(v) => `€${Math.round(v)}`} />,
  )
  for (const header of ['ETF', 'Bitcoin', 'House', 'Total', 'Income', 'Outgoing', 'Sold', 'Net worth']) {
    expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
  }
  expect(screen.getAllByRole('row')).toHaveLength(2 + 3) // two header rows and one per year
  expect(screen.getByRole('rowheader', { name: /2027/ })).toBeInTheDocument()
  expect(screen.getByRole('rowheader', { name: /2029/ })).toBeInTheDocument()
  // Year 0: 12k drawn pro rata from 150k, so 138k left in the pool and 300k elsewhere.
  expect(screen.getAllByText('€138000').length).toBeGreaterThan(0)
  expect(screen.getAllByText('€300000').length).toBeGreaterThan(0)
})
