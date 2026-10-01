import { useTranslation } from 'react-i18next'
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CASH_ID, type Projection, type YearRow } from '@/lib/retirement-projection'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'

const PALETTE = ['#6366F1', '#10B981', '#F59E0B', '#F43F5E', '#06B6D4', '#8B5CF6', '#84CC16', '#EC4899']
const OTHER_COLOR = '#94A3B8'
const BASELINE_COLOR = '#94A3B8'
const SCENARIO_COLOR = '#6366F1'
const MAX_BANDS = 8

export type ChartMode = 'total' | 'assets' | 'table'

interface Props {
  scenario: Projection
  baseline: Projection
  hasWhatIfs: boolean
  /** Names by asset id. */
  names: Record<string, string>
  /** Assets the plan sells from, by id. */
  drawableIds: ReadonlySet<string>
  thisYear: number
  currency: string
  locale: string
  mode: ChartMode
  startYear: number
  endYear?: number
  privacyMode: boolean
  mask: string
}

function compact(value: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

const tooltipStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
}

/** The pool over time: one line, or stacked bands per asset. Hovering a year
 *  lists every asset's value, the income and outgoing, and what was sold. */
export function AssetsChart(props: Props) {
  const { scenario, baseline, hasWhatIfs, names, drawableIds, thisYear, currency, locale, mode, startYear, endYear, privacyMode, mask } = props
  const { t } = useTranslation()

  // The biggest assets to sell from get a band each; the rest share one.
  const peak: Record<string, number> = {}
  for (const row of scenario.rows) for (const [id, v] of Object.entries(row.byAsset)) peak[id] = Math.max(peak[id] ?? 0, v)
  const ranked = [...drawableIds].filter((id) => (peak[id] ?? 0) > 0).sort((a, b) => (peak[b] ?? 0) - (peak[a] ?? 0))
  const banded = ranked.slice(0, MAX_BANDS)
  const bandName = (id: string) => (id === CASH_ID ? t('retirement.projection.cash') : names[id] ?? id)

  const data = scenario.rows.map((row, i) => {
    const point: Record<string, number | string> = {
      label: String(thisYear + row.year),
      year: row.year,
      scenario: Math.max(row.drawable, 0),
      baseline: Math.max(baseline.rows[i]?.drawable ?? 0, 0),
    }
    let rest = 0
    for (const [id, value] of Object.entries(row.byAsset)) {
      if (!drawableIds.has(id)) continue
      if (banded.includes(id)) point[id] = value
      else rest += value
    }
    point.__other__ = rest
    return point
  })

  const axis = (v: number) => (privacyMode ? '' : v === 0 ? '0' : compact(v, currency, locale))
  const money = (v: number) => (privacyMode ? mask : formatCurrency(v, currency, locale))
  const startLabel = String(thisYear + startYear)
  const endLabel = endYear !== undefined ? String(thisYear + endYear) : undefined

  const tooltip = ({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload: { year: number } }> }) => {
    if (!active || !payload?.length) return null
    const row = scenario.rows[payload[0].payload.year]
    if (!row) return null
    return <YearTooltip row={row} year={thisYear + row.year} names={names} drawableIds={drawableIds} money={money} />
  }

  const common = { data, margin: { top: 8, right: 16, left: 0, bottom: 0 } }
  const xAxis = <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
  const yAxis = <YAxis tickFormatter={axis} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} width={64} />
  const markers = (
    <>
      {startYear > 0 && <ReferenceLine x={startLabel} stroke="var(--muted-foreground)" strokeDasharray="4 3" label={{ value: t('retirement.projection.markerStart'), fontSize: 10, fill: 'var(--muted-foreground)', position: 'insideTopLeft' }} />}
      {endLabel && <ReferenceLine x={endLabel} stroke="var(--muted-foreground)" strokeDasharray="4 3" label={{ value: t('retirement.projection.markerEnd'), fontSize: 10, fill: 'var(--muted-foreground)', position: 'insideTopRight' }} />}
    </>
  )

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        {mode === 'assets' ? (
          <AreaChart {...common}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            {xAxis}
            {yAxis}
            <Tooltip content={tooltip} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {banded.map((id, i) => (
              <Area key={id} type="monotone" stackId="pool" dataKey={id} name={bandName(id)} stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]} fillOpacity={0.55} strokeWidth={1} />
            ))}
            <Area type="monotone" stackId="pool" dataKey="__other__" name={t('retirement.projection.otherAssets')} stroke={OTHER_COLOR} fill={OTHER_COLOR} fillOpacity={0.45} strokeWidth={1} />
            {markers}
          </AreaChart>
        ) : (
          <LineChart {...common}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            {xAxis}
            {yAxis}
            <Tooltip content={tooltip} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke="var(--border)" />
            {hasWhatIfs && <Line type="monotone" dataKey="baseline" name={t('retirement.projection.baseline')} stroke={BASELINE_COLOR} strokeDasharray="5 4" dot={false} strokeWidth={2} />}
            <Line type="monotone" dataKey="scenario" name={hasWhatIfs ? t('retirement.projection.withWhatIfsShort') : t('retirement.projection.baseline')} stroke={SCENARIO_COLOR} dot={false} strokeWidth={2.5} />
            {markers}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

export function YearTooltip({
  row,
  year,
  names,
  drawableIds,
  money,
}: {
  row: YearRow
  year: number
  names: Record<string, string>
  drawableIds: ReadonlySet<string>
  money: (v: number) => string
}) {
  const { t } = useTranslation()
  const name = (id: string) => (id === CASH_ID ? t('retirement.projection.cash') : names[id] ?? id)
  const entries = (select: (id: string) => boolean) =>
    Object.entries(row.byAsset)
      .filter(([id]) => select(id))
      .sort((a, b) => b[1] - a[1])
  const sellFrom = entries((id) => drawableIds.has(id))
  const others = entries((id) => !drawableIds.has(id))
  const sold = Object.entries(row.drawn).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1])
  const otherIncome = Math.max(0, row.income - row.assetIncome - row.saleIncome)
  const line = 'flex justify-between gap-4'
  return (
    <div style={tooltipStyle} className="px-3 py-2 min-w-56 max-w-72">
      <div className="flex items-center justify-between gap-3 mb-1">
        <p className="text-xs font-semibold">{year}</p>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t(`retirement.projection.phase_${row.phase}`)}</p>
      </div>
      <div className={cn(line, 'text-xs font-medium')}>
        <span>{t('retirement.projection.tooltipPool')}</span>
        <span className="tabular-nums">{money(row.drawable)}</span>
      </div>
      <div className="mt-1 space-y-0.5 text-[11px]">
        {sellFrom.slice(0, 9).map(([id, value]) => (
          <div key={id} className={cn(line, 'text-muted-foreground')}>
            <span className="truncate">{name(id)}</span>
            <span className="tabular-nums">{money(value)}</span>
          </div>
        ))}
        {sellFrom.length > 9 && <p className="text-muted-foreground">+{sellFrom.length - 9}</p>}
      </div>
      {others.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t('retirement.projection.tooltipOthers', { amount: money(others.reduce((sum, [, v]) => sum + v, 0)) })}
        </p>
      )}
      <div className="mt-2 pt-2 border-t border-border space-y-0.5 text-[11px]">
        <div className={line}><span className="text-emerald-600">{t('retirement.projection.tooltipAssetIncome')}</span><span className="tabular-nums">{money(row.assetIncome)}</span></div>
        {row.saleIncome > 0.5 && <div className={line}><span className="text-emerald-600">{t('retirement.projection.tooltipPlannedSales')}</span><span className="tabular-nums">{money(row.saleIncome)}</span></div>}
        <div className={line}><span className="text-emerald-600">{t('retirement.projection.tooltipOtherIncome')}</span><span className="tabular-nums">{money(otherIncome)}</span></div>
        <div className={line}><span className="text-rose-500">{t('retirement.projection.tooltipOutgoing')}</span><span className="tabular-nums">{money(row.outgoing)}</span></div>
        {sold.length > 0 && (
          <>
            <div className={cn(line, 'font-medium')}><span>{t('retirement.projection.tooltipSold')}</span><span className="tabular-nums">{money(sold.reduce((sum, [, v]) => sum + v, 0))}</span></div>
            {sold.slice(0, 4).map(([id, value]) => (
              <div key={id} className={cn(line, 'text-muted-foreground pl-2')}><span className="truncate">{name(id)}</span><span className="tabular-nums">{money(value)}</span></div>
            ))}
          </>
        )}
        {row.unfunded > 0.5 && <div className={cn(line, 'text-rose-500 font-medium')}><span>{t('retirement.projection.tooltipUnfunded')}</span><span className="tabular-nums">{money(row.unfunded)}</span></div>}
      </div>
    </div>
  )
}

