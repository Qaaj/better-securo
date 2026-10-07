import { beforeEach, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import AssetDetailPage from '@/pages/asset-detail'
import { renderWithProviders } from '@/test/utils'
import type { Asset, AssetPhoto } from '@/types'

const api = vi.hoisted(() => ({
  assets: { get: vi.fn(), update: vi.fn() },
  assetPhotos: { list: vi.fn(), upload: vi.fn(), update: vi.fn(), remove: vi.fn(), blob: vi.fn(), geocode: vi.fn() },
  assetContracts: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  assetDocuments: { list: vi.fn(), upload: vi.fn(), update: vi.fn(), remove: vi.fn(), download: vi.fn() },
  recurring: { list: vi.fn() },
}))
vi.mock('@/lib/api', () => api)
vi.mock('@/lib/image', () => ({ downscaleImage: async (f: File) => f }))
vi.mock('@/components/asset-map', () => ({ default: ({ latitude, longitude }: { latitude: number; longitude: number }) => <div data-testid="map">{latitude},{longitude}</div> }))
vi.mock('@/hooks/use-display-locale', () => ({ useDisplayLocale: () => 'en-US', useDateLocale: () => 'en-US' }))
vi.mock('@/hooks/use-privacy-mode', () => ({ usePrivacyMode: () => ({ mask: (v: string) => v, privacyMode: false, MASK: '••••' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { preferences: { currency_display: 'EUR' } } }) }))
vi.mock('@/contexts/workspace-context', () => ({ useWorkspace: () => ({ canWrite: true }) }))

const asset = {
  id: 'a1', name: 'Family house', type: 'real_estate', currency: 'EUR', current_value: 300000, purchase_price: 200000, purchase_date: '2015-05-01',
  growth_type: null, growth_rate: null, growth_frequency: null, income_mode: 'fixed', income_amount: 900, income_frequency: 'monthly',
  sell_percent_per_year: null, sell_date: null, sell_price: null,
  address: '1 Example Street, Town', latitude: 50.85, longitude: 4.35, details: { 'Floor area': 120, 'Water meter': 'W-12' }, notes: 'Roof redone.', cover_photo_id: 'p1',
} as unknown as Asset
const photo = { id: 'p1', asset_id: 'a1', filename: 'front.jpg', content_type: 'image/jpeg', size: 10, caption: 'Front', position: 0, is_cover: true, created_at: '2026-01-01' } as AssetPhoto

const contract = (over: Record<string, unknown> = {}) => ({
  id: 'k1', asset_id: 'a1', kind: 'energy', provider: 'Power Co', contract_number: 'C-1', customer_number: null, meter_number: 'M-9',
  start_date: '2025-01-01', end_date: null, notice_days: null, recurring_id: 'r1', notes: null, created_at: '2026-01-01',
  recurring: { id: 'r1', description: 'Electricity', amount: 85, currency: 'EUR', frequency: 'monthly', is_active: true, amount_primary: 85 },
  document_count: 1, days_left: null, notice_by: null, ...over,
})
const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', asset_id: 'a1', contract_id: 'k1', kind: 'contract', title: 'Power contract', filename: 'power.pdf', content_type: 'application/pdf', size: 52000,
  document_date: null, expires_on: null, created_at: '2026-01-01', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.assetContracts.list.mockResolvedValue([])
  api.assetContracts.create.mockResolvedValue(contract())
  api.assetContracts.update.mockResolvedValue(contract())
  api.assetContracts.remove.mockResolvedValue(undefined)
  api.assetDocuments.list.mockResolvedValue([])
  api.assetDocuments.upload.mockResolvedValue(doc())
  api.assetDocuments.update.mockResolvedValue(doc())
  api.assetDocuments.remove.mockResolvedValue(undefined)
  api.assetDocuments.download.mockResolvedValue(undefined)
  api.recurring.list.mockResolvedValue([{ id: 'r1', description: 'Electricity', type: 'debit', is_active: true }, { id: 'r2', description: 'Salary', type: 'credit', is_active: true }])
  api.assets.get.mockResolvedValue(asset)
  api.assets.update.mockResolvedValue(asset)
  api.assetPhotos.list.mockResolvedValue([photo])
  api.assetPhotos.blob.mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }))
  URL.createObjectURL = vi.fn(() => 'blob:photo')
})

