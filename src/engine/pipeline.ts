import type { PDFPageProxy } from 'pdfjs-dist'
import { clampRenderDpr, renderPageToCanvas, type CropBox } from './pdf'
import { classifyPage, type PageClassification, type Rect } from './classify'
import { Recolorizer } from './recolor'
import type { Theme } from './theme'

// The per-page dark-render pipeline, shared by the live reader and the PDF
// export so the two can never drift apart. Order of decisions:
//
//   1. Polarity — if the page's dominant tone is already dark (a black cover,
//      a natively dark ebook page), it is already a night page: pass through.
//   2. Preserve photos, two ways of finding them:
//        a. Structure: declared image XObjects that are clearly *embedded*
//           (< half the page) and not scans of ink-on-paper.
//        b. Content: many ebook pages are one full-page bitmap mixing a photo
//           with text, so structure names no useful rect. Coarse tile
//           statistics find contiguous continuous-tone regions — photos are
//           full of mid-tones where text-on-paper is bimodal — and each
//           region's bounding box is preserved (photos are rectangular).
//      Preserved pixels keep their colours, slightly dimmed against the dark.
//   3. Colour text — a page with a text layer and zero images can safely treat
//      saturated pixels as text (hyperlinks): keep hue, flip lightness.

export interface DarkPageOptions {
  theme: Theme
  satCut: number
  strength?: number
  /** Brightness of preserved images against the dark page (default 0.82). */
  imageDim?: number
  /** Reuse this canvas as the pdf.js render target across calls (memory churn). */
  sourceCanvas?: HTMLCanvasElement
  /** Render only this page region (margin auto-crop). */
  crop?: CropBox | null
  /** Pre-computed classification; skips classifying again (reader caches these). */
  cls?: PageClassification
}

export interface DarkPageResult {
  /** The recolored pixels live in the Recolorizer's canvas; this is the source. */
  source: HTMLCanvasElement
  cls: PageClassification
  /** False when the page was detected as already-dark and passed through. */
  inkFlipped: boolean
  /** dpr actually rendered at — less than requested when the canvas budget clamped it. */
  dpr: number
}

/** Declared images covering less than this fraction of the page are "embedded". */
const EMBEDDED_IMAGE_MAX_COVERAGE = 0.5
/** Dominant page luminance below this = the page is already dark. */
export const DARK_PAGE_LUMA = 0.45
/** Brightness applied to preserved images against the dark ground. */
const IMAGE_DIM = 0.82

interface PxRect {
  x: number
  y: number
  w: number
  h: number
}

export async function renderDarkPage(
  page: PDFPageProxy,
  cssScale: number,
  dpr: number,
  recolor: Recolorizer,
  opts: DarkPageOptions,
): Promise<DarkPageResult> {
  // Clamp here, in the shared pipeline, so no caller (reader zoom, export DPI)
  // can ever ask for a canvas iOS will refuse or be killed for.
  const safeDpr = clampRenderDpr(page, cssScale, dpr, opts.crop)
  let source: HTMLCanvasElement
  let cls: PageClassification
  if (opts.cls) {
    cls = opts.cls
    source = await renderPageToCanvas(page, cssScale, safeDpr, opts.sourceCanvas, opts.crop)
  } else {
    ;[source, cls] = await Promise.all([
      renderPageToCanvas(page, cssScale, safeDpr, opts.sourceCanvas, opts.crop),
      classifyPage(page),
    ])
  }
  return finishDarkPage(page, source, cls, cssScale * safeDpr, safeDpr, recolor, opts)
}

/**
 * The recolor half of renderDarkPage, callable on an already-rendered source.
 * The reader's prefetch and slider paths use this to skip the expensive pdf.js
 * render: a prefetched page turn or a theme/brightness tweak is then just the
 * cheap GPU pass.
 */
