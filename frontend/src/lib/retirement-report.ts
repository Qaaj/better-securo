import type { Assumptions, Projection, ProjectionAsset, WhatIf } from './retirement-projection'
import { CASH_ID } from './retirement-projection'

type T = (key: string, options?: Record<string, unknown>) => string

export interface ReportTable {
  headers: string[]
  rows: string[][]
}

export interface Report {
  title: string
  subtitle: string
  summary: { label: string; value: string }[]
  assumptions: { label: string; value: string }[]
  whatIfs: string[]
  assets: ReportTable
  fixed: string[]
  years: ReportTable
  disclaimer: string
  chart: { labels: string[]; scenario: number[]; baseline: number[] | null }
  labels: { summary: string; assumptions: string; whatIfs: string; none: string; assets: string; fixed: string; years: string; chart: string; baseline: string; scenario: string }
}

export interface ReportInput {
  t: T
  currency: string
  locale: string
  now: Date
  assumptions: Assumptions
  whatIfs: WhatIf[]
  scenario: Projection
  baseline: Projection
  assets: ProjectionAsset[]
  /** Lines kept at a fixed amount instead of rising with inflation, with what they come to a month. */
  fixedLines: { label: string; monthly: number }[]
}

/** One line for a what-if, shared by the page and the report. */
export function describeWhatIf(t: T, w: WhatIf, thisYear: number): string {
  const same = w.kind !== 'sell' && w.kind !== 'oneoff' && w.inflates === false ? ` · ${t('retirement.projection.staysTheSame')}` : ''
  if (w.kind === 'sell') return t('retirement.projection.describeSell', { year: thisYear + w.year, fees: w.feesPercent })
  if (w.kind === 'spend') return t('retirement.projection.describeSpend', { amount: w.monthly, from: thisYear + w.fromYear }) + same
  if (w.kind === 'oneoff') return t('retirement.projection.describeOneoff', { amount: w.amount, year: thisYear + w.year })
  return (
    t('retirement.projection.describeMonthly', {
      amount: w.monthly,
      from: thisYear + w.fromYear,
      to: w.toYear !== undefined ? thisYear + w.toYear : t('retirement.projection.onwards'),
    }) + same
  )
}