// Each card has its own Save, disabled until something changed there.
const enabledSave = () => screen.getAllByRole('button', { name: 'Save' }).find((b) => !(b as HTMLButtonElement).disabled)!

const render = () => renderWithProviders(<AssetDetailPage />, { route: '/assets/a1', path: '/assets/:id' })

it('shows the lead photo, the map, the facts, the technical details and the notes', async () => {
  render()
  expect(await screen.findByRole('heading', { name: 'Family house' })).toBeInTheDocument()
  expect((await screen.findAllByAltText('Front')).length).toBeGreaterThan(0)
  expect(await screen.findByTestId('map')).toHaveTextContent('50.85,4.35')
  expect(screen.getByText('1 Example Street, Town')).toBeInTheDocument()
  expect(screen.getByText('At a glance')).toBeInTheDocument()
  expect(screen.getByText(/\+.?€100,000/)).toBeInTheDocument()
  expect(screen.getByLabelText(/Floor area/)).toHaveValue(120)
  expect(screen.getByDisplayValue('W-12')).toBeInTheDocument()
  expect(screen.getByDisplayValue('Roof redone.')).toBeInTheDocument()
})

it('saves edited technical details, keeping the numbers numeric and adding an own field', async () => {
  const { user } = render()
  const area = await screen.findByLabelText(/Floor area/)
  await user.clear(area)
  await user.type(area, '135')
  await user.click(screen.getByRole('button', { name: 'Add a field' }))
  const names = screen.getAllByLabelText('Name')
  await user.type(names[names.length - 1], 'Roof')
  const values = screen.getAllByLabelText(/value$/)
  await user.type(values[values.length - 1], 'Slate')
  await user.click(enabledSave())
  await waitFor(() =>
    expect(api.assets.update).toHaveBeenCalledWith('a1', { details: { 'Floor area': 135, 'Water meter': 'W-12', Roof: 'Slate' } }),
  )
})

it('finds an address on the map and saves the chosen place', async () => {
  api.assetPhotos.geocode.mockResolvedValue([{ display_name: '2 Other Road, City', latitude: 51.1, longitude: 3.7 }])
  const { user } = render()
  await user.click(await screen.findByRole('button', { name: 'Edit' }))
  const address = screen.getByLabelText('Address')
  await user.clear(address)
  await user.type(address, '2 Other Road')
  await user.click(screen.getByRole('button', { name: 'Find on map' }))
  await user.click(await screen.findByRole('button', { name: '2 Other Road, City' }))
  expect(screen.getByLabelText('Latitude')).toHaveValue('51.100000')
  await user.click(enabledSave())
  await waitFor(() => expect(api.assets.update).toHaveBeenCalledWith('a1', { address: '2 Other Road, City', latitude: 51.1, longitude: 3.7 }))
})

it('says so when there are no photos and no location', async () => {
  api.assetPhotos.list.mockResolvedValue([])
  api.assets.get.mockResolvedValue({ ...asset, address: null, latitude: null, longitude: null, cover_photo_id: null, notes: null, details: null })
  render()
  expect(await screen.findByText('Add photos')).toBeInTheDocument()
  expect(screen.getByText('No location yet')).toBeInTheDocument()
  expect(screen.getByText('No address')).toBeInTheDocument()
})

it('uploads chosen photos and shows how many are going up', async () => {
  api.assetPhotos.upload.mockResolvedValue(photo)
  const { user, container } = render()
  await screen.findByRole('heading', { name: 'Family house' })
  const file = new File(['x'], 'back.jpg', { type: 'image/jpeg' })
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, file)
  await waitFor(() => expect(api.assetPhotos.upload).toHaveBeenCalledWith('a1', file))
})

it('refuses a file that is not an image', async () => {
  const { user, container } = render()
  await screen.findByRole('heading', { name: 'Family house' })
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, new File(['x'], 'deed.pdf', { type: 'application/pdf' }), { applyAccept: false })
  expect(api.assetPhotos.upload).not.toHaveBeenCalled()
})

