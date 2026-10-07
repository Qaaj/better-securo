/** The technical details an asset page offers by type. Values are saved by field name in the asset's `details`. */
export interface DetailField {
  key: string
  kind: 'text' | 'number' | 'select' | 'year'
  unit?: string
  options?: string[]
}

const ENERGY_LABELS = ['A++', 'A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G']

const REAL_ESTATE: DetailField[] = [
  { key: 'Property kind', kind: 'select', options: ['House', 'Apartment', 'Land', 'Commercial', 'Garage or parking', 'Other'] },
  { key: 'Floor area', kind: 'number', unit: 'm²' },
  { key: 'Plot area', kind: 'number', unit: 'm²' },
  { key: 'Rooms', kind: 'number' },
  { key: 'Bedrooms', kind: 'number' },
  { key: 'Bathrooms', kind: 'number' },
  { key: 'Floors', kind: 'number' },
  { key: 'Built', kind: 'year' },
  { key: 'Last renovation', kind: 'year' },
  { key: 'Energy label', kind: 'select', options: ENERGY_LABELS },
  { key: 'Heating', kind: 'text' },
  { key: 'Insulation and glazing', kind: 'text' },
  { key: 'Cadastral reference', kind: 'text' },
  { key: 'Parking', kind: 'text' },
  { key: 'Condition', kind: 'text' },
]

const VEHICLE_COMMON: DetailField[] = [
  { key: 'Make', kind: 'text' },
  { key: 'Model', kind: 'text' },
  { key: 'Year', kind: 'year' },
  { key: 'Registration', kind: 'text' },
  { key: 'Identification number', kind: 'text' },
  { key: 'Fuel or propulsion', kind: 'text' },
  { key: 'Colour', kind: 'text' },
]
const VEHICLE: DetailField[] = [
  { key: 'Vehicle kind', kind: 'select', options: ['Car', 'Motorbike', 'Boat', 'Caravan or camper', 'Other'] },
  ...VEHICLE_COMMON,
  { key: 'Mileage', kind: 'number', unit: 'km' },
  { key: 'Last service', kind: 'text' },
]
const BOAT: DetailField[] = [
  { key: 'Vehicle kind', kind: 'select', options: ['Car', 'Motorbike', 'Boat', 'Caravan or camper', 'Other'] },
  ...VEHICLE_COMMON,
  { key: 'Length', kind: 'number', unit: 'm' },
  { key: 'Beam', kind: 'number', unit: 'm' },
  { key: 'Draft', kind: 'number', unit: 'm' },
  { key: 'Engine hours', kind: 'number', unit: 'h' },
  { key: 'Home port', kind: 'text' },
  { key: 'Last survey', kind: 'text' },
]

const VALUABLE: DetailField[] = [
  { key: 'Description', kind: 'text' },
  { key: 'Maker or artist', kind: 'text' },
  { key: 'Year', kind: 'year' },
  { key: 'Serial or reference', kind: 'text' },
  { key: 'Provenance', kind: 'text' },
  { key: 'Last appraisal', kind: 'text' },
  { key: 'Stored at', kind: 'text' },
]

const INVESTMENT: DetailField[] = [
  { key: 'Broker or platform', kind: 'text' },
  { key: 'Account reference', kind: 'text' },
  { key: 'Account holder', kind: 'text' },
  { key: 'Tax wrapper', kind: 'text' },
]

/** The fields to show for an asset of this type, given the details it already has. */
export function fieldsFor(type: string, details: Record<string, unknown> | null): DetailField[] {
  switch (type) {
    case 'real_estate':
      return REAL_ESTATE
    case 'vehicle':
      return details?.['Vehicle kind'] === 'Boat' ? BOAT : VEHICLE
    case 'valuable':
      return VALUABLE
    case 'investment':
      return INVESTMENT
    default:
      return []
  }
}

/** Details the type's fields do not cover, so they can be edited as free fields. */
export function customEntries(type: string, details: Record<string, unknown> | null): [string, string][] {
  const known = new Set(fieldsFor(type, details).map((f) => f.key))
  // A boat keeps the car fields it was switched from out of sight; they are not "custom".
  for (const f of [...VEHICLE, ...BOAT]) if (type === 'vehicle') known.add(f.key)
  return Object.entries(details ?? {})
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => [key, value == null ? '' : String(value)])
}
