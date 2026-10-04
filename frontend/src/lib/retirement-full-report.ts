/**
 * The full retirement report as one self-contained HTML page: the projection
 * with charts, the settings it used, which assets are sold and when, the assets
 * that are not sold, and what the stress test says. Charts are inline SVG with
 * a hover title per year, so the file works offline and in any browser.
 */
import { CASH_ID, type Assumptions, type Projection, type ProjectionAsset, type WhatIf } from './retirement-projection'
import { buildReport, type ReportTable } from './retirement-report'
import {
  SWEEP_CRASH,
  SWEEP_SPEND,
  type BufferCell,
  type SimParams,
  type SimResult,
  type SweepCell,
} from './retirement-simulation'

type T = (key: string, options?: Record<string, unknown>) => string

export interface SimulationSection {
  params: SimParams
  result: SimResult
  /** Success rate by spending level and crash chance; null when it was not computed. */
  grid: SweepCell[] | null
  buffers: BufferCell[] | null
  /** Each asset you sell from and how the stress test treated it. */
  behaviour: { name: string; riskClass: string }[]
  runsPerCell: number
}

export interface FullReportInput {
  t: T
  currency: string
  locale: string
  now: Date
  assumptions: Assumptions
  whatIfs: WhatIf[]
  scenario: Projection
  baseline: Projection
  assets: ProjectionAsset[]
  fixedLines: { label: string; monthly: number }[]
  /** Lines with a last year, as a label and the calendar year. */
  endedLines: { label: string; year: number }[]
  living?: { monthly: number; inflates: boolean } | null
  /** Tax rates set for a single line, by kind (income, yield, rent, gains). */
  taxLines: { label: string; kind: string; rate: number }[]
  simulation: SimulationSection | null
}

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16', '#14b8a6', '#f97316']

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---------------------------------------------------------------- charts
interface Frame {
  w: number
  h: number
  left: number
  right: number
  top: number
  bottom: number
}
const FRAME: Frame = { w: 760, h: 260, left: 58, right: 14, top: 14, bottom: 26 }

function niceMax(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= value) ?? 10
  return step * power
}

class Axes {
  readonly max: number
  private readonly f: Frame
  private readonly count: number
  private readonly compact: (v: number) => string
  private readonly labels: string[]

  constructor(f: Frame, maxValue: number, count: number, compact: (v: number) => string, labels: string[]) {
    this.f = f
    this.count = count
    this.compact = compact
    this.labels = labels
    this.max = niceMax(maxValue)
  }
  x = (i: number) => this.f.left + (this.count <= 1 ? 0 : (i / (this.count - 1)) * (this.f.w - this.f.left - this.f.right))
  y = (v: number) => this.f.top + (1 - Math.max(0, v) / this.max) * (this.f.h - this.f.top - this.f.bottom)
  /** Gridlines, value labels on the left and a few year labels along the bottom. */
  frame(): string {
    const lines: string[] = []
    for (let k = 0; k <= 4; k++) {
      const v = (this.max / 4) * k
      lines.push(
        `<line x1="${this.f.left}" x2="${this.f.w - this.f.right}" y1="${this.y(v).toFixed(1)}" y2="${this.y(v).toFixed(1)}" stroke="#e2e8f0"/>`,
        `<text x="${this.f.left - 6}" y="${(this.y(v) + 3.5).toFixed(1)}" font-size="10" fill="#64748b" text-anchor="end">${esc(this.compact(v))}</text>`,
      )
    }
    const step = Math.max(1, Math.ceil(this.count / 8))
    for (let i = 0; i < this.count; i += step) {
      lines.push(`<text x="${this.x(i).toFixed(1)}" y="${this.f.h - 8}" font-size="10" fill="#64748b" text-anchor="middle">${esc(this.labels[i] ?? '')}</text>`)
    }
    return lines.join('')
  }
  /** One transparent column per year; hovering it shows `titles[i]`. */
  hover(titles: string[]): string {
    const slot = (this.f.w - this.f.left - this.f.right) / Math.max(1, this.count - 1)
    return titles
      .map((title, i) => `<rect x="${(this.x(i) - slot / 2).toFixed(1)}" y="${this.f.top}" width="${slot.toFixed(1)}" height="${this.f.h - this.f.top - this.f.bottom}" fill="transparent"><title>${esc(title)}</title></rect>`)
      .join('')
  }
}