export function buildReport(input: ReportInput): Report {
  const { t, currency, locale, now, assumptions: a, whatIfs, scenario, baseline, assets, fixedLines } = input
  const thisYear = now.getFullYear()
  const money = (v: number) => new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Math.round(v))
  const pct = (v: number) => `${Number(v.toFixed(2))}%`
  const horizon = a.horizonYears
  const startYear = a.drawdownStartYear ?? 0
  const hasWhatIfs = whatIfs.length > 0
  const runway = (years: number | null) =>
    years === null
      ? t('retirement.projection.beyond', { years: horizon })
      : t('retirement.projection.years', { years: years.toFixed(1), calendar: thisYear + Math.floor(years) })

  const summary = [{ label: t('retirement.projection.runway'), value: runway(scenario.runwayYears) }]
  if (hasWhatIfs) summary.push({ label: t('retirement.projection.runwayBaseline'), value: runway(baseline.runwayYears) })
  summary.push({ label: t('retirement.projection.drawableNow'), value: money(scenario.drawableNow) })
  summary.push({ label: t('retirement.projection.inYears', { years: horizon }), value: money(scenario.rows[horizon - 1]?.drawable ?? 0) })
  if (scenario.leftAtEnd !== null && a.drawdownEndYear !== undefined) {
    summary.push({ label: t('retirement.projection.leftAtEnd', { year: thisYear + a.drawdownEndYear }), value: money(scenario.leftAtEnd) })
  }
  summary.push({ label: t('retirement.report.netWorthNow'), value: money(scenario.netWorthNow) })

  const assumptions = [
    { label: t('retirement.projection.horizon'), value: `${horizon} ${t('retirement.projection.yearsSuffix')} (${thisYear}–${thisYear + horizon - 1})` },
    { label: t('retirement.projection.inflation'), value: pct(a.inflationPercent) },
    { label: t('retirement.projection.incomeIndexed'), value: a.incomeIndexed ? t('retirement.report.yes') : t('retirement.report.no') },
    { label: t('retirement.report.drawdownStarts'), value: String(thisYear + startYear) },
    {
      label: t('retirement.report.drawdownEnds'),
      value: a.drawdownEndYear !== undefined ? String(thisYear + a.drawdownEndYear) : t('retirement.report.openEnded'),
    },
    {
      label: t('retirement.projection.sellStrategy'),
      value: a.sellStrategy === 'ordered' ? t('retirement.projection.strategyOrdered') : t('retirement.projection.strategyProRata'),
    },
    ...(a.taxIncomePercent || a.taxAssetIncomePercent || a.taxGainsPercent
      ? [
          { label: t('retirement.projection.taxIncome'), value: pct(a.taxIncomePercent ?? 0) },
          { label: t('retirement.projection.taxAssetIncome'), value: pct(a.taxAssetIncomePercent ?? 0) },
          { label: t('retirement.projection.taxGains'), value: pct(a.taxGainsPercent ?? 0) },
        ]
      : []),
    ...(a.bufferYears ? [{ label: t('retirement.projection.bufferYears'), value: `${a.bufferYears} ${t('retirement.projection.yearsSuffix')}` }] : []),
  ]

  const sellFrom = assets.filter((x) => x.drawable && x.value > 0).sort((x, y) => y.value - x.value)
  const others = assets.filter((x) => !x.drawable).sort((x, y) => y.value - x.value)
  const assetRow = (x: ProjectionAsset) => [
    x.temporary ? `${x.name} (${t('retirement.projection.tempBadge')}${x.startYear ? ` ${thisYear + x.startYear}` : ''})` : x.name,
    money(x.value),
    x.drawable ? t('retirement.report.yes') : t('retirement.report.no'),
    pct(x.growthPercent ?? 0),
    x.yieldPercent ? pct(x.yieldPercent) : '–',
    x.fixedMonthly ? `${money(x.fixedMonthly)}${t('retirement.report.perMonthShort')}` : '–',
    a.sellStrategy === 'ordered' && x.drawable ? String(x.sellOrder ?? '–') : '–',
  ]
  const assetTable: ReportTable = {
    headers: [
      t('retirement.report.asset'),
      t('retirement.report.value'),
      t('retirement.projection.assetsYouSellFromShort'),
      t('retirement.projection.growthPerYear'),
      t('retirement.report.yield'),
      t('retirement.report.rent'),
      t('retirement.projection.sellOrderShort'),
    ],
    rows: [...sellFrom, ...others].map(assetRow),
  }

  // Years: a column per asset, those you sell from first.
  const peak: Record<string, number> = {}
  const names: Record<string, string> = { [CASH_ID]: t('retirement.projection.cash') }
  for (const x of assets) names[x.id] = x.name
  for (const row of scenario.rows) for (const [id, v] of Object.entries(row.byAsset)) peak[id] = Math.max(peak[id] ?? 0, v)
  const drawableIds = new Set([CASH_ID, ...assets.filter((x) => x.drawable).map((x) => x.id)])
  const bySize = (p: string, q: string) => (peak[q] ?? 0) - (peak[p] ?? 0)
  const sellCols = Object.keys(peak).filter((id) => drawableIds.has(id)).sort(bySize)
  const otherCols = Object.keys(peak).filter((id) => !drawableIds.has(id)).sort(bySize)
  const years: ReportTable = {
    headers: [
      t('retirement.projection.tableYear'),
      t('retirement.report.phase'),
      ...sellCols.map((id) => names[id] ?? id),
      t('retirement.projection.tableTotal'),
      ...otherCols.map((id) => names[id] ?? id),
      t('retirement.projection.income'),
      t('retirement.projection.outgoing'),
      t('retirement.projection.tableSold'),
      t('retirement.projection.tableNetWorth'),
    ],
    rows: scenario.rows.map((row) => [
      String(thisYear + row.year),
      t(`retirement.projection.phase_${row.phase}`),
      ...sellCols.map((id) => (row.byAsset[id] ? money(row.byAsset[id]) : '–')),
      money(row.drawable),
      ...otherCols.map((id) => (row.byAsset[id] ? money(row.byAsset[id]) : '–')),
      money(row.income),
      money(row.outgoing),
      Object.values(row.drawn).reduce((s, v) => s + v, 0) > 0.5 ? money(Object.values(row.drawn).reduce((s, v) => s + v, 0)) : '–',
      money(row.netWorth),
    ]),
  }

  return {
    title: t('retirement.report.title'),
    subtitle: `${t('retirement.report.generated', { date: now.toLocaleDateString(locale, { dateStyle: 'long' }) })} · ${t('retirement.report.currency', { currency })}`,
    summary,
    assumptions,
    whatIfs: whatIfs.map((w) => `${w.label}: ${describeWhatIf(t, w, thisYear)}`),
    assets: assetTable,
    fixed: fixedLines.map((l) => `${l.label} (${money(l.monthly)}${t('retirement.report.perMonthShort')})`),
    years,
    disclaimer: t('retirement.projection.disclaimer'),
    chart: {
      labels: scenario.rows.map((r) => String(thisYear + r.year)),
      scenario: scenario.rows.map((r) => Math.max(r.drawable, 0)),
      baseline: hasWhatIfs ? baseline.rows.map((r) => Math.max(r.drawable, 0)) : null,
    },
    labels: {
      summary: t('retirement.report.summary'),
      assumptions: t('retirement.projection.assumptions'),
      whatIfs: t('retirement.projection.whatIfs'),
      none: t('retirement.report.none'),
      assets: t('retirement.report.assets'),
      fixed: t('retirement.report.fixed'),
      years: t('retirement.report.years'),
      chart: t('retirement.projection.chartAssets'),
      baseline: t('retirement.projection.baseline'),
      scenario: hasWhatIfs ? t('retirement.projection.withWhatIfsShort') : t('retirement.projection.baseline'),
    },
  }
}

