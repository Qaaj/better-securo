/** Save text as a file: a short-lived object URL clicked from an anchor. */
export function downloadText(filename: string, text: string, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Print an HTML document (the browser's "Save as PDF" turns it into a PDF),
 *  through a hidden frame so the app's own page is not printed. */
export function printHtml(html: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (!doc || !win) {
    frame.remove()
    return
  }
  doc.open()
  doc.write(html)
  doc.close()
  const cleanup = () => window.setTimeout(() => frame.remove(), 1000)
  win.addEventListener('afterprint', cleanup)
  // Let the frame lay out before the print dialog opens.
  window.setTimeout(() => {
    win.focus()
    win.print()
  }, 150)
}