export function finishDarkPage(
  page: PDFPageProxy,
  source: HTMLCanvasElement,
  cls: PageClassification,
  renderScale: number,
  dprUsed: number,
  recolor: Recolorizer,
  opts: DarkPageOptions,
): DarkPageResult {
  const inkFlip = dominantLuma(source) >= DARK_PAGE_LUMA
  const colorText = cls.kind === 'digital-text' && cls.imageRects.length === 0

  let mask: HTMLCanvasElement | null = null
  if (inkFlip) {
    const declared = declaredImageRects(page, cls.imageRects, renderScale, source, opts.crop)
    const found = contentPhotoRects(source)
    mask = paintMask([...declared, ...found], source.width, source.height)
  }

  // Dimming exists to seat a bright image against a dark ground. On a light
  // theme (Paper) it just greys the picture — and its preserve-rect shows as
  // a grey box on the pale page — so skip it there.
  const bgLuma =
    0.2126 * opts.theme.bg[0] + 0.7152 * opts.theme.bg[1] + 0.0722 * opts.theme.bg[2]
  recolor.render(source, source.width, source.height, {
    theme: opts.theme,
    satCut: opts.satCut,
    strength: opts.strength,
    inkFlip,
    colorText,
    mask,
    imageDim: bgLuma > 0.5 ? 1 : (opts.imageDim ?? IMAGE_DIM),
  })
  return { source, cls, inkFlipped: inkFlip, dpr: dprUsed }
}

/**
 * Render a small recolored page-1 thumbnail (JPEG data URL) for the shelf.
 * Runs the exact same pipeline as the reader, just tiny and offscreen.
 */
export async function generateThumbnail(
  page: PDFPageProxy,
  theme: Theme,
  widthPx = 280,
): Promise<string> {
  const canvas = document.createElement('canvas')
  const recolor = new Recolorizer(canvas, /* preserveDrawingBuffer */ true)
  try {
    const scale = widthPx / page.getViewport({ scale: 1 }).width
    await renderDarkPage(page, scale, 1, recolor, { theme, satCut: 0.25 })
    return canvas.toDataURL('image/jpeg', 0.8)
  } finally {
    recolor.dispose()
  }
}

/**
 * Estimate the page's dominant (background) luminance: downsample the render
 * and take the fullest of 16 luminance histogram bins. The background dominates
 * a page's area, so the modal bin is the paper tone — robust against both dark
 * covers (mode ≈ 0) and normal paper (mode ≈ 1), unlike a mean.
 */
export function dominantLuma(canvas: HTMLCanvasElement): number {
  const N = 24
  const d = samplePixels(canvas, N, N)
  const bins = new Array<number>(16).fill(0)
  for (let i = 0; i < d.length; i += 4) {
    bins[Math.min(15, Math.floor(luma8(d, i) * 16))]++
  }
  let best = 0
  for (let b = 1; b < 16; b++) if (bins[b] > bins[best]) best = b
  return (best + 0.5) / 16
}

/**
 * Declared image XObject rects worth preserving: embedded (not the whole page —
 * a full-page image IS the page and must stay recolorable) and photo-like
 * rather than a scan of ink-on-paper (a B&W logo or scanned title page belongs
 * on the ink ramp).
 */
function declaredImageRects(
  page: PDFPageProxy,
  rects: Rect[],
  renderScale: number,
  source: HTMLCanvasElement,
  crop?: CropBox | null,
): PxRect[] {
  if (!rects.length) return []
  const full = page.getViewport({ scale: renderScale })
  // The same offset viewport the render used, so rects land on cropped pixels.
  const viewport = crop
    ? page.getViewport({
        scale: renderScale,
        offsetX: -crop.fx * full.width,
        offsetY: -crop.fy * full.height,
      })
    : full
  // "Embedded" is judged against the FULL page area — cropping the margins
  // must not reclassify a half-page image as full-page.
  const pageArea = full.width * full.height
  return rects
    .map((r) => {
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h])
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
    })
    .filter((r) => r.w * r.h < EMBEDDED_IMAGE_MAX_COVERAGE * pageArea)
    .filter((r) => !isPaperLike(source, r))
}

/**
 * Find photo regions by content, for pages where structure names no useful
 * rect (full-page bitmaps mixing photo and text). The page is scanned as a
 * coarse tile grid; tiles rich in mid-tones are photo evidence, connected
 * components of them are clustered, and each sizeable cluster's bounding box
 * is preserved. Text tiles (bimodal: near-black ink on near-white paper) never
 * qualify, so ordinary prose pages produce no rects at all.
 */
