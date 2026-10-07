import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, ImagePlus, Loader2, Star, Trash2 } from 'lucide-react'
import { assetPhotos } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { downscaleImage } from '@/lib/image'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { AssetPhoto } from '@/types'

/** A stored photo, fetched with the sign-in and shown from a local URL. */
export function PhotoImage({ photoId, alt, className }: { photoId: string; alt: string; className?: string }) {
  const { data: url } = useQuery({
    queryKey: ['asset-photo-blob', photoId],
    queryFn: async () => URL.createObjectURL(await assetPhotos.blob(photoId)),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  })
  if (!url) return <div className={cn('animate-pulse bg-muted', className)} aria-hidden />
  return <img src={url} alt={alt} className={className} loading="lazy" />
}

/** The photos of an asset: a lead picture, thumbnails, a viewer, and upload. */
export function AssetPhotos({ assetId, assetName, canWrite }: { assetId: string; assetName: string; canWrite: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(0)

  const { data: photos = [] } = useQuery({ queryKey: ['asset-photos', assetId], queryFn: () => assetPhotos.list(assetId) })
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['asset-photos', assetId] })
    queryClient.invalidateQueries({ queryKey: ['asset', assetId] })
    queryClient.invalidateQueries({ queryKey: ['assets'] })
  }
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { caption?: string | null; is_cover?: boolean } }) => assetPhotos.update(id, body),
    onSuccess: refresh,
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })
  const remove = useMutation({
    mutationFn: (id: string) => assetPhotos.remove(id),
    onSuccess: () => {
      setOpen(null)
      refresh()
    },
    onError: (e) => toast.error(extractApiError(e, t('common.error'))),
  })

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name))
    if (list.length === 0) {
      toast.error(t('assets.page.photosOnlyImages'))
      return
    }
    setUploading(list.length)
    for (const file of list) {
      try {
        await assetPhotos.upload(assetId, await downscaleImage(file))
      } catch (e) {
        toast.error(`${file.name}: ${extractApiError(e, t('assets.page.photoUnreadable'))}`)
      }
      setUploading((n) => n - 1)
    }
    refresh()
  }

  const cover = photos.find((p) => p.is_cover) ?? photos[0]
  const current: AssetPhoto | undefined = open !== null ? photos[open] : undefined
  const step = (delta: number) => setOpen((i) => (i === null ? null : (i + delta + photos.length) % photos.length))

  const drop = canWrite
    ? {
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault()
          setDragging(true)
        },
        onDragLeave: () => setDragging(false),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault()
          setDragging(false)
          void upload(e.dataTransfer.files)
        },
      }
    : {}

  return (
    <div {...drop} className={cn('rounded-xl transition-colors', dragging && 'ring-2 ring-primary')}>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
      {photos.length === 0 ? (
        <button
          type="button"
          disabled={!canWrite}
          onClick={() => input.current?.click()}
          className="w-full h-56 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary hover:text-primary transition-colors disabled:opacity-60"
        >
          {uploading > 0 ? <Loader2 className="animate-spin" /> : <ImagePlus size={28} />}
          <span className="text-sm">{canWrite ? t('assets.page.photosAdd') : t('assets.page.photosNone')}</span>
          {canWrite && <span className="text-xs">{t('assets.page.photosDrop')}</span>}
        </button>
      ) : (
        <div className="space-y-2">
          <button type="button" onClick={() => setOpen(photos.indexOf(cover))} className="block w-full relative overflow-hidden rounded-xl h-64 sm:h-80 group" aria-label={t('assets.page.photoOpen', { name: assetName })}>
            <PhotoImage photoId={cover.id} alt={cover.caption ?? assetName} className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" />
            {cover.caption && <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent text-white text-sm px-4 py-3 text-left">{cover.caption}</span>}
          </button>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {photos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setOpen(i)}
                className={cn('relative shrink-0 h-16 w-24 overflow-hidden rounded-lg border', p.id === cover.id ? 'border-primary' : 'border-border')}
                aria-label={p.caption ?? p.filename}
              >
                <PhotoImage photoId={p.id} alt={p.caption ?? p.filename} className="h-full w-full object-cover" />
              </button>
            ))}
            {canWrite && (
              <button
                type="button"
                onClick={() => input.current?.click()}
                className="shrink-0 h-16 w-24 rounded-lg border-2 border-dashed border-border flex items-center justify-center text-muted-foreground hover:border-primary hover:text-primary"
                aria-label={t('assets.page.photosAdd')}
              >
                {uploading > 0 ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={18} />}
              </button>
            )}
          </div>
        </div>
      )}

      <Dialog open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{assetName}</DialogTitle>
          </DialogHeader>
          {current && (
            <div className="space-y-3">
              <div className="relative bg-black/5 rounded-lg overflow-hidden flex items-center justify-center max-h-[60vh]">
                <PhotoImage photoId={current.id} alt={current.caption ?? current.filename} className="max-h-[60vh] w-auto object-contain" />
                {photos.length > 1 && (
                  <>
                    <button type="button" onClick={() => step(-1)} aria-label={t('assets.page.photoPrev')} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70">
                      <ChevronLeft size={18} />
                    </button>
                    <button type="button" onClick={() => step(1)} aria-label={t('assets.page.photoNext')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70">
                      <ChevronRight size={18} />
                    </button>
                  </>
                )}
              </div>
              {canWrite ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    key={current.id}
                    defaultValue={current.caption ?? ''}
                    placeholder={t('assets.page.photoCaption')}
                    className="h-8 flex-1 min-w-48"
                    aria-label={t('assets.page.photoCaption')}
                    onBlur={(e) => {
                      const caption = e.target.value.trim()
                      if (caption !== (current.caption ?? '')) update.mutate({ id: current.id, body: { caption } })
                    }}
                  />
                  <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={current.is_cover || update.isPending} onClick={() => update.mutate({ id: current.id, body: { is_cover: true } })}>
                    <Star size={13} /> {current.is_cover ? t('assets.page.photoIsCover') : t('assets.page.photoSetCover')}
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="gap-1.5 text-rose-600" disabled={remove.isPending} onClick={() => remove.mutate(current.id)}>
                    <Trash2 size={13} /> {t('common.delete')}
                  </Button>
                </div>
              ) : (
                current.caption && <p className="text-sm text-muted-foreground">{current.caption}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