const svg = (body: string, f: Frame = FRAME) => `<svg viewBox="0 0 ${f.w} ${f.h}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">${body}</svg>`

const legend = (items: { name: string; color: string; dash?: boolean }[]) =>
  `<div class="legend">${items
    .map((i) => `<span><i style="${i.dash ? `height:0;border-top:2px dashed ${i.color}` : `background:${i.color}`}"></i>${esc(i.name)}</span>`)
    .join('')}</div>`

interface LineSeries {
  name: string
  color: string
  values: number[]
  dash?: boolean
}

function lineChart(labels: string[], series: LineSeries[], compact: (v: number) => string, money: (v: number) => string): string {
  const axes = new Axes(FRAME, Math.max(1, ...series.flatMap((s) => s.values)), labels.length, compact, labels)
  const lines = series.map(
    (s) =>
      `<polyline fill="none" stroke="${s.color}" stroke-width="2"${s.dash ? ' stroke-dasharray="5 4"' : ''} points="${s.values.map((v, i) => `${axes.x(i).toFixed(1)},${axes.y(v).toFixed(1)}`).join(' ')}"/>`,
  )
  const titles = labels.map((label, i) => `${label}\n${series.map((s) => `${s.name}: ${money(s.values[i] ?? 0)}`).join('\n')}`)
  return legend(series) + svg(axes.frame() + lines.join('') + axes.hover(titles))
}

function stackedChart(labels: string[], series: LineSeries[], compact: (v: number) => string, money: (v: number) => string): string {
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0))
  const axes = new Axes(FRAME, Math.max(1, ...totals), labels.length, compact, labels)
  const barWidth = Math.max(2, ((FRAME.w - FRAME.left - FRAME.right) / Math.max(1, labels.length)) * 0.72)
  const bars: string[] = []
  labels.forEach((_, i) => {
    let base = 0
    for (const s of series) {
      const v = Math.max(0, s.values[i] ?? 0)
      if (v <= 0) continue
      const top = axes.y(base + v)
      const height = axes.y(base) - top
      bars.push(`<rect x="${(axes.x(i) - barWidth / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, height).toFixed(1)}" fill="${s.color}"/>`)
      base += v
    }
  })
  const titles = labels.map(
    (label, i) =>
      `${label}\n${series
        .filter((s) => (s.values[i] ?? 0) > 0.5)
        .map((s) => `${s.name}: ${money(s.values[i])}`)
        .join('\n')}\n= ${money(totals[i])}`,
  )
  return legend(series) + svg(axes.frame() + bars.join('') + axes.hover(titles))
}

interface Band {
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
}

function bandChart(labels: string[], bands: Band[], names: { wide: string; mid: string; median: string }, compact: (v: number) => string, money: (v: number) => string): string {
  const axes = new Axes(FRAME, Math.max(1, ...bands.map((b) => b.p90)), labels.length, compact, labels)
  const area = (low: (b: Band) => number, high: (b: Band) => number, fill: string) => {
    const top = bands.map((b, i) => `${axes.x(i).toFixed(1)},${axes.y(high(b)).toFixed(1)}`)
    const bottom = bands.map((b, i) => `${axes.x(i).toFixed(1)},${axes.y(low(b)).toFixed(1)}`).reverse()
    return `<polygon points="${[...top, ...bottom].join(' ')}" fill="${fill}"/>`
  }
  const median = `<polyline fill="none" stroke="#6366f1" stroke-width="2" points="${bands.map((b, i) => `${axes.x(i).toFixed(1)},${axes.y(b.p50).toFixed(1)}`).join(' ')}"/>`
  const titles = labels.map((label, i) => {
    const b = bands[i]
    return `${label}\n${names.wide}: ${money(b.p10)} – ${money(b.p90)}\n${names.mid}: ${money(b.p25)} – ${money(b.p75)}\n${names.median}: ${money(b.p50)}`
  })
  const key = legend([
    { name: names.wide, color: 'rgba(99,102,241,.25)' },
    { name: names.mid, color: 'rgba(99,102,241,.5)' },
    { name: names.median, color: '#6366f1' },
  ])
  return key + svg(axes.frame() + area((b) => b.p10, (b) => b.p90, 'rgba(99,102,241,.15)') + area((b) => b.p25, (b) => b.p75, 'rgba(99,102,241,.3)') + median + axes.hover(titles))
}

