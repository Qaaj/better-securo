import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, RefreshCw } from 'lucide-react'
import { vlcvx as api } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { compactUsd, compact, usd } from '@/lib/vlcvx'
import { useWorkspace } from '@/contexts/workspace-context'
import { PageHeader } from '@/components/page-header'
import { PayoutCharts, TokenChart } from '@/components/vlcvx-charts'
import { BribeTables, RoundsTable } from '@/components/vlcvx-rounds'
import { VlcvxSimulator } from '@/components/vlcvx-simulator'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { VlcvxRound } from '@/types'

const PROTOCOLS = ['cvx-crv', 'cvx-fxn', 'cvx-prisma'] as const

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–')

export default function VlcvxPage() {
  const { t } = useTranslation()
  const { canWrite } = useWorkspace()
  const queryClient = useQueryClient()
  const [protocol, setProtocol] = useState<(typeof PROTOCOLS)[number]>('cvx-crv')

  const { data: summary, isLoading } = useQuery({
    queryKey: ['vlcvx', 'summary'],
    queryFn: api.summary,
    refetchInterval: (query) => (query.state.data?.sync.state === 'running' ? 2000 : false),
  })
  const syncing = summary?.sync.state === 'running'
  // When a sync finishes, what it brought is read again.
  const [wasSyncing, setWasSyncing] = useState(false)
  useEffect(() => {
    if (wasSyncing && !syncing) queryClient.invalidateQueries({ queryKey: ['vlcvx'] })
    setWasSyncing(!!syncing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing])

  const hasData = !!summary?.has_data
  const roundQueries = useQueries({ queries: PROTOCOLS.map((p) => ({ queryKey: ['vlcvx', 'rounds', p], queryFn: () => api.rounds(p), enabled: hasData })) })
  const byProtocol = useMemo(() => Object.fromEntries(PROTOCOLS.map((p, i) => [p, roundQueries[i].data ?? []])) as Record<string, VlcvxRound[]>, [roundQueries])
  const { data: breakdown } = useQuery({ queryKey: ['vlcvx', 'breakdown', protocol], queryFn: () => api.breakdown(protocol), enabled: hasData })

  const refresh = useMutation({
    mutationFn: api.refresh,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vlcvx', 'summary'] }),
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })

  const current = summary?.protocols.find((p) => p.protocol === protocol)
  const rounds = byProtocol[protocol] ?? []
  const syncedAt = summary?.protocols.map((p) => p.synced_at).filter(Boolean).sort().at(-1) ?? null

  if (isLoading) return <p className="text-sm text-muted-foreground py-10 text-center">{t('common.loading')}</p>

  const refreshButton = canWrite && summary?.enabled && (
    <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" disabled={syncing || refresh.isPending} onClick={() => refresh.mutate()}>
      {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      {syncing ? t('vlcvx.syncing', { done: summary?.sync.done ?? 0, total: summary?.sync.total ?? 0 }) : t('vlcvx.refresh')}
    </Button>
  )

  return (
    <div>
      <PageHeader section={t('nav.groupAnalysis')} title="vlCVX" />
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <p className="text-xs text-muted-foreground">
          {t('vlcvx.source')} <span className="font-medium">Llama Airforce</span>
          {syncedAt && ` · ${t('vlcvx.syncedAt', { date: day(syncedAt) })}`}
          {summary?.sync.state === 'failed' && <span className="text-rose-500"> · {summary.sync.error ?? t('vlcvx.syncFailed')}</span>}
        </p>
        {refreshButton}
      </div>

      {!summary?.enabled ? (
        <p className="text-sm text-muted-foreground text-center py-10">{t('vlcvx.disabled')}</p>
      ) : !hasData ? (
        <div className="bg-card rounded-xl border border-border shadow-sm p-8 text-center space-y-3">
          <p className="text-sm font-medium">{t('vlcvx.emptyTitle')}</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">{t('vlcvx.emptyHint')}</p>
          {syncing && <p className="text-xs text-muted-foreground">{t('vlcvx.syncing', { done: summary.sync.done, total: summary.sync.total })}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
            {summary.protocols.filter((p) => p.rounds > 0).map((p) => (
              <button
                key={p.protocol}
                type="button"
                onClick={() => setProtocol(p.protocol as (typeof PROTOCOLS)[number])}
                className={cn('px-3 py-1.5', protocol === p.protocol ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}
              >
                {p.label} <span className="text-[11px] opacity-70">({p.rounds})</span>
              </button>
            ))}
          </div>

          {current && current.rounds > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Kpi label={t('vlcvx.kpiLatest', { round: current.latest_round })} value={usd(current.latest_total_dollars)} hint={t('vlcvx.kpiEnded', { date: day(current.latest_ends_at) })} />
              <Kpi label={t('vlcvx.perVl')} value={usd(current.latest_dollar_per_vl, 4)} hint={t('vlcvx.kpiAverage', { value: usd(current.average_dollar_per_vl_12, 4) })} />
              <Kpi label={t('vlcvx.kpiAllTime')} value={compactUsd(current.total_dollars_all_time)} hint={t('vlcvx.kpiRounds', { count: current.rounds, best: usd(current.best_dollar_per_vl, 4) })} />
              <Kpi
                label={t('vlcvx.votes')}
                value={current.latest_votes != null ? `${compact(current.latest_votes)} vlCVX` : '–'}
                hint={current.reward_per_dollar_bribe ? t('vlcvx.kpiReward', { value: usd(current.reward_per_dollar_bribe, 2) }) : t('vlcvx.kpiVotesHint')}
              />
            </div>
          )}

          <Tabs defaultValue="payouts">
            <TabsList>
              <TabsTrigger value="payouts">{t('vlcvx.tabPayouts')}</TabsTrigger>
              <TabsTrigger value="rounds">{t('vlcvx.tabRounds')}</TabsTrigger>
              <TabsTrigger value="bribes">{t('vlcvx.tabBribes')}</TabsTrigger>
              <TabsTrigger value="simulator">{t('vlcvx.tabSimulator')}</TabsTrigger>
            </TabsList>
            <TabsContent value="payouts" className="mt-4">
              <PayoutCharts rounds={rounds} />
            </TabsContent>
            <TabsContent value="rounds" className="mt-4">
              <RoundsTable protocol={protocol} rounds={rounds} />
            </TabsContent>
            <TabsContent value="bribes" className="mt-4 space-y-4">
              {breakdown ? (
                <>
                  <TokenChart breakdown={breakdown} />
                  <BribeTables breakdown={breakdown} />
                </>
              ) : (
                <Loader2 className="animate-spin mx-auto my-8" />
              )}
            </TabsContent>
            <TabsContent value="simulator" className="mt-4">
              <VlcvxSimulator protocols={summary.protocols} byProtocol={byProtocol} />
            </TabsContent>
          </Tabs>
          <p className="text-[11px] text-muted-foreground">{t('vlcvx.disclaimer')}</p>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold text-foreground mt-1 tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{hint}</p>
    </div>
  )
}
