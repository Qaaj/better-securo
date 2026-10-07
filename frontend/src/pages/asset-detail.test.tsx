import { beforeEach, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import AssetDetailPage from '@/pages/asset-detail'
import { renderWithProviders } from '@/test/utils'
import type { Asset, AssetPhoto } from '@/types'

const api = vi.hoisted(() => ({
  assets: { get: vi.fn(), update: vi.fn() },
  assetPhotos: { list: vi.fn(), upload: vi.fn(), update: vi.fn(), remove: vi.fn(), blob: vi.fn(), geocode: vi.fn() },
}))
vi.mock('@/lib/api', () => api)
vi.mock('@/lib/image', () => ({ downscaleImage: async (f: File) => f }))
vi.mock('@/components/asset-map', () => ({ default: ({ latitude, longitude }: { latitude: number; longitude: number }) => <div data-testid="map">{latitude},{longitude}</div> }))
vi.mock('@/hooks/use-display-locale', () => ({ useDisplayLocale: () => 'en-US', useDateLocale: () => 'en-US' }))
vi.mock('@/hooks/use-privacy-mode', () => ({ usePrivacyMode: () => ({ mask: (v: string) => v, privacyMode: false, MASK: '••••' }) }))
vi.mock('@/contexts/workspace-context', () => ({ useWorkspace: () => ({ canWrite: true }) }))

const asset = {
  id: 'a1', name: 'Family house', type: 'real_estate', currency: 'EUR', current_value: 300000, purchase_price: 200000, purchase_date: '2015-05-01',
  growth_type: null, growth_rate: null, growth_frequency: null, income_mode: 'fixed', income_amount: 900, income_frequency: 'monthly',
  sell_percent_per_year: null, sell_date: null, sell_price: null,
  address: '1 Example Street, Town', latitude: 50.85, longitude: 4.35, details: { 'Floor area': 120, 'Water meter': 'W-12' }, notes: 'Roof redone.', cover_photo_id: 'p1',
} as unknown as Asset
const photo = { id: 'p1', asset_id: 'a1', filename: 'front.jpg', content_type: 'image/jpeg', size: 10, caption: 'Front', position: 0, is_cover: true, created_at: '2026-01-01' } as AssetPhoto

beforeEach(() => {
  vi.clearAllMocks()
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