/** Every year as a row and every asset as a column, so any value can be read off. */
export function AssetsTable({
  scenario,
  names,
  drawableIds,
  thisYear,
  money,
}: {
  scenario: Projection
  names: Record<string, string>
  drawableIds: ReadonlySet<string>
  thisYear: number
  money: (v: number) => string
}) {
  const { t } = useTranslation()
  const peak: Record<string, number> = {}
  for (const row of scenario.rows) for (const [id, v] of Object.entries(row.byAsset)) peak[id] = Math.max(peak[id] ?? 0, v)
  const bySize = (a: string, b: string) => (peak[b] ?? 0) - (peak[a] ?? 0)
  const ids = Object.keys(peak)
  const sellFrom = ids.filter((id) => drawableIds.has(id)).sort(bySize)
  const others = ids.filter((id) => !drawableIds.has(id)).sort(bySize)
  const name = (id: string) => (id === CASH_ID ? t('retirement.projection.cash') : names[id] ?? id)

  const head = 'px-2.5 py-2 text-right font-medium text-muted-foreground whitespace-nowrap bg-card'
  const cell = 'px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap'
  const sticky = 'sticky left-0 bg-card text-left z-10'
  const sold = (row: YearRow) => Object.values(row.drawn).reduce((sum, v) => sum + v, 0)
  return (
    <div className="max-h-[28rem] overflow-auto rounded-lg border border-border">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 z-20">
          <tr className="border-b border-border">
            <th className={cn(head, sticky, 'text-left')} rowSpan={2}>{t('retirement.projection.tableYear')}</th>
            {sellFrom.length > 0 && <th className={cn(head, 'text-center border-l border-border')} colSpan={sellFrom.length + 1}>{t('retirement.projection.tableSellFrom')}</th>}
            {others.length > 0 && <th className={cn(head, 'text-center border-l border-border')} colSpan={others.length}>{t('retirement.projection.tableOthers')}</th>}
            <th className={cn(head, 'text-center border-l border-border')} colSpan={4}>{t('retirement.projection.tableFlows')}</th>
          </tr>
          <tr className="border-b border-border">
            {sellFrom.map((id, i) => <th key={id} className={cn(head, i === 0 && 'border-l border-border')}>{name(id)}</th>)}
            {sellFrom.length > 0 && <th className={cn(head, 'text-foreground')}>{t('retirement.projection.tableTotal')}</th>}
            {others.map((id, i) => <th key={id} className={cn(head, i === 0 && 'border-l border-border')}>{name(id)}</th>)}
            <th className={cn(head, 'border-l border-border')}>{t('retirement.projection.income')}</th>
            <th className={head}>{t('retirement.projection.outgoing')}</th>
            <th className={head}>{t('retirement.projection.tableSold')}</th>
            <th className={head}>{t('retirement.projection.tableNetWorth')}</th>
          </tr>
        </thead>
        <tbody>
          {scenario.rows.map((row) => (
            <tr key={row.year} className={cn('border-b border-border last:border-0', row.phase !== 'drawdown' && 'text-muted-foreground')}>
              <th scope="row" className={cn(cell, sticky, 'font-medium')}>
                {thisYear + row.year}
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{t(`retirement.projection.phase_${row.phase}`)}</span>
              </th>
              {sellFrom.map((id, i) => <td key={id} className={cn(cell, i === 0 && 'border-l border-border')}>{row.byAsset[id] ? money(row.byAsset[id]) : '–'}</td>)}
              {sellFrom.length > 0 && <td className={cn(cell, 'font-medium text-foreground')}>{money(row.drawable)}</td>}
              {others.map((id, i) => <td key={id} className={cn(cell, i === 0 && 'border-l border-border')}>{row.byAsset[id] ? money(row.byAsset[id]) : '–'}</td>)}
              <td className={cn(cell, 'border-l border-border text-emerald-600')}>{money(row.income)}</td>
              <td className={cn(cell, 'text-rose-500')}>{money(row.outgoing)}</td>
              <td className={cell}>{sold(row) > 0.5 ? money(sold(row)) : '–'}</td>
              <td className={cell}>{money(row.netWorth)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
