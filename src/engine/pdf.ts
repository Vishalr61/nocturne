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

// iOS Safari refuses canvases beyond ~16.7M pixels and its WebGL textures top
// out at 8192 px per side; past either, pages render blank or the whole tab is
// killed for memory (the "app crashed" symptom). Clamping the effective dpr
// keeps the backing store inside that budget: at extreme zoom the render gets
// slightly soft instead of the app dying. Zoom still re-renders vectors fresh —
// this only caps the resolution ceiling, it never scales a stale bitmap.
// Just under iOS's hard 16,777,216-px area limit: the clamp solves for an
// exact fit and Math.ceil on each dimension would nudge it past the line.
const MAX_CANVAS_PIXELS = 16_000_000
const MAX_CANVAS_DIM = 8192

/** A content region of a page, as fractions (0..1) of the full rendered page. */
export interface CropBox {
  fx: number
  fy: number
  fw: number
  fh: number
}

/** Largest dpr ≤ `dpr` whose render of this page fits the canvas budget. */
export function clampRenderDpr(
  page: PDFPageProxy,
  cssScale: number,
  dpr: number,
  crop?: CropBox | null,
): number {
  const vp = page.getViewport({ scale: cssScale * dpr })
  const w = vp.width * (crop?.fw ?? 1)
  const h = vp.height * (crop?.fh ?? 1)
  const byArea = Math.sqrt(MAX_CANVAS_PIXELS / (w * h))
  const byDim = MAX_CANVAS_DIM / Math.max(w, h)
  return dpr * Math.min(1, byArea, byDim)
}

/**
 * Render a page to an offscreen canvas at the given CSS scale, sharpened by the
 * device pixel ratio. This canvas is the *source texture* for the recolor pass —
 * re-rendered fresh at every zoom so text stays vector-crisp, never a scaled bitmap.
 * Pass `into` to reuse one canvas across renders (page turns would otherwise churn
 * ~100 MB allocations on a phone). Pass `crop` to render only that region of the
 * page — the viewport offset shifts the content so the canvas IS the crop, which
 * is how margin auto-crop gets bigger text without scaling a bitmap.
 */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  cssScale: number,
  dpr = Math.min(window.devicePixelRatio || 1, 3),
  into?: HTMLCanvasElement,
  crop?: CropBox | null,
): Promise<HTMLCanvasElement> {
  const full = page.getViewport({ scale: cssScale * dpr })
  const viewport = crop
    ? page.getViewport({
        scale: cssScale * dpr,
        offsetX: -crop.fx * full.width,
        offsetY: -crop.fy * full.height,
      })
    : full
  const canvas = into ?? document.createElement('canvas')
  canvas.width = Math.ceil(full.width * (crop?.fw ?? 1)) // assigning width also clears a reused canvas
  canvas.height = Math.ceil(full.height * (crop?.fh ?? 1))
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas
}

export type { PDFDocumentProxy, PDFPageProxy }
