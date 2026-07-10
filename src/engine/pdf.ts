import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

// Thin wrapper around pdf.js. Everything is client-side: bytes come from the
// user's file (or IndexedDB) and never touch a network. The worker is bundled by
// Vite via the ?url import so the PWA works fully offline.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // Copy into a fresh buffer — pdf.js transfers/neuters the one it's given, which
  // would corrupt the copy we persist to IndexedDB.
  return pdfjs.getDocument({ data: data.slice(0) }).promise
}

/**
 * Render a page to an offscreen canvas at the given CSS scale, sharpened by the
 * device pixel ratio. This canvas is the *source texture* for the recolor pass —
 * re-rendered fresh at every zoom so text stays vector-crisp, never a scaled bitmap.
 */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  cssScale: number,
  dpr = Math.min(window.devicePixelRatio || 1, 3),
): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: cssScale * dpr })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas
}

export type { PDFDocumentProxy, PDFPageProxy }
