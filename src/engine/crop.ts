import type { PDFDocumentProxy } from 'pdfjs-dist'
import { renderPageToCanvas, type CropBox } from './pdf'

// Margin auto-crop: book pages carry print margins that waste a fifth of a
// phone screen. We detect ONE shared content box for the whole document —
// per-page boxes would make the scale jitter on every turn — by sampling
// pages, finding each one's ink bounding box, and taking the union. Full-bleed
// pages (covers, photos) are excluded from detection and, in the reader, from
// cropping. Caps keep a bad detection survivable; when there's nothing worth
// cropping we return null and the Crop toggle never appears.

const SAMPLE_PAGES = 12
const DETECT_WIDTH = 200 // px; finding the content box needs only a coarse render
const INK_THRESHOLD = 0.12 // luma deviation from the paper tone that counts as content
const EDGE_PAD = 0.015 // breathing room around the union
const MAX_EDGE_CROP = 0.2 // never crop more than 20% from any edge
const MIN_GAIN = 0.95 // box ≈ whole page in both axes → not worth cropping

export async function detectContentBox(doc: PDFDocumentProxy): Promise<CropBox | null> {
  const start = doc.numPages > 8 ? 4 : 1 // skip cover/front matter when we can
  const n = Math.min(SAMPLE_PAGES, doc.numPages)
  const picks = new Set<number>()
  for (let i = 0; i < n; i++) {
    picks.add(start + Math.floor(((doc.numPages - start) * i) / n))
  }

  const boxes: CropBox[] = []
  for (const no of picks) {
    try {
      const page = await doc.getPage(no)
      const scale = DETECT_WIDTH / page.getViewport({ scale: 1 }).width
      const box = contentBoxOf(await renderPageToCanvas(page, scale, 1))
      // Full-bleed pages say nothing about the text margins.
      if (box && box.fw * box.fh < 0.9) boxes.push(box)
    } catch {
      /* unrenderable page; skip */
    }
  }
  if (!boxes.length) return null

  let x1 = 1
  let y1 = 1
  let x2 = 0
  let y2 = 0
  for (const b of boxes) {
    x1 = Math.min(x1, b.fx)
    y1 = Math.min(y1, b.fy)
    x2 = Math.max(x2, b.fx + b.fw)
    y2 = Math.max(y2, b.fy + b.fh)
  }
  x1 = Math.min(Math.max(0, x1 - EDGE_PAD), MAX_EDGE_CROP)
  y1 = Math.min(Math.max(0, y1 - EDGE_PAD), MAX_EDGE_CROP)
  x2 = Math.max(Math.min(1, x2 + EDGE_PAD), 1 - MAX_EDGE_CROP)
  y2 = Math.max(Math.min(1, y2 + EDGE_PAD), 1 - MAX_EDGE_CROP)
  const box = { fx: x1, fy: y1, fw: x2 - x1, fh: y2 - y1 }
  return box.fw > MIN_GAIN && box.fh > MIN_GAIN ? null : box
}

/** Ink bounding box of a rendered page, as fractions; null for a blank page. */
function contentBoxOf(canvas: HTMLCanvasElement): CropBox | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { width: w, height: h } = canvas
  const d = ctx.getImageData(0, 0, w, h).data
  const lumaAt = (x: number, y: number) => {
    const i = (y * w + x) * 4
    return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
  }

  // Paper tone from the corners (middle two of four = median, outlier-proof).
  const corners = [lumaAt(1, 1), lumaAt(w - 2, 1), lumaAt(1, h - 2), lumaAt(w - 2, h - 2)].sort(
    (a, b) => a - b,
  )
  const bg = (corners[1] + corners[2]) / 2

  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(lumaAt(x, y) - bg) > INK_THRESHOLD) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { fx: minX / w, fy: minY / h, fw: (maxX - minX + 1) / w, fh: (maxY - minY + 1) / h }
}
