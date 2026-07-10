import { PDFDocument } from 'pdf-lib'
import { renderPageToCanvas, type PDFDocumentProxy } from '../engine/pdf'
import { Recolorizer } from '../engine/recolor'
import type { Theme } from '../engine/theme'

// Milestone 3: export a dark PDF you can drop into Apple Books.
//
// This is the daily-use win for the "download a book PDF, read it on my phone"
// habit. We render each page at print resolution, recolor it with the SAME
// saturation-aware shader as the live reader (so colour images are preserved, not
// inverted), and assemble a fresh PDF via pdf-lib.
//
// Trade-off, stated honestly: this v1 export is raster (pages become high-DPI
// images), so the exported text is not selectable. It IS sharp — 300 DPI is well
// beyond any phone/tablet screen, far past the ~150 DPI blur of typical tools. The
// later "vector export" milestone rewrites colour operators to keep text vector +
// selectable; this raster path is the dependable floor that works on every PDF.

export interface ExportOptions {
  theme: Theme
  satCut: number
  dpi?: number // default 300
  quality?: number // JPEG quality 0..1, default 0.85
  onProgress?: (done: number, total: number) => void
}

export async function exportDarkPdf(doc: PDFDocumentProxy, opts: ExportOptions): Promise<Blob> {
  const dpi = opts.dpi ?? 300
  const quality = opts.quality ?? 0.85
  const renderScale = dpi / 72 // PDF user space is 72 units/inch

  const out = await PDFDocument.create()
  const glCanvas = document.createElement('canvas')
  const recolor = new Recolorizer(glCanvas, /* preserveDrawingBuffer */ true)

  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)

      // dpr=1: renderScale already encodes the target DPI.
      const source = await renderPageToCanvas(page, renderScale, 1)
      recolor.render(source, source.width, source.height, { theme: opts.theme, satCut: opts.satCut })

      const bytes = await canvasJpeg(glCanvas, quality)
      const jpg = await out.embedJpg(bytes)

      // Output page keeps the original point dimensions; the hi-res image fills it.
      const pts = page.getViewport({ scale: 1 })
      const outPage = out.addPage([pts.width, pts.height])
      outPage.drawImage(jpg, { x: 0, y: 0, width: pts.width, height: pts.height })

      opts.onProgress?.(i, doc.numPages)
      // Let the UI breathe between pages on long books.
      await new Promise((r) => setTimeout(r, 0))
    }

    const saved = await out.save()
    // Copy into an ArrayBuffer-backed view so the Blob part type is unambiguous
    // (pdf-lib's return type widens to ArrayBufferLike under strict TS).
    const buf = new Uint8Array(saved.length)
    buf.set(saved)
    return new Blob([buf], { type: 'application/pdf' })
  } finally {
    recolor.dispose()
  }
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) return reject(new Error('export-encode-failed'))
        resolve(new Uint8Array(await blob.arrayBuffer()))
      },
      'image/jpeg',
      quality,
    )
  })
}

/** Trigger a browser download of the exported dark PDF. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