it('lists contracts with their status and cost, and totals the running costs', async () => {
  const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
  api.assetContracts.list.mockResolvedValue([
    contract(),
    contract({ id: 'k2', kind: 'insurance', provider: 'Safe Co', contract_number: null, meter_number: null, recurring_id: null, recurring: null, end_date: soon, days_left: 20, notice_by: null, document_count: 0 }),
  ])
  render()
  expect(await screen.findByText('Power Co')).toBeInTheDocument()
  expect(screen.getByText('Safe Co')).toBeInTheDocument()
  expect(screen.getByText('No end date')).toBeInTheDocument()
  expect(screen.getByText('Ends in 20 days')).toBeInTheDocument()
  expect(screen.getByText('Running costs a month')).toBeInTheDocument()
  expect(screen.getByText(/€1,020/)).toBeInTheDocument()
  expect(screen.getByText('1 without a linked cost')).toBeInTheDocument()
  expect(screen.getByText('Contract C-1 · Meter M-9')).toBeInTheDocument()
})

it('adds a contract linked to a recurring item that is an expense', async () => {
  const { user } = render()
  await user.click(await screen.findByRole('button', { name: 'Add a contract' }))
  await user.type(screen.getByLabelText('Provider'), 'Water Co')
  await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('Kind'), 'water')
  const linked = screen.getByLabelText('Cost')
  // Income is not offered.
  expect(within(linked).queryByText('Salary')).not.toBeInTheDocument()
  await user.selectOptions(linked, 'r1')
  await user.type(screen.getByLabelText('Notice period (days)'), '30')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(api.assetContracts.create).toHaveBeenCalledWith('a1', expect.objectContaining({ kind: 'water', provider: 'Water Co', recurring_id: 'r1', notice_days: 30, end_date: null })),
  )
})

it('lists documents with their expiry, downloads one and deletes one', async () => {
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  api.assetContracts.list.mockResolvedValue([contract()])
  api.assetDocuments.list.mockResolvedValue([doc({ expires_on: soon }), doc({ id: 'd2', title: 'EPC certificate', kind: 'energy_certificate', contract_id: null })])
  const { user } = render()
  expect(await screen.findByText('Power contract')).toBeInTheDocument()
  expect(screen.getByText('EPC certificate')).toBeInTheDocument()
  expect(screen.getByText(/^Expires /)).toBeInTheDocument()
  expect(screen.getByText(/Contract · Power Co/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Download Power contract' }))
  await waitFor(() => expect(api.assetDocuments.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' })))
  await user.click(screen.getByRole('button', { name: 'Delete EPC certificate' }))
  await waitFor(() => expect(api.assetDocuments.remove).toHaveBeenCalledWith('d2'))
})

it('uploads documents with the chosen kind, and to a contract from its own button', async () => {
  api.assetContracts.list.mockResolvedValue([contract()])
  const { user, container } = render()
  await screen.findByText('Power Co')
  const inputs = Array.from(container.querySelectorAll('input[type="file"]')) as HTMLInputElement[]
  const documentsInput = inputs[inputs.length - 1]
  await user.selectOptions(screen.getByLabelText('Kind', { selector: 'select' }), 'deed')
  const file = new File(['x'], 'deed.pdf', { type: 'application/pdf' })
  await user.upload(documentsInput, file)
  await waitFor(() => expect(api.assetDocuments.upload).toHaveBeenCalledWith('a1', file, { kind: 'deed', contract_id: null }))

  const contractInput = inputs.find((i) => i !== documentsInput && i.multiple && !i.accept)!
  const contractFile = new File(['y'], 'power.pdf', { type: 'application/pdf' })
  await user.click(screen.getByRole('button', { name: 'Attach a document to Power Co' }))
  await user.upload(contractInput, contractFile)
  await waitFor(() => expect(api.assetDocuments.upload).toHaveBeenCalledWith('a1', contractFile, { kind: 'contract', contract_id: 'k1' }))
})
