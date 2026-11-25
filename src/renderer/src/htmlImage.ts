/**
 * HTML drawn as a PNG data URL, for something too tall to capture from the
 * screen (the status update email). It's laid out in a frame of its own,
 * away from the app's styles, the way an email client shows it; then drawn
 * through an SVG image onto a canvas at twice the size, so text stays sharp
 * once a document shrinks it to the page.
 */
export async function htmlToPng(
  html: string,
  opts: { width?: number; padding?: number; background?: string; scale?: number } = {}
): Promise<string> {
  const { width = 720, padding = 20, background = '#FFFFFF', scale = 2 } = opts
  const frame = document.createElement('iframe')
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:100px;border:0;visibility:hidden`
  document.body.appendChild(frame)
  try {
    const doc = frame.contentDocument
    if (!doc) throw new Error('no frame to lay it out in')
    doc.open()
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">` +
        `<div id="sheet" style="width:${width}px;padding:${padding}px;box-sizing:border-box;background:${background}">${html}</div>` +
        `</body></html>`
    )
    doc.close()
    const sheet = doc.getElementById('sheet')!
    await Promise.all([...sheet.querySelectorAll('img')].map((img) => img.decode().catch(() => {})))
    const height = Math.ceil(sheet.getBoundingClientRect().height)

    // XHTML, as an SVG's foreignObject needs it: closed tags, no named entities
    const xhtml = new XMLSerializer().serializeToString(sheet)
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`
    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    await img.decode()

    // a very long email draws smaller rather than past the canvas limit
    const s = Math.min(scale, 16000 / height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * s)
    canvas.height = Math.round(height * s)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas to draw on')
    ctx.scale(s, s)
    ctx.drawImage(img, 0, 0)
    return canvas.toDataURL('image/png')
  } finally {
    frame.remove()
  }
}
