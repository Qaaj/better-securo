/**
 * Maths for the vlCVX tab: what a vlCVX holder was paid in past Votium rounds, and what holding it might pay.
 *
 * A Votium round pays bribes to the people who voted with their vlCVX; `dollar_per_vl` is what one vlCVX earned
 * in that round. Rounds of different protocols (Curve, f(x), Prisma) run on the same two-week schedule, so they
 * are lined up into periods and a holder who votes in all of them earns the sum.
 */
import { makeRng } from './retirement-simulation'
import type { VlcvxRound } from '@/types'

export const PERIOD_MS = 14 * 24 * 3600 * 1000
/** A fixed point on the two-week schedule, so periods are the same whichever protocols are selected. */
const ANCHOR = Date.UTC(2021, 10, 1)

export interface Period {
  /** Two-week slot counted from a fixed anchor. */
  index: number
  /** When the latest round in the slot ended. */
  endsAt: string
  /** Dollars one vlCVX earned in the slot, summed over the protocols included. */
  rate: number
  /** Total bribes paid out in the slot. */
  totalDollars: number
  parts: Record<string, number>
}

export function periodIndex(endsAt: string): number {
  return Math.floor((new Date(endsAt).getTime() - ANCHOR) / PERIOD_MS)
}

/** Line the rounds of the chosen protocols up into two-week periods, oldest first. */
export function alignPeriods(byProtocol: Record<string, VlcvxRound[]>, included: string[]): Period[] {
  const slots = new Map<number, Period>()
  for (const protocol of included) {
    for (const r of byProtocol[protocol] ?? []) {
      if (!r.ends_at || r.dollar_per_vl == null) continue
      const index = periodIndex(r.ends_at)
      const slot = slots.get(index) ?? { index, endsAt: r.ends_at, rate: 0, totalDollars: 0, parts: {} }
      slot.rate += r.dollar_per_vl
      slot.totalDollars += r.total_amount_dollars ?? 0
      slot.parts[protocol] = (slot.parts[protocol] ?? 0) + r.dollar_per_vl
      if (r.ends_at > slot.endsAt) slot.endsAt = r.ends_at
      slots.set(index, slot)
    }
  }
  return [...slots.values()].sort((a, b) => a.index - b.index)
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const position = (p / 100) * (sorted.length - 1)
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

/** Running total of dollars per vlCVX, with the period it was reached in. */
export function cumulative(periods: Period[]): { endsAt: string; total: number }[] {
  let total = 0
  return periods.map((p) => ({ endsAt: p.endsAt, total: (total += p.rate) }))
}

/** Dollars one vlCVX earned over the latest `count` periods (26 is about a year). */
export function trailing(periods: Period[], count: number): number {
  return periods.slice(-count).reduce((s, p) => s + p.rate, 0)
}

/** Periods in a year, for annualising. */
export const PERIODS_PER_YEAR = 26

export interface Backtest {
  periods: number
  perVl: number
  dollars: number
  perPeriod: number
  perYear: number
  apr: number | null
}

/** What holding `amount` vlCVX (voting every round) would have paid over the latest `count` periods. */
export function backtest(periods: Period[], count: number, amount: number, price: number | null): Backtest {
  const window = periods.slice(-count)
  const perVl = window.reduce((s, p) => s + p.rate, 0)
  const perPeriod = window.length ? perVl / window.length : 0
  const perYear = perPeriod * PERIODS_PER_YEAR * amount
  return {
    periods: window.length,
    perVl,
    dollars: perVl * amount,
    perPeriod: perPeriod * amount,
    perYear,
    apr: price && price > 0 && amount > 0 ? perYear / (amount * price) : null,
  }
}

export interface FanPoint {
  period: number
  p10: number
  p50: number
  p90: number
}

export interface Projection {
  /** Dollars per vlCVX per period in the sample the futures are drawn from. */
  sample: number[]
  /** Cumulative dollars for the holding over the horizon, by period. */
  fan: FanPoint[]
  expectedPerPeriod: number
  perYear: { p10: number; p50: number; p90: number }
  total: { p10: number; p50: number; p90: number; mean: number }
  apr: { p10: number; p50: number; p90: number } | null
}

/**
 * Draw futures by picking past periods at random (with replacement) from the latest `lookback` ones, which keeps
 * how much payouts jump about from round to round. Returns the spread of what `amount` vlCVX would collect.
 */
export function project(
  periods: Period[],
  opts: { lookback: number; horizon: number; amount: number; price: number | null; trials?: number; seed?: number },
): Projection | null {
  const sample = periods.slice(-opts.lookback).map((p) => p.rate)
  if (sample.length === 0 || opts.horizon <= 0) return null
  const trials = opts.trials ?? 1000
  const rng = makeRng(opts.seed ?? 1)
  const paths: Float64Array[] = []
  for (let t = 0; t < trials; t++) {
    const path = new Float64Array(opts.horizon)
    let total = 0
    for (let i = 0; i < opts.horizon; i++) {
      total += sample[Math.floor(rng() * sample.length)] * opts.amount
      path[i] = total
    }
    paths.push(path)
  }
  const column = (i: number) => Array.from(paths, (p) => p[i])
  const fan = Array.from({ length: opts.horizon }, (_, i) => {
    const values = column(i)
    return { period: i + 1, p10: percentile(values, 10), p50: percentile(values, 50), p90: percentile(values, 90) }
  })
  const finals = column(opts.horizon - 1)
  const scale = PERIODS_PER_YEAR / opts.horizon
  const perYear = { p10: percentile(finals, 10) * scale, p50: percentile(finals, 50) * scale, p90: percentile(finals, 90) * scale }
  const basis = opts.price && opts.price > 0 && opts.amount > 0 ? opts.amount * opts.price : null
  return {
    sample,
    fan,
    expectedPerPeriod: mean(sample) * opts.amount,
    perYear,
    total: { p10: percentile(finals, 10), p50: percentile(finals, 50), p90: percentile(finals, 90), mean: mean(finals) },
    apr: basis ? { p10: perYear.p10 / basis, p50: perYear.p50 / basis, p90: perYear.p90 / basis } : null,
  }
}

// ------------------------------------------------------------------ formatting
export function usd(value: number | null | undefined, digits = 0): string {
  if (value == null || Number.isNaN(value)) return '–'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}

export function compactUsd(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '–'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function compact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '–'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '–'
  return `${(value * 100).toFixed(digits)}%`
}
