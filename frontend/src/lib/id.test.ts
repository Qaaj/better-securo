import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from './id'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('makes a v4 id and does not repeat', () => {
    expect(newId()).toMatch(UUID)
    expect(newId()).not.toBe(newId())
  })

  it('still works where randomUUID is missing, as on a plain-http page', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) })
    expect(newId()).toMatch(UUID)
  })

  it('falls back to Math.random without any crypto', () => {
    vi.stubGlobal('crypto', undefined)
    expect(newId()).toMatch(UUID)
  })
})
