import { PDFDocument } from 'pdf-lib'
import type { CropBox, PDFDocumentProxy } from '../engine/pdf'
import { Recolorizer } from '../engine/recolor'
import { renderDarkPage } from '../engine/pipeline'
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
  /** Inclusive 1-based page range; defaults to the whole book. */
  from?: number
  to?: number
  /** Brightness of preserved images — the reader's "Image brightness" slider. */
  imageDim?: number
  /** Margin auto-crop, when the reader has it on. Pages shrink to the content box. */
  crop?: CropBox | null
  onProgress?: (done: number, total: number) => void
}

export async function exportDarkPdf(doc: PDFDocumentProxy, opts: ExportOptions): Promise<Blob> {
  const dpi = opts.dpi ?? 300
  const quality = opts.quality ?? 0.85
  const renderScale = dpi / 72 // PDF user space is 72 units/inch
  const from = Math.max(1, opts.from ?? 1)
  const to = Math.min(doc.numPages, opts.to ?? doc.numPages)
  const total = Math.max(0, to - from + 1)

  const out = await PDFDocument.create()
  const glCanvas = document.createElement('canvas')
  const srcCanvas = document.createElement('canvas') // reused for every page render
  const recolor = new Recolorizer(glCanvas, /* preserveDrawingBuffer */ true)

  try {
    for (let i = from; i <= to; i++) {
      const page = await doc.getPage(i)

      // dpr=1: renderScale already encodes the target DPI. Same pipeline as the
      // live reader — polarity, image masking, colour text, image brightness,
      // crop — so what you export is what you saw. (The pipeline clamps
      // oversized pages to the canvas budget, so a large-format PDF at 300 DPI
      // can't kill the tab.)
      await renderDarkPage(page, renderScale, 1, recolor, {
        theme: opts.theme,
        satCut: opts.satCut,
        imageDim: opts.imageDim,
        crop: opts.crop,
        sourceCanvas: srcCanvas,
      })

      const bytes = await canvasJpeg(glCanvas, quality)
      const jpg = await out.embedJpg(bytes)

      // Output page keeps the original point dimensions (shrunk to the content
      // box when cropping); the hi-res image fills it.
      const pts = page.getViewport({ scale: 1 })
      const w = pts.width * (opts.crop?.fw ?? 1)
      const h = pts.height * (opts.crop?.fh ?? 1)
      const outPage = out.addPage([w, h])
      outPage.drawImage(jpg, { x: 0, y: 0, width: w, height: h })

      opts.onProgress?.(i - from + 1, total)
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

/** Trigger a browser download; the caller names the file (extension included). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
