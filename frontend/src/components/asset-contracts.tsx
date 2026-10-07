import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Banknote, Building2, Droplets, FileText, Flame, Landmark, Pencil, Plus, ShieldCheck, Trash2, Wifi, Wrench, Zap } from 'lucide-react'
import { assetContracts, recurring as recurringApi, type ContractInput } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { CONTRACT_KINDS, contractStatus, runningCosts } from '@/lib/asset-contracts'
import { formatCurrency } from '@/lib/format'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useDocumentUpload } from '@/hooks/use-document-upload'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { AssetContract, ContractKind } from '@/types'

const ICONS: Record<ContractKind, typeof Zap> = {
  energy: Zap,
  gas: Flame,
  water: Droplets,
  internet: Wifi,
  insurance: ShieldCheck,
  tax: Landmark,
  condo: Building2,
  mortgage: Banknote,
  maintenance: Wrench,
  other: FileText,
}

const TONE: Record<string, string> = {
  expired: 'bg-rose-50 text-rose-700 border-rose-100',
  notice: 'bg-amber-50 text-amber-700 border-amber-100',
  ending: 'bg-amber-50 text-amber-700 border-amber-100',
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  open: 'bg-muted text-muted-foreground border-border',
}

/** Contracts and utilities tied to an asset, with what they cost through the recurring items linked to them. */
export function AssetContracts({
  assetId,
  canWrite,
  currency,
}: {
  assetId: string
  canWrite: boolean
  currency: string
}) {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<AssetContract | 'new' | null>(null)
  const attach = useRef<AssetContract | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const { upload } = useDocumentUpload(assetId)

  const { data: contracts = [] } = useQuery({ queryKey: ['asset-contracts', assetId], queryFn: () => assetContracts.list(assetId) })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['asset-contracts', assetId] })
  const remove = useMutation({
    mutationFn: (id: string) => assetContracts.remove(id),
    onSuccess: () => {
      refresh()
      queryClient.invalidateQueries({ queryKey: ['asset-documents', assetId] })
    },
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })

  const money = (v: number) => mask(formatCurrency(v, currency, locale))
  const day = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(dateLocale)
  const costs = runningCosts(contracts, currency)

  const statusText = (c: AssetContract) => {
    const s = contractStatus(c)
    switch (s.kind) {
      case 'open':
        return t('assets.page.statusOpen')
      case 'expired':
        return t('assets.page.statusExpired', { days: s.daysAgo })
      case 'notice':
        return t('assets.page.statusNotice', { date: day(s.noticeBy) })
      case 'ending':
        return t('assets.page.statusEnding', { days: s.daysLeft })
      default:
        return t('assets.page.statusOk', { date: c.end_date ? day(c.end_date) : '' })
    }
  }

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('assets.page.contracts')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('assets.page.contractsHint')}</p>
        </div>
        {canWrite && (
          <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => setEditing('new')}>
            <Plus size={13} /> {t('assets.page.addContract')}
          </Button>
        )}
      </div>

      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const contract = attach.current
          if (e.target.files && contract) void upload(e.target.files, { kind: 'contract', contractId: contract.id })
          e.target.value = ''
        }}
      />

      {costs.costed > 0 && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t('assets.page.runningMonth')}</p>
            <p className="text-sm font-semibold tabular-nums">{money(costs.perMonth)}</p>
          </div>
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t('assets.page.runningYear')}</p>
            <p className="text-sm font-semibold tabular-nums">{money(costs.perYear)}</p>
            {costs.uncosted > 0 && <p className="text-[11px] text-muted-foreground">{t('assets.page.uncosted', { count: costs.uncosted })}</p>}
          </div>
        </div>
      )}

      {contracts.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">{t('assets.page.noContracts')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {contracts.map((c) => {
            const Icon = ICONS[c.kind] ?? FileText
            const status = contractStatus(c)
            return (
              <li key={c.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-3">
                <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary shrink-0">
                  <Icon size={15} />
                </div>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium text-foreground">
                    {c.provider}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{t(`assets.page.kind_${c.kind}`)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      c.contract_number && t('assets.page.contractNo', { value: c.contract_number }),
                      c.customer_number && t('assets.page.customerNo', { value: c.customer_number }),
                      c.meter_number && t('assets.page.meterNo', { value: c.meter_number }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.start_date && day(c.start_date)}
                    {c.start_date && c.end_date && ' → '}
                    {c.end_date && day(c.end_date)}
                  </p>
                  <p className="text-xs mt-0.5">
                    {c.recurring ? (
                      <span className="text-foreground">
                        {c.recurring.description} · {mask(formatCurrency(Number(c.recurring.amount), c.recurring.currency, locale))} {t(`recurring.${c.recurring.frequency}`).toLowerCase()}
                        {!c.recurring.is_active && <span className="text-muted-foreground"> ({t('recurring.inactive').toLowerCase()})</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('assets.page.noCostLinked')}</span>
                    )}
                    {c.document_count > 0 && <span className="text-muted-foreground"> · {t('assets.page.documentsCount', { count: c.document_count })}</span>}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className={cn('text-[11px] font-medium px-2 py-0.5 rounded-full border', TONE[status.kind])}>{statusText(c)}</span>
                  {canWrite && (
                    <div className="flex items-center gap-1">
                      <button type="button" className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5" onClick={() => { attach.current = c; picker.current?.click() }} aria-label={t('assets.page.attachDocument', { name: c.provider })} title={t('assets.page.attachDocument', { name: c.provider })}>
                        <FileText size={13} />
                      </button>
                      <button type="button" className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5" onClick={() => setEditing(c)} aria-label={t('assets.page.editContract', { name: c.provider })}>
                        <Pencil size={13} />
                      </button>
                      <button type="button" className="p-1.5 rounded-md text-muted-foreground hover:text-rose-500 hover:bg-rose-50" disabled={remove.isPending} onClick={() => remove.mutate(c.id)} aria-label={t('assets.page.deleteContract', { name: c.provider })}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {editing && (
        <ContractDialog
          assetId={assetId}
          contract={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function ContractDialog({ assetId, contract, onClose, onSaved }: { assetId: string; contract: AssetContract | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<ContractKind>(contract?.kind ?? 'energy')
  const [provider, setProvider] = useState(contract?.provider ?? '')
  const [contractNo, setContractNo] = useState(contract?.contract_number ?? '')
  const [customerNo, setCustomerNo] = useState(contract?.customer_number ?? '')
  const [meterNo, setMeterNo] = useState(contract?.meter_number ?? '')
  const [start, setStart] = useState(contract?.start_date ?? '')
  const [end, setEnd] = useState(contract?.end_date ?? '')
  const [notice, setNotice] = useState(contract?.notice_days?.toString() ?? '')
  const [recurringId, setRecurringId] = useState(contract?.recurring_id ?? '')
  const [notes, setNotes] = useState(contract?.notes ?? '')

  const { data: items = [] } = useQuery({ queryKey: ['recurring'], queryFn: recurringApi.list })
  const choices = items.filter((r) => r.type === 'debit' && (r.is_active || r.id === contract?.recurring_id))

  const save = useMutation({
    mutationFn: () => {
      const body: ContractInput = {
        kind,
        provider: provider.trim(),
        contract_number: contractNo.trim() || null,
        customer_number: customerNo.trim() || null,
        meter_number: meterNo.trim() || null,
        start_date: start || null,
        end_date: end || null,
        notice_days: notice.trim() === '' ? null : Number(notice),
        recurring_id: recurringId || null,
        notes: notes.trim() || null,
      }
      return contract ? assetContracts.update(contract.id, body) : assetContracts.create(assetId, body)
    },
    onSuccess: onSaved,
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })

  const field = (id: string, label: string, value: string, set: (v: string) => void, type = 'text') => (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} type={type} className="h-8" value={value} onChange={(e) => set(e.target.value)} />
    </div>
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{contract ? t('assets.page.editContractTitle') : t('assets.page.addContract')}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="contract-kind" className="text-xs">{t('assets.page.contractKind')}</Label>
            <select id="contract-kind" className="w-full border border-border rounded-md px-2 h-8 text-sm bg-card" value={kind} onChange={(e) => setKind(e.target.value as ContractKind)}>
              {CONTRACT_KINDS.map((k) => (
                <option key={k} value={k}>{t(`assets.page.kind_${k}`)}</option>
              ))}
            </select>
          </div>
          {field('contract-provider', t('assets.page.provider'), provider, setProvider)}
          {field('contract-number', t('assets.page.contractNumber'), contractNo, setContractNo)}
          {field('contract-customer', t('assets.page.customerNumber'), customerNo, setCustomerNo)}
          {field('contract-meter', t('assets.page.meterNumber'), meterNo, setMeterNo)}
          {field('contract-notice', t('assets.page.noticeDays'), notice, setNotice, 'number')}
          {field('contract-start', t('assets.page.startDate'), start, setStart, 'date')}
          {field('contract-end', t('assets.page.endDate'), end, setEnd, 'date')}
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="contract-recurring" className="text-xs">{t('assets.page.linkedCost')}</Label>
            <select id="contract-recurring" className="w-full border border-border rounded-md px-2 h-8 text-sm bg-card" value={recurringId} onChange={(e) => setRecurringId(e.target.value)}>
              <option value="">{t('assets.page.noCostLinked')}</option>
              {choices.map((r) => (
                <option key={r.id} value={r.id}>{r.description}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">{t('assets.page.linkedCostHint')}</p>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="contract-notes" className="text-xs">{t('assets.page.notes')}</Label>
            <textarea id="contract-notes" className="w-full min-h-16 rounded-md border border-border bg-card px-3 py-2 text-sm" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" disabled={!provider.trim() || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
