import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import AssetMap from '@/components/asset-map'

it('mounts an OpenStreetMap map with a marker at the point', () => {
  const { container } = render(<AssetMap latitude={50.85} longitude={4.35} />)
  expect(container.querySelector('.leaflet-container')).not.toBeNull()
  expect(container.querySelector('.leaflet-marker-icon')).not.toBeNull()
  expect(container.textContent).toContain('OpenStreetMap')
})
