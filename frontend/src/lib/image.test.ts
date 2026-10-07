import { describe, expect, it } from 'vitest'
import { fitWithin } from './image'

describe('fitWithin', () => {
  it('shrinks the longer side to the limit and keeps the shape', () => {
    expect(fitWithin(4000, 3000, 1800)).toEqual({ width: 1800, height: 1350 })
    expect(fitWithin(3000, 4000, 1800)).toEqual({ width: 1350, height: 1800 })
  })

  it('never makes a small image bigger', () => {
    expect(fitWithin(800, 600, 1800)).toEqual({ width: 800, height: 600 })
  })
})
