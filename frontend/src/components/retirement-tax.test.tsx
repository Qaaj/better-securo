import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { RetirementTax } from '@/components/retirement-tax'
import { renderWithProviders } from '@/test/utils'
import type { Asset, RecurringTransaction } from '@/types'

vi.mock('@/hooks/use-privacy-mode', () => ({ usePrivacyMode: () => ({ mask: (v: string) => v, privacyMode: false, MASK: '••••' }) }))

const fund = { id: 'a1', name: 'Index fund', type: 'investment', currency: 'EUR', current_value: 100000, current_value_primary: 100000, purchase_price: 40000, income_mode: 'yield', income_rate: 3, is_archived: false, sell_date: null } as unknown as Asset
const pension = { id: 'r1', description: 'Pension', type: 'credit', amount: 1000, currency: 'EUR', amount_primary: 1000, frequency: 'monthly', is_active: true } as unknown as RecurringTransaction

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('retirement:plan', JSON.stringify({ assumptions: { horizonYears: 5, inflationPercent: 2, incomeIndexed: true, drawdownStartYear: 0, taxIncomePercent: 20 } }))
})

it('lists every taxed line, with its own rate over the default, and sums the tax', async () => {
  const user = userEvent.setup()
  renderWithProviders(<RetirementTax items={[pension]} assets={[fund]} excluded={new Set()} currency="EUR" locale="en-US" />)
  expect(screen.getByText('Tax on every line')).toBeInTheDocument()
  // Pension: 12,000 a year at the 20% default.
  const pensionRate = screen.getByLabelText('Tax rate for Pension · Recurring income')
  expect(pensionRate).toHaveValue(null)
  expect(pensionRate).toHaveAttribute('placeholder', '20')
  expect(screen.getByLabelText('Tax rate for Index fund · Yields')).toBeInTheDocument()
  expect(screen.getByLabelText('Tax rate for Index fund · Gains when selling')).toBeInTheDocument()

  await user.type(pensionRate, '0')
  await waitFor(() => expect(JSON.parse(window.localStorage.getItem('retirement:plan') ?? '{}').taxRates).toEqual({ 'income:r1': 0 }))
})
