import { useRef, useState } from 'react'
import { useDocumentUpload } from '@/hooks/use-document-upload'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Download, FilePlus2, Loader2, Pencil, Trash2 } from 'lucide-react'
import { assetContracts, assetDocuments } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { DOCUMENT_KINDS } from '@/lib/asset-contracts'
import { useDateLocale } from '@/hooks/use-display-locale'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { AssetContract, AssetDocument, DocumentKind } from '@/types'

const SOON_DAYS = 60

function daysUntil(iso: string): number {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((new Date(iso + 'T00:00:00').getTime() - start.getTime()) / 86_400_000)
}

/** Files about an asset, kept in the attachment storage: contracts, the deed, certificates, invoices. */
export function AssetDocuments({ assetId, canWrite }: { assetId: string; canWrite: boolean }) {
  const { t } = useTranslation()
  const dateLocale = useDateLocale()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<DocumentKind>('contract')
  const [editing, setEditing] = useState<AssetDocument | null>(null)
  const { upload, uploading } = useDocumentUpload(assetId)
  const [dragging, setDragging] = useState(false)

  const { data: documents = [] } = useQuery({ queryKey: ['asset-documents', assetId], queryFn: () => assetDocuments.list(assetId) })
  const { data: contracts = [] } = useQuery({ queryKey: ['asset-contracts', assetId], queryFn: () => assetContracts.list(assetId) })
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['asset-documents', assetId] })
    queryClient.invalidateQueries({ queryKey: ['asset-contracts', assetId] })
  }
  const remove = useMutation({
    mutationFn: (id: string) => assetDocuments.remove(id),
    onSuccess: refresh,
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })

  const contractName = (id: string | null) => contracts.find((c) => c.id === id)?.provider
  const day = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(dateLocale)
  const size = (bytes: number) => (bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`)

  return (
    <div
      className={cn('bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5 transition-colors', dragging && 'ring-2 ring-primary')}
      onDragOver={canWrite ? (e) => { e.preventDefault(); setDragging(true) } : undefined}
      onDragLeave={() => setDragging(false)}
      onDrop={canWrite ? (e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files, { kind }) } : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('assets.page.documents')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('assets.page.documentsHint')}</p>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <select className="border border-border rounded-md px-2 h-8 text-xs bg-card" value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)} aria-label={t('assets.page.documentKind')}>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>{t(`assets.page.docKind_${k}`)}</option>
              ))}
            </select>
            <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files, { kind })} />
            <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => input.current?.click()}>
              {uploading > 0 ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />}
              {t('assets.page.addDocument')}
            </Button>
          </div>
        )}
      </div>

      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">{canWrite ? t('assets.page.noDocumentsDrop') : t('assets.page.noDocuments')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {documents.map((d) => {
            const left = d.expires_on ? daysUntil(d.expires_on) : null
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium text-foreground truncate">{d.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`assets.page.docKind_${d.kind}`)}
                    {d.contract_id && contractName(d.contract_id) && ` · ${contractName(d.contract_id)}`}
                    {d.document_date && ` · ${day(d.document_date)}`}
                    {` · ${size(d.size)}`}
                  </p>
                </div>
                {left !== null && (
                  <span className={cn('text-[11px] font-medium px-2 py-0.5 rounded-full border', left < 0 ? 'bg-rose-50 text-rose-700 border-rose-100' : left <= SOON_DAYS ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-muted text-muted-foreground border-border')}>
                    {left < 0 ? t('assets.page.docExpired', { date: day(d.expires_on!) }) : t('assets.page.docExpires', { date: day(d.expires_on!) })}
                  </span>
                )}
                <div className="flex items-center gap-1">
                  <button type="button" className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5" onClick={() => assetDocuments.download(d).catch((e) => toast.error(extractApiError(e, t('common.error'))))} aria-label={t('assets.page.download', { name: d.title })}>
                    <Download size={13} />
                  </button>
                  {canWrite && (
                    <>
                      <button type="button" className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5" onClick={() => setEditing(d)} aria-label={t('assets.page.editDocument', { name: d.title })}>
                        <Pencil size={13} />
                      </button>
                      <button type="button" className="p-1.5 rounded-md text-muted-foreground hover:text-rose-500 hover:bg-rose-50" disabled={remove.isPending} onClick={() => remove.mutate(d.id)} aria-label={t('assets.page.deleteDocument', { name: d.title })}>
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {editing && <DocumentDialog key={editing.id} document={editing} contracts={contracts} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
    </div>
  )
}

function DocumentDialog({ document, contracts, onClose, onSaved }: { document: AssetDocument; contracts: AssetContract[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(document.title)
  const [kind, setKind] = useState<DocumentKind>(document.kind)
  const [contractId, setContractId] = useState(document.contract_id ?? '')
  const [docDate, setDocDate] = useState(document.document_date ?? '')
  const [expires, setExpires] = useState(document.expires_on ?? '')
  const save = useMutation({
    mutationFn: () => assetDocuments.update(document.id, { title: title.trim(), kind, contract_id: contractId || null, document_date: docDate || null, expires_on: expires || null }),
    onSuccess: onSaved,
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('assets.page.editDocumentTitle')}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="doc-title" className="text-xs">{t('assets.page.documentTitle')}</Label>
            <Input id="doc-title" className="h-8" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-kind" className="text-xs">{t('assets.page.documentKind')}</Label>
            <select id="doc-kind" className="w-full border border-border rounded-md px-2 h-8 text-sm bg-card" value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>{t(`assets.page.docKind_${k}`)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-contract" className="text-xs">{t('assets.page.attachedContract')}</Label>
            <select id="doc-contract" className="w-full border border-border rounded-md px-2 h-8 text-sm bg-card" value={contractId} onChange={(e) => setContractId(e.target.value)}>
              <option value="">–</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>{c.provider}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-date" className="text-xs">{t('assets.page.documentDate')}</Label>
            <Input id="doc-date" type="date" className="h-8" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-expires" className="text-xs">{t('assets.page.expiresOn')}</Label>
            <Input id="doc-expires" type="date" className="h-8" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
