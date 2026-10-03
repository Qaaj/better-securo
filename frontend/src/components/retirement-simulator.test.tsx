import { screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { RetirementSimulator } from '@/components/retirement-simulator'
import { renderWithProviders } from '@/test/utils'
import type { Asset } from '@/types'

vi.mock('@/hooks/use-privacy-mode', () => ({ usePrivacyMode: () => ({ mask: (v: string) => v, privacyMode: false, MASK: '••••' }) }))

const asset = { id: 'a1', name: 'Index fund', type: 'investment', currency: 'EUR', current_value: 800000, current_value_primary: 800000, growth_type: 'percentage', growth_rate: 5, growth_frequency: 'yearly', is_archived: false, sell_date: null } as unknown as Asset

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('retirement:plan', JSON.stringify({ assumptions: { horizonYears: 10, inflationPercent: 2, incomeIndexed: true, drawdownStartYear: 0 } }))
})

it('shows how often the money lasts, a heat map of spending against crashes, and the settings', async () => {
  renderWithProviders(<RetirementSimulator items={[]} assets={[asset]} excluded={new Set()} currency="EUR" locale="en-US" />)
  expect(screen.getByText('Stress test')).toBeInTheDocument()
  // With no outgoings the assets always last.
  await waitFor(() => expect(screen.getAllByText('100%').length).toBeGreaterThan(0), { timeout: 3000 })
  expect(screen.getByText('Where is it resilient?')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText(/lasts 9 times in 10/)).toBeInTheDocument(), { timeout: 15000 })
  expect(screen.getByText("What is a cash buffer worth?")).toBeInTheDocument()
  expect(screen.getByLabelText('Behaviour of Index fund')).toHaveValue('stocks')
  expect(screen.getByLabelText('Crash chance a year (%)')).toBeInTheDocument()
}, 30000)