function contentPhotoRects(source: HTMLCanvasElement): PxRect[] {
  const COLS = 24
  const ROWS = Math.max(8, Math.round((source.height / source.width) * COLS))
  const S = 8 // sample resolution per tile side
  const d = samplePixels(source, COLS * S, ROWS * S)

  // Per-tile mid-tone fraction.
  const mid = new Array<number>(COLS * ROWS).fill(0)
  for (let py = 0; py < ROWS * S; py++) {
    for (let px = 0; px < COLS * S; px++) {
      const l = luma8(d, (py * COLS * S + px) * 4)
      if (l > 0.22 && l < 0.78) {
        mid[Math.floor(py / S) * COLS + Math.floor(px / S)]++
      }
    }
  }
  const strong = mid.map((n) => n / (S * S) > 0.4)

  // Connected components (4-neighbour) over strong tiles; keep sizeable ones.
  const seen = new Array<boolean>(COLS * ROWS).fill(false)
  const minTiles = Math.max(4, Math.round(0.02 * COLS * ROWS))
  const rects: PxRect[] = []
  const tileW = source.width / COLS
  const tileH = source.height / ROWS

  for (let start = 0; start < strong.length; start++) {
    if (!strong[start] || seen[start]) continue
    const queue = [start]
    seen[start] = true
    let n = 0
    let minX = COLS, minY = ROWS, maxX = -1, maxY = -1
    while (queue.length) {
      const t = queue.pop()!
      const tx = t % COLS
      const ty = Math.floor(t / COLS)
      n++
      minX = Math.min(minX, tx)
      maxX = Math.max(maxX, tx)
      minY = Math.min(minY, ty)
      maxY = Math.max(maxY, ty)
      for (const nb of [t - 1, t + 1, t - COLS, t + COLS]) {
        if (nb < 0 || nb >= strong.length || seen[nb] || !strong[nb]) continue
        // Row wrap guard for horizontal neighbours.
        if ((nb === t - 1 || nb === t + 1) && Math.floor(nb / COLS) !== ty) continue
        seen[nb] = true
        queue.push(nb)
      }
    }
    if (n >= minTiles) {
      rects.push({
        x: minX * tileW,
        y: minY * tileH,
        w: (maxX - minX + 1) * tileW,
        h: (maxY - minY + 1) * tileH,
      })
    }
  }
  return rects
}

/** Paint preserve-rects into a low-res mask canvas (white = preserve). */
function paintMask(rects: PxRect[], canvasW: number, canvasH: number): HTMLCanvasElement | null {
  if (!rects.length) return null
  // Quarter resolution is plenty: rect edges align with image borders, and the
  // shader samples with LINEAR filtering for a soft one-pixel transition.
  const scale = 0.25
  const mask = document.createElement('canvas')
  mask.width = Math.max(1, Math.round(canvasW * scale))
  mask.height = Math.max(1, Math.round(canvasH * scale))
  const ctx = mask.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, mask.width, mask.height)
  ctx.fillStyle = '#fff'
  for (const r of rects) {
    ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale)
  }
  return mask
}

/**
 * Is this canvas region a scan of ink-on-paper rather than a photo? Paper-like
 * regions are bimodal — dominated by bright paper with a small, very dark ink
 * fraction and almost no chroma — while photos are full of mid-tones.
 */
function isPaperLike(source: HTMLCanvasElement, r: PxRect): boolean {
  const x = Math.max(0, r.x)
  const y = Math.max(0, r.y)
  const w = Math.min(source.width - x, r.w)
  const h = Math.min(source.height - y, r.h)
  if (w < 2 || h < 2) return true // vanishing rects: treat as page content

  const N = 32
  const probe = document.createElement('canvas')
  probe.width = N
  probe.height = N
  const ctx = probe.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, x, y, w, h, 0, 0, N, N)
  const d = ctx.getImageData(0, 0, N, N).data

  let mid = 0
  let satSum = 0
  for (let i = 0; i < d.length; i += 4) {
    const l = luma8(d, i)
    if (l > 0.25 && l < 0.75) mid++
    const mx = Math.max(d[i], d[i + 1], d[i + 2]) / 255
    const mn = Math.min(d[i], d[i + 1], d[i + 2]) / 255
    satSum += mx <= 0.0001 ? 0 : (mx - mn) / mx
  }
  const total = N * N
  return mid / total < 0.25 && satSum / total < 0.12
}

function samplePixels(source: HTMLCanvasElement, w: number, h: number): Uint8ClampedArray {
  const probe = document.createElement('canvas')
  probe.width = w
  probe.height = h
  const ctx = probe.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h).data
}

function luma8(d: Uint8ClampedArray, i: number): number {
  return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
}