function shareChart(labels: string[], shares: number[], name: string): string {
  const f = { ...FRAME, h: 200 }
  const axes = new Axes(f, 100, labels.length, (v) => `${Math.round(v)}%`, labels)
  const points = shares.map((v, i) => `${axes.x(i).toFixed(1)},${axes.y(v * 100).toFixed(1)}`)
  const area = `<polygon points="${axes.x(0).toFixed(1)},${axes.y(0).toFixed(1)} ${points.join(' ')} ${axes.x(shares.length - 1).toFixed(1)},${axes.y(0).toFixed(1)}" fill="rgba(244,63,94,.18)"/>`
  const line = `<polyline fill="none" stroke="#f43f5e" stroke-width="2" points="${points.join(' ')}"/>`
  const titles = labels.map((label, i) => `${label}\n${name}: ${Math.round(shares[i] * 100)}%`)
  return svg(axes.frame() + area + line + axes.hover(titles), f)
}

// ---------------------------------------------------------------- tables
const table = ({ headers, rows }: ReportTable, options: { totalRow?: boolean } = {}) =>
  `<div class="scroll"><table><thead><tr>${headers.map((c, i) => `<th${i === 0 ? ' class="l"' : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r, ri) => `<tr${options.totalRow && ri === rows.length - 1 ? ' class="total"' : ''}>${r.map((c, i) => `<td${i === 0 ? ' class="l"' : ''}>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`

const cards = (items: { label: string; value: string; tone?: 'good' | 'bad' }[]) =>
  `<div class="cards">${items.map((s) => `<div class="card"><span>${esc(s.label)}</span><b class="${s.tone ?? ''}">${esc(s.value)}</b></div>`).join('')}</div>`

const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`

const heat = (rate: number) => `background:hsl(${Math.round(rate * 120)} 65% 45% / 0.35)`

