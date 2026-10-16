import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, Loader2 } from 'lucide-react'
import { vlcvx as api } from '@/lib/api'
import { downloadText } from '@/lib/download'
import { compact, usd } from '@/lib/vlcvx'
import { Panel } from '@/components/vlcvx-charts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { VlcvxBreakdown, VlcvxRound } from '@/types'

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–')

/** Every stored round of the protocol, newest first, with a detail view per round. */
export function RoundsTable({ protocol, rounds }: { protocol: string; rounds: VlcvxRound[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<number | null>(null)
  const ordered = useMemo(() => [...rounds].reverse(), [rounds])
  const exportCsv = () => {
    const lines = ['round,ends,total_dollars,dollars_per_vlcvx,votes_vlcvx,bribes']
    for (const r of rounds) lines.push([r.round, r.ends_at ?? '', r.total_amount_dollars ?? '', r.dollar_per_vl ?? '', r.scores_total ?? '', r.bribe_count].join(','))
    downloadText(`vlcvx-${protocol}-rounds.csv`, lines.join('\n') + '\n', 'text/csv;charset=utf-8')
  }
  return (
    <Panel
      title={t('vlcvx.roundsTitle')}
      hint={t('vlcvx.roundsHint')}
      action={
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={exportCsv}>
          <Download size={13} /> {t('vlcvx.exportCsv')}
        </Button>
      }
    >
      <div className="overflow-x-auto max-h-[28rem] overflow-y-auto rounded-lg border border-border">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-card">
            <tr className="text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">{t('vlcvx.round')}</th>
              <th className="text-left font-medium px-3 py-2">{t('vlcvx.ended')}</th>
              <th className="text-right font-medium px-3 py-2">{t('vlcvx.totalBribes')}</th>
              <th className="text-right font-medium px-3 py-2">{t('vlcvx.perVl')}</th>
              <th className="text-right font-medium px-3 py-2">{t('vlcvx.votes')}</th>
              <th className="text-right font-medium px-3 py-2">{t('vlcvx.bribes')}</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((r) => (
              <tr key={r.round} className="border-t border-border hover:bg-muted/40 cursor-pointer" onClick={() => setOpen(r.round)}>
                <td className="px-3 py-1.5">
                  <button type="button" className="text-primary hover:underline" aria-label={t('vlcvx.openRound', { round: r.round })}>#{r.round}</button>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{date(r.ends_at)}</td>
                <td className="text-right px-3 py-1.5">{usd(r.total_amount_dollars)}</td>
                <td className="text-right px-3 py-1.5">{usd(r.dollar_per_vl, 4)}</td>
                <td className="text-right px-3 py-1.5 text-muted-foreground">{r.scores_total != null ? compact(r.scores_total) : '–'}</td>
                <td className="text-right px-3 py-1.5 text-muted-foreground">{r.has_detail ? r.bribe_count : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open !== null && <RoundDialog protocol={protocol} round={open} onClose={() => setOpen(null)} />}
    </Panel>
  )
}

function RoundDialog({ protocol, round, onClose }: { protocol: string; round: number; onClose: () => void }) {
  const { t } = useTranslation()
  const { data, isLoading, isError } = useQuery({ queryKey: ['vlcvx', 'round', protocol, round], queryFn: () => api.round(protocol, round) })
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('vlcvx.roundTitle', { round })}</DialogTitle>
        </DialogHeader>
        {isLoading && <Loader2 className="animate-spin mx-auto my-6" />}
        {isError && <p className="text-sm text-rose-500">{t('common.error')}</p>}
        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {[
                [t('vlcvx.ended'), date(data.ends_at)],
                [t('vlcvx.totalBribes'), usd(data.total_amount_dollars)],
                [t('vlcvx.perVl'), usd(data.dollar_per_vl, 4)],
                [t('vlcvx.votes'), data.scores_total != null ? `${compact(data.scores_total)} vlCVX` : '–'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border px-3 py-2">
                  <p className="text-muted-foreground">{label}</p>
                  <p className="text-sm font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <p className="text-xs font-medium text-muted-foreground mb-1">{t('vlcvx.pools')}</p>
                <div className="overflow-y-auto max-h-72 rounded-lg border border-border">
                  <table className="w-full text-xs tabular-nums">
                    <thead className="sticky top-0 bg-card text-muted-foreground">
                      <tr>
                        <th className="text-left font-medium px-3 py-1.5">{t('vlcvx.pool')}</th>
                        <th className="text-right font-medium px-3 py-1.5">{t('vlcvx.bribed')}</th>
                        <th className="text-right font-medium px-3 py-1.5">{t('vlcvx.votes')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.pools.map((p) => (
                        <tr key={p.pool} className="border-t border-border">
                          <td className="px-3 py-1">
                            <span className="block truncate max-w-xs">{p.pool}</span>
                            <span className="text-[10px] text-muted-foreground">{p.tokens.join(', ')}</span>
                          </td>
                          <td className="text-right px-3 py-1">{usd(p.dollars)}</td>
                          <td className="text-right px-3 py-1 text-muted-foreground">{p.votes != null ? compact(p.votes) : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">{t('vlcvx.paidIn')}</p>
                <ul className="rounded-lg border border-border divide-y divide-border text-xs tabular-nums">
                  {data.tokens.map((x) => (
                    <li key={x.token} className="flex justify-between px-3 py-1.5">
                      <span>{x.token}</span>
                      <span>{usd(x.dollars)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Tokens paid and the pools bribed most, over all rounds. */
export function BribeTables({ breakdown }: { breakdown: VlcvxBreakdown }) {
  const { t } = useTranslation()
  const total = breakdown.tokens.reduce((s, x) => s + x.total_dollars, 0)
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Panel title={t('vlcvx.tokensTitle')} hint={t('vlcvx.tokensHint', { count: breakdown.rounds_with_detail })}>
        <ul className="rounded-lg border border-border divide-y divide-border text-xs tabular-nums max-h-96 overflow-y-auto">
          {breakdown.tokens.slice(0, 25).map((x) => (
            <li key={x.token} className="flex justify-between px-3 py-1.5">
              <span>{x.token}</span>
              <span>
                {usd(x.total_dollars)} <span className="text-muted-foreground">({total > 0 ? ((x.total_dollars / total) * 100).toFixed(1) : '0'}%)</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      <div className="lg:col-span-2">
        <Panel title={t('vlcvx.topPools')} hint={t('vlcvx.topPoolsHint')}>
          <div className="overflow-x-auto max-h-96 overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-1.5">{t('vlcvx.pool')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('vlcvx.totalBribes')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('vlcvx.roundsBribed')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('vlcvx.bestRound')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('vlcvx.lastBribed')}</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.top_pools.map((p) => (
                  <tr key={p.pool} className="border-t border-border">
                    <td className="px-3 py-1"><span className="block truncate max-w-xs">{p.pool}</span></td>
                    <td className="text-right px-3 py-1">{usd(p.total_dollars)}</td>
                    <td className="text-right px-3 py-1 text-muted-foreground">{p.rounds}</td>
                    <td className="text-right px-3 py-1 text-muted-foreground">{usd(p.best_round_dollars)}</td>
                    <td className="text-right px-3 py-1 text-muted-foreground">#{p.last_round}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  )
}
