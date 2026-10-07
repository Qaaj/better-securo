import { describe, expect, it } from 'vitest'
import { customEntries, fieldsFor } from './asset-details'

describe('asset detail templates', () => {
  it('offers building fields for real estate and none for an unknown type', () => {
    expect(fieldsFor('real_estate', null).map((f) => f.key)).toContain('Energy label')
    expect(fieldsFor('mystery', null)).toEqual([])
  })

  it('switches a vehicle to boat fields when its kind is Boat', () => {
    expect(fieldsFor('vehicle', { 'Vehicle kind': 'Car' }).map((f) => f.key)).toContain('Mileage')
    const boat = fieldsFor('vehicle', { 'Vehicle kind': 'Boat' }).map((f) => f.key)
    expect(boat).toContain('Engine hours')
    expect(boat).not.toContain('Mileage')
  })

  it('treats what the template does not cover as custom, but not a vehicle field that is merely hidden', () => {
    expect(customEntries('real_estate', { 'Floor area': 90, 'Water meter': 'W-12' })).toEqual([['Water meter', 'W-12']])
    expect(customEntries('vehicle', { 'Vehicle kind': 'Boat', Mileage: 100, Radio: 'VHF' })).toEqual([['Radio', 'VHF']])
  })
})