// ---------------------------------------------------------------- report
export function buildFullReportHtml(input: FullReportInput): string {
  const { t, currency, locale, now, scenario, baseline, assets, assumptions: a, simulation } = input
  const base = buildReport({
    t,
    currency,
    locale,
    now,
    assumptions: a,
    whatIfs: input.whatIfs,
    scenario,
    baseline,
    assets,
    fixedLines: input.fixedLines,
    living: input.living,
  })
  const thisYear = now.getFullYear()
  const horizon = a.horizonYears
  const rows = scenario.rows
  const labels = rows.map((r) => String(thisYear + r.year))
  const money = (v: number) => new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Math.round(v))
  const compact = (v: number) => (v === 0 ? '0' : new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(v))
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const dash = (v: number) => (Math.abs(v) > 0.5 ? money(v) : '–')
  const r = (key: string, options?: Record<string, unknown>) => t(`retirement.fullReport.${key}`, options)

  const names: Record<string, string> = { [CASH_ID]: t('retirement.projection.cash') }
  for (const x of assets) names[x.id] = x.name
  const drawableIds = new Set<string>([CASH_ID, ...assets.filter((x) => x.drawable).map((x) => x.id)])

  // ---- projection charts
  const hasWhatIfs = input.whatIfs.length > 0
  const totalSeries: LineSeries[] = [
    { name: hasWhatIfs ? t('retirement.projection.withWhatIfsShort') : t('retirement.projection.baseline'), color: '#6366f1', values: rows.map((x) => Math.max(0, x.drawable)) },
    ...(hasWhatIfs ? [{ name: t('retirement.projection.baseline'), color: '#94a3b8', values: baseline.rows.map((x) => Math.max(0, x.drawable)), dash: true }] : []),
  ]
  const peak: Record<string, number> = {}
  for (const row of rows) for (const [id, v] of Object.entries(row.byAsset)) peak[id] = Math.max(peak[id] ?? 0, v)
  const bySize = (p: string, q: string) => (peak[q] ?? 0) - (peak[p] ?? 0)
  const sellIds = Object.keys(peak).filter((id) => drawableIds.has(id)).sort(bySize)
  const otherIds = Object.keys(peak).filter((id) => !drawableIds.has(id)).sort(bySize)
  const stackSeries: LineSeries[] = sellIds.map((id, i) => ({ name: names[id] ?? id, color: PALETTE[i % PALETTE.length], values: rows.map((x) => x.byAsset[id] ?? 0) }))
  const flowSeries: LineSeries[] = [
    { name: t('retirement.projection.income'), color: '#10b981', values: rows.map((x) => x.income) },
    { name: t('retirement.projection.outgoing'), color: '#f43f5e', values: rows.map((x) => x.outgoing) },
    ...(scenario.totalTax > 0 ? [{ name: t('retirement.projection.tax'), color: '#f59e0b', values: rows.map((x) => x.tax) }] : []),
  ]

  const summary = [...base.summary]
  if (scenario.totalTax > 0) summary.push({ label: t('retirement.projection.totalTax'), value: money(scenario.totalTax) })
  if (simulation) summary.push({ label: r('chanceLasts'), value: pct(simulation.result.successRate) })

  // ---- settings
  const settingsAssets: ReportTable = {
    headers: [...base.assets.headers, r('costBasis'), r('taxFree')],
    rows: [...assets.filter((x) => x.drawable && x.value > 0).sort((x, y) => y.value - x.value), ...assets.filter((x) => !x.drawable).sort((x, y) => y.value - x.value)].map((x, i) => [
      ...base.assets.rows[i],
      x.costBasis === undefined ? '–' : money(x.costBasis),
      x.taxFree ? t('retirement.report.yes') : t('retirement.report.no'),
    ]),
  }

  // ---- what is sold
  const soldTotals: Record<string, number> = {}
  for (const row of rows) for (const [id, v] of Object.entries(row.drawn)) soldTotals[id] = (soldTotals[id] ?? 0) + v
  const soldIds = Object.keys(soldTotals).filter((id) => soldTotals[id] > 0.5).sort((p, q) => soldTotals[q] - soldTotals[p])
  const sumOf = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((sum, row) => sum + pick(row), 0)
  const soldTable: ReportTable | null = soldIds.length
    ? {
        headers: [
          t('retirement.projection.tableYear'),
          t('retirement.report.phase'),
          t('retirement.projection.outgoing'),
          t('retirement.projection.income'),
          t('retirement.projection.tax'),
          r('shortfall'),
          ...soldIds.map((id) => names[id] ?? id),
          r('totalSold'),
          t('retirement.projection.tableTotal'),
        ],
        rows: [
          ...rows.map((row) => [
            String(thisYear + row.year),
            t(`retirement.projection.phase_${row.phase}`),
            money(row.outgoing),
            money(row.income),
            dash(row.tax),
            dash(Math.max(0, -row.netFlow)),
            ...soldIds.map((id) => dash(row.drawn[id] ?? 0)),
            dash(Object.values(row.drawn).reduce((s, v) => s + v, 0)),
            money(row.drawable),
          ]),
          [
            r('totals'),
            '',
            money(sumOf((x) => x.outgoing)),
            money(sumOf((x) => x.income)),
            dash(sumOf((x) => x.tax)),
            dash(sumOf((x) => Math.max(0, -x.netFlow))),
            ...soldIds.map((id) => dash(soldTotals[id])),
            dash(sumOf((x) => Object.values(x.drawn).reduce((s, v) => s + v, 0))),
            '',
          ],
        ],
      }
    : null
  const unfundedYear = rows.find((x) => x.unfunded > 0.5)

  // ---- tax
  const kinds = ['income', 'yield', 'rent', 'gains'] as const
  const kindTotals = Object.fromEntries(kinds.map((k) => [k, rows.reduce((sum, row) => sum + row.taxKinds[k], 0)])) as Record<(typeof kinds)[number], number>
  const taxTable: ReportTable | null =
    scenario.totalTax > 0.5
      ? {
          headers: [t('retirement.projection.tableYear'), ...kinds.map((k) => t(`retirement.tax.kind_${k}`)), t('retirement.projection.tableTotal'), t('retirement.tax.shareShort')],
          rows: [
            ...rows.map((row) => [
              String(thisYear + row.year),
              ...kinds.map((k) => dash(row.taxKinds[k])),
              dash(row.tax),
              row.income > 0 && row.tax > 0.5 ? pct(row.tax / row.income) : '–',
            ]),
            [r('totals'), ...kinds.map((k) => dash(kindTotals[k])), dash(scenario.totalTax), rows.reduce((sum, x) => sum + x.income, 0) > 0 ? pct(scenario.totalTax / rows.reduce((sum, x) => sum + x.income, 0)) : '–'],
          ],
        }
      : null

  // ---- the rest
  const otherTable: ReportTable | null = otherIds.length
    ? {
        headers: [t('retirement.projection.tableYear'), ...otherIds.map((id) => names[id] ?? id), r('combined'), t('retirement.projection.tableNetWorth')],
        rows: rows.map((row) => [
          String(thisYear + row.year),
          ...otherIds.map((id) => dash(row.byAsset[id] ?? 0)),
          money(otherIds.reduce((s, id) => s + (row.byAsset[id] ?? 0), 0)),
          money(row.netWorth),
        ]),
      }
    : null

  // ---- simulation
  const sim = simulation
  const simHtml = (() => {
    if (!sim) return `<p class="muted">${esc(r('simulationMissing'))}</p>`
    const view = sim.params.todaysMoney ? sim.result.real : sim.result.nominal
    const bands = view.bands
    const settings = [
      { label: r('futures'), value: String(sim.result.runs) },
      { label: r('seed'), value: String(sim.params.seed) },
      { label: t('retirement.simulate.volatility'), value: `×${sim.params.volatilityScale}` },
      { label: t('retirement.simulate.crashChanceLabel'), value: `${sim.params.crashChancePercent}%` },
      { label: r('crashDepth'), value: `${sim.params.crashMinPercent}–${sim.params.crashMaxPercent}%` },
      { label: r('slump'), value: r('slumpValue', { years: sim.params.slumpYears, cut: sim.params.slumpCutPercent }) },
      { label: t('retirement.simulate.inflationSpread'), value: `${sim.params.inflationSpread}` },
      { label: r('spike'), value: r('spikeValue', { chance: sim.params.spikeChancePercent, extra: sim.params.spikeExtraPoints }) },
      { label: r('moneyShown'), value: sim.params.todaysMoney ? t('retirement.simulate.todaysMoney') : t('retirement.simulate.futureMoney') },
    ]
    const parts: string[] = []
    parts.push(
      cards([
        { label: t('retirement.simulate.successRate'), value: pct(sim.result.successRate), tone: sim.result.successRate >= 0.9 ? 'good' : sim.result.successRate < 0.7 ? 'bad' : undefined },
        { label: t('retirement.simulate.typicalEnd'), value: money(view.medianEnd) },
        { label: t('retirement.simulate.badEnd'), value: money(view.worstCaseEnd) },
        { label: t('retirement.simulate.runsOut'), value: sim.result.medianRunOutYear === null ? t('retirement.simulate.never') : String(thisYear + sim.result.medianRunOutYear) },
      ]),
    )
    parts.push(`<h3>${esc(t('retirement.simulate.fanTitle'))}</h3>`)
    parts.push(bandChart(labels, bands, { wide: t('retirement.simulate.band8'), mid: t('retirement.simulate.band5'), median: t('retirement.simulate.median') }, compact, money))
    parts.push(`<p class="muted">${esc(sim.params.todaysMoney ? t('retirement.simulate.fanHintToday') : t('retirement.simulate.fanHint'))}</p>`)
    parts.push(`<h3>${esc(t('retirement.simulate.depletedTitle'))}</h3>`)
    parts.push(shareChart(labels, sim.result.depletedBy, t('retirement.simulate.depletedShare')))
    if (sim.grid && sim.grid.length) {
      parts.push(`<h3>${esc(t('retirement.simulate.sweepTitle'))}</h3><p class="muted">${esc(t('retirement.simulate.sweepSubtitle'))}</p>`)
      parts.push(
        `<div class="scroll"><table class="grid"><thead><tr><th class="l">${esc(t('retirement.simulate.crashRow'))}</th>${SWEEP_SPEND.map((s) => `<th>${Math.round(s * 100)}%</th>`).join('')}</tr></thead><tbody>${SWEEP_CRASH.map(
          (crash) =>
            `<tr><th class="l">${esc(t('retirement.simulate.crashChance', { percent: crash }))}</th>${SWEEP_SPEND.map((spend) => {
              const cell = sim.grid!.find((c) => c.crash === crash && c.spend === spend)
              return `<td style="${cell ? heat(cell.successRate) : ''}">${cell ? pct(cell.successRate) : ''}</td>`
            }).join('')}</tr>`,
        ).join('')}</tbody></table></div><p class="muted">${esc(t('retirement.simulate.sweepHint', { runs: sim.runsPerCell }))}</p>`,
      )
    }
    if (sim.buffers && sim.buffers.length) {
      parts.push(`<h3>${esc(t('retirement.simulate.bufferTitle'))}</h3><p class="muted">${esc(t('retirement.simulate.bufferSubtitle'))}</p>`)
      parts.push(
        `<div class="scroll"><table class="grid"><thead><tr><th class="l">${esc(t('retirement.simulate.bufferRow'))}</th>${sim.buffers
          .map((c) => `<th>${esc(c.years === 0 ? t('retirement.simulate.noBuffer') : t('retirement.simulate.bufferYearsCell', { years: c.years }))}</th>`)
          .join('')}</tr></thead><tbody><tr><th class="l">${esc(t('retirement.simulate.successRate'))}</th>${sim.buffers
          .map((c) => `<td style="${heat(c.successRate)}">${pct(c.successRate)}</td>`)
          .join('')}</tr><tr><th class="l">${esc(t('retirement.simulate.bufferTypical'))}</th>${sim.buffers.map((c) => `<td>${esc(money(c.medianEnd))}</td>`).join('')}</tr></tbody></table></div>`,
      )
    }
    parts.push(`<h3>${esc(r('simSettings'))}</h3>`)
    parts.push(list(settings.map((s) => `${s.label}: ${s.value}`)))
    if (sim.behaviour.length) {
      parts.push(`<h3>${esc(t('retirement.simulate.classesTitle'))}</h3>`)
      parts.push(list(sim.behaviour.map((b) => `${b.name}: ${t(`retirement.simulate.class_${b.riskClass}`)}`)))
    }
    parts.push(`<p class="muted">${esc(t('retirement.simulate.disclaimer'))}</p>`)
    return parts.join('')
  })()

  const sections = [
    ['summary', base.labels.summary],
    ['projection', r('projection')],
    ['settings', r('settings')],
    ...(taxTable ? ([['tax', r('tax')]] as const) : []),
    ['sold', r('sold')],
    ['others', r('others')],
    ['simulation', r('simulation')],
    ['years', base.labels.years],
  ] as const

  return `<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(base.title)}</title><style>
* { box-sizing: border-box; }
body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #0f172a; background: #f8fafc; margin: 0; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 36px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; } h3 { font-size: 14px; margin: 22px 0 6px; }
.sub, .muted { color: #64748b; } .muted { font-size: 12px; margin: 4px 0; }
nav { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 14px 0 0; font-size: 13px; } nav a { color: #4f46e5; text-decoration: none; } nav a:hover { text-decoration: underline; }
section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 4px 18px 18px; margin-top: 18px; }
section > h2 { border: 0; margin-top: 14px; }
.cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0; } .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; min-width: 160px; background: #fff; }
.card span { display: block; color: #64748b; font-size: 11px; } .card b { font-size: 18px; } .good { color: #059669; } .bad { color: #e11d48; }
ul { margin: 6px 0; padding-left: 20px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: #475569; margin: 6px 0 2px; } .legend i { display: inline-block; width: 14px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
.scroll { overflow-x: auto; margin: 6px 0; border: 1px solid #e2e8f0; border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 4px 9px; text-align: right; white-space: nowrap; border-bottom: 1px solid #f1f5f9; } th { background: #f8fafc; font-weight: 600; position: sticky; top: 0; }
th.l, td.l { text-align: left; position: sticky; left: 0; background: inherit; } td.l { background: #fff; } tr.total td { font-weight: 700; background: #f8fafc; border-top: 2px solid #cbd5e1; } tr.total td.l { background: #f8fafc; }
table.grid td { text-align: center; }
svg { background: #fff; border-radius: 8px; }
.note { color: #64748b; font-size: 12px; margin-top: 28px; }
@media print { body { background: #fff; } section { border: 0; padding: 0; break-inside: auto; } nav { display: none; } .scroll { overflow: visible; border: 0; } table { font-size: 8px; } th, td { padding: 2px 4px; } th, th.l, td.l { position: static; } tr { break-inside: avoid; } @page { size: A4 landscape; margin: 10mm; } }
</style></head><body><main>
<h1>${esc(base.title)}</h1><p class="sub">${esc(base.subtitle)}</p>
<nav>${sections.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join('')}</nav>

<section id="summary"><h2>${esc(base.labels.summary)}</h2>${cards(summary)}</section>

<section id="projection"><h2>${esc(r('projection'))}</h2>
<h3>${esc(t('retirement.projection.chartAssets'))}</h3>${lineChart(labels, totalSeries, compact, money)}
<h3>${esc(r('byAsset'))}</h3>${stackedChart(labels, stackSeries, compact, money)}
<h3>${esc(t('retirement.projection.chartFlows'))}</h3>${lineChart(labels, flowSeries, compact, money)}
<p class="muted">${esc(r('hoverHint'))}</p></section>

<section id="settings"><h2>${esc(r('settings'))}</h2>
<h3>${esc(base.labels.assumptions)}</h3>${list(base.assumptions.map((s) => `${s.label}: ${s.value}`))}
<h3>${esc(base.labels.whatIfs)}</h3>${list(base.whatIfs.length ? base.whatIfs : [base.labels.none])}
${input.endedLines.length ? `<h3>${esc(r('endedLines'))}</h3>${list(input.endedLines.map((l) => `${l.label}: ${r('countsUntil', { year: l.year })}`))}` : ''}
${base.fixed.length ? `<h3>${esc(base.labels.fixed)}</h3>${list(base.fixed)}` : ''}
${input.taxLines.length ? `<h3>${esc(r('taxLines'))}</h3>${list(input.taxLines.map((l) => `${l.label} (${t(`retirement.tax.kind_${l.kind}`)}): ${Number(l.rate.toFixed(2))}%`))}` : ''}
<h3>${esc(base.labels.assets)}</h3>${table(settingsAssets)}</section>

${taxTable ? `<section id="tax"><h2>${esc(r('tax'))}</h2><p class="muted">${esc(r('taxHint'))}</p>${table(taxTable, { totalRow: true })}</section>` : ''}

<section id="sold"><h2>${esc(r('sold'))}</h2>
${
  soldTable
    ? `<p class="muted">${esc(r('soldHint'))}</p>${table(soldTable, { totalRow: true })}${unfundedYear ? `<p class="bad">${esc(r('runsDry', { year: thisYear + unfundedYear.year }))}</p>` : ''}`
    : `<p class="muted">${esc(r('nothingSold', { years: horizon }))}</p>`
}</section>

<section id="others"><h2>${esc(r('others'))}</h2>
${otherTable ? `<p class="muted">${esc(r('othersHint'))}</p>${table(otherTable)}` : `<p class="muted">${esc(r('noOthers'))}</p>`}</section>

<section id="simulation"><h2>${esc(r('simulation'))}</h2>${simHtml}</section>

<section id="years"><h2>${esc(base.labels.years)}</h2>${table(base.years)}</section>

<p class="note">${esc(base.disclaimer)}</p>
</main></body></html>`
}
