import { describe, expect, it } from 'vitest'
import { mergeStores } from './retirement-sync'

describe('mergeStores', () => {
  it('prefers the server copy of everything', () => {
    const merged = mergeStores({ 'retirement:plan': { v: 'local' } }, { 'retirement:plan': { v: 'server' } })
    expect(merged['retirement:plan']).toEqual({ v: 'server' })
  })

  it('keeps what only exists locally', () => {
    const merged = mergeStores({ 'retirement:simulation': { runs: 5 } }, { 'retirement:plan': {} })
    expect(merged['retirement:simulation']).toEqual({ runs: 5 })
    expect(merged['retirement:plan']).toEqual({})
  })

  it('keeps saved plans found only locally, the server winning on a shared name', () => {
    const merged = mergeStores(
      { 'retirement:scenarios': { Old: { a: 1 }, Same: { a: 'local' } } },
      { 'retirement:scenarios': { New: { a: 2 }, Same: { a: 'server' } } },
    )
    expect(merged['retirement:scenarios']).toEqual({ Old: { a: 1 }, New: { a: 2 }, Same: { a: 'server' } })
  })
})