// --------------------------------------------------------------- Markdown
const mdCell = (s: string) => s.replace(/\|/g, '\\|')
const mdTable = ({ headers, rows }: ReportTable) =>
  [`| ${headers.map(mdCell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n')

export function reportToMarkdown(r: Report): string {
  const out: string[] = [`# ${r.title}`, '', `_${r.subtitle}_`, '']
  out.push(`## ${r.labels.summary}`, '', ...r.summary.map((s) => `- **${s.label}:** ${s.value}`), '')
  out.push(`## ${r.labels.assumptions}`, '', ...r.assumptions.map((s) => `- ${s.label}: ${s.value}`), '')
  out.push(`## ${r.labels.whatIfs}`, '', ...(r.whatIfs.length ? r.whatIfs.map((w) => `- ${w}`) : [`- ${r.labels.none}`]), '')
  out.push(`## ${r.labels.assets}`, '', mdTable(r.assets), '')
  if (r.fixed.length) out.push(`## ${r.labels.fixed}`, '', ...r.fixed.map((f) => `- ${f}`), '')
  out.push(`## ${r.labels.years}`, '', mdTable(r.years), '')
  out.push(`> ${r.disclaimer}`, '')
  return out.join('\n')
}

// ------------------------------------------------------------------- HTML / PDF
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A small line chart as inline SVG, so the printed report carries the picture. */
export function chartSvg(chart: Report['chart'], labels: Pick<Report['labels'], 'baseline' | 'scenario'>): string {
  const w = 720
  const h = 240
  const m = { top: 12, right: 12, bottom: 28, left: 12 }
  const series = [chart.scenario, ...(chart.baseline ? [chart.baseline] : [])]
  const max = Math.max(1, ...series.flat())
  const n = Math.max(1, chart.scenario.length - 1)
  const x = (i: number) => m.left + (i / n) * (w - m.left - m.right)
  const y = (v: number) => m.top + (1 - v / max) * (h - m.top - m.bottom)
  const line = (values: number[], stroke: string, dash = '') =>
    `<polyline fill="none" stroke="${stroke}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''} points="${values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`
  const ticks = [0, Math.floor(n / 2), n].filter((v, i, all) => all.indexOf(v) === i)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" role="img">`,
    `<rect width="${w}" height="${h}" fill="#fff"/>`,
    `<line x1="${m.left}" y1="${y(0)}" x2="${w - m.right}" y2="${y(0)}" stroke="#cbd5e1"/>`,
    chart.baseline ? line(chart.baseline, '#94a3b8', '5 4') : '',
    line(chart.scenario, '#6366f1'),
    ...ticks.map((i) => `<text x="${x(i)}" y="${h - 8}" font-size="11" fill="#64748b" text-anchor="${i === 0 ? 'start' : i === n ? 'end' : 'middle'}">${esc(chart.labels[i] ?? '')}</text>`),
    `<text x="${m.left + 4}" y="${m.top + 10}" font-size="11" fill="#64748b">${esc(chart.baseline ? `${labels.scenario} / ${labels.baseline}` : labels.scenario)}</text>`,
    '</svg>',
  ].join('')
}

const htmlTable = ({ headers, rows }: ReportTable, className = '') =>
  `<table class="${className}"><thead><tr>${headers.map((c, i) => `<th${i === 0 ? ' class="l"' : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="l"' : ''}>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`

export function reportToHtml(r: Report): string {
  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: #0f172a; margin: 0; }
h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 14px; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #e2e8f0; }
.sub { color: #64748b; margin: 0 0 8px; }
.cards { display: flex; flex-wrap: wrap; gap: 8px; } .card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; min-width: 150px; }
.card b { display: block; font-size: 15px; } .card span { color: #64748b; font-size: 10px; }
ul { margin: 4px 0; padding-left: 18px; }
table { width: 100%; border-collapse: collapse; font-size: 9px; } th, td { border: 1px solid #e2e8f0; padding: 2px 5px; text-align: right; white-space: nowrap; }
th { background: #f8fafc; } th.l, td.l { text-align: left; } tr { break-inside: avoid; } thead { display: table-header-group; }
.note { color: #64748b; font-size: 10px; margin-top: 14px; }
</style></head><body>
<h1>${esc(r.title)}</h1><p class="sub">${esc(r.subtitle)}</p>
<div class="cards">${r.summary.map((s) => `<div class="card"><span>${esc(s.label)}</span><b>${esc(s.value)}</b></div>`).join('')}</div>
<h2>${esc(r.labels.chart)}</h2>${chartSvg(r.chart, r.labels)}
<h2>${esc(r.labels.assumptions)}</h2>${list(r.assumptions.map((s) => `${s.label}: ${s.value}`))}
<h2>${esc(r.labels.whatIfs)}</h2>${list(r.whatIfs.length ? r.whatIfs : [r.labels.none])}
<h2>${esc(r.labels.assets)}</h2>${htmlTable(r.assets)}
${r.fixed.length ? `<h2>${esc(r.labels.fixed)}</h2>${list(r.fixed)}` : ''}
<h2>${esc(r.labels.years)}</h2>${htmlTable(r.years)}
<p class="note">${esc(r.disclaimer)}</p>
</body></html>`
}
