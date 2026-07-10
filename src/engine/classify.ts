import * as pdfjs from 'pdfjs-dist'
import type { PDFPageProxy } from 'pdfjs-dist'

// The "never say impossible with this PDF" spine.
//
// Every page is classified, then routed to the recolor strategy that fits it —
// with a guaranteed floor (tone-map) that always yields a readable dark page. We
// never reject a PDF; worst case is "merely good" instead of "perfect".
//
//   digital-text : real text layer, images (if any) have known bounding boxes.
//                  -> recolor ink, mask declared images, keep text crisp/selectable.
//   vector       : drawing ops, little/no extractable text (diagrams, slides).
//                  -> luminance recolor of strokes/fills, preserve saturated.
//   scanned      : page is essentially one big image, no text layer.
//                  -> adaptive/tone-map recolor now; OCR (Tesseract) later to
//                     rebuild a text layer for Text Mode.
//   unknown      : anything that doesn't fit -> the guaranteed tone-map floor.

export type PageKind = 'digital-text' | 'vector' | 'scanned' | 'unknown'

export type RecolorStrategy = 'ink-mask' | 'luminance' | 'tonemap'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PageClassification {
  kind: PageKind
  strategy: RecolorStrategy
  /** Bounding boxes (PDF user space) of declared image XObject draws. */
  imageRects: Rect[]
  /** Fraction of the page area covered by declared images, 0..1. */
  imageCoverage: number
  textChars: number
}

const STRATEGY: Record<PageKind, RecolorStrategy> = {
  'digital-text': 'ink-mask',
  vector: 'luminance',
  scanned: 'tonemap',
  unknown: 'tonemap',
}

/**
 * Classify a single page. Reads the text content length and walks the operator
 * list tracking the transform stack, so every declared image draw yields its
 * bounding box in PDF user space. Pure enough to unit test.
 */
export async function classifyPage(page: PDFPageProxy): Promise<PageClassification> {
  const [text, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()])
  const textChars = text.items.reduce((n, it) => n + ('str' in it ? it.str.length : 0), 0)

  const imageRects = extractImageRects(ops)
  const view = page.view // [x0, y0, x1, y1]
  const pageArea = Math.max(1, (view[2] - view[0]) * (view[3] - view[1]))
  const imageCoverage = Math.min(
    1,
    imageRects.reduce((sum, r) => sum + clippedArea(r, view), 0) / pageArea,
  )

  let kind: PageKind
  if (textChars > 40) {
    kind = 'digital-text'
  } else if (imageCoverage > 0.8) {
    kind = 'scanned'
  } else if (imageRects.length > 0 || ops.fnArray.length > 8) {
    kind = 'vector'
  } else {
    kind = 'unknown'
  }

  return { kind, strategy: STRATEGY[kind], imageRects, imageCoverage, textChars }
}

// --- operator-list walk -----------------------------------------------------

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

// PDF concatenation order: the new matrix maps into the current CTM
// (same as pdf.js Util.transform).
function concat(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

function applyPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

// pdf.js paints an image XObject into the unit square [0,1]² of the CTM in
// effect at the paint op. Walking save/restore/transform (and form XObject
// begin/end, which carry their own matrix) recovers each image's user-space
// bounding box without rendering anything.
const PAINT_IMAGE_OPS = new Set<number>([
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintImageXObjectRepeat,
])

export function extractImageRects(ops: { fnArray: number[]; argsArray: unknown[] }): Rect[] {
  const { OPS } = pdfjs
  let ctm: Matrix = IDENTITY
  const stack: Matrix[] = []
  const rects: Rect[] = []

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) {
      stack.push(ctm)
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY
    } else if (fn === OPS.transform) {
      ctm = concat(ctm, args as Matrix)
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      const m = (args as [Matrix | null, unknown])?.[0]
      if (m) ctm = concat(ctm, m)
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? IDENTITY
    } else if (PAINT_IMAGE_OPS.has(fn)) {
      const corners = [applyPoint(ctm, 0, 0), applyPoint(ctm, 1, 0), applyPoint(ctm, 0, 1), applyPoint(ctm, 1, 1)]
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      rects.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y })
    }
  }
  return rects
}

function clippedArea(r: Rect, view: number[]): number {
  const w = Math.max(0, Math.min(r.x + r.w, view[2]) - Math.max(r.x, view[0]))
  const h = Math.max(0, Math.min(r.y + r.h, view[3]) - Math.max(r.y, view[1]))
  return w * h
}

export { PAINT_IMAGE_OPS }
