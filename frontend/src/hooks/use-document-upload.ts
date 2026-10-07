import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { assetDocuments } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import type { DocumentKind } from '@/types'

/** Uploading files as documents of an asset, one after the other, refreshing the lists as they land. */
export function useDocumentUpload(assetId: string) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [uploading, setUploading] = useState(0)
  const upload = async (files: FileList | File[], options: { kind: DocumentKind; contractId?: string | null }) => {
    const list = Array.from(files)
    if (list.length === 0) return
    setUploading(list.length)
    for (const file of list) {
      try {
        await assetDocuments.upload(assetId, file, { kind: options.kind, contract_id: options.contractId ?? null })
      } catch (e) {
        toast.error(`${file.name}: ${extractApiError(e, t('common.error'))}`)
      }
      setUploading((n) => n - 1)
    }
    queryClient.invalidateQueries({ queryKey: ['asset-documents', assetId] })
    queryClient.invalidateQueries({ queryKey: ['asset-contracts', assetId] })
  }
  return { upload, uploading }
}
