/** The size an image shrinks to so that its longer side is at most `max`, never growing it. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= max) return { width, height }
  const scale = max / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * Shrink a photo in the browser before uploading it: phone photos are many megabytes and the page
 * shows them at screen size. GIFs are left alone (they may be animated). Throws when the browser
 * cannot read the image, such as a HEIC photo outside Safari.
 */
export async function downscaleImage(file: File, max = 1800, quality = 0.85): Promise<File> {
  if (file.type === 'image/gif') return file
  const bitmap = await createImageBitmap(file)
  const { width, height } = fitWithin(bitmap.width, bitmap.height, max)
  if (width === bitmap.width && file.size < 1_500_000) {
    bitmap.close()
    return file
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    return file
  }
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) return file
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
}
