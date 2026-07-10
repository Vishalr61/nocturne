import type { PDFPageProxy } from 'pdfjs-dist'

// The "never say impossible with this PDF" spine.
//
// Every page is classified, then routed to the recolor strategy that fits it —
// with a guaranteed floor (tone-map) that always yields a readable dark page. We
// never reject a PDF; worst case is "merely good" instead of "perfect".
//
//   digital-text : real text layer + we know image bounding boxes.
//                  -> recolor ink, mask declared images, keep text crisp/selectable.
//   vector       : drawing ops, little/no extractable text (diagrams, slides).
//                  -> luminance recolor of strokes/fills, preserve saturated.
//   scanned      : page is essentially one big image, no text layer.
//                  -> adaptive/tone-map recolor now; OCR (Tesseract) later to
//                     rebuild a text layer for Text Mode.
//   unknown      : anything that doesn't fit -> the guaranteed tone-map floor.

export type PageKind = 'digital-text' | 'vector' | 'scanned' | 'unknown'

export type RecolorStrategy = 'ink-mask' | 'luminance' | 'tonemap'

export interface PageClassification {
  kind: PageKind
  strategy: RecolorStrategy
  /** Bounding boxes (PDF user space) of images to leave untouched, when known. */
  imageRects: Array<{ x: number; y: number; w: number; h: number }>
  textChars: number
}

const STRATEGY: Record<PageKind, RecolorStrategy> = {
  'digital-text': 'ink-mask',
  vector: 'luminance',
  scanned: 'tonemap',
  unknown: 'tonemap',
}

/**
 * Classify a single page. Cheap: reads the text content length and scans the
 * operator list for image draws vs. a full-page image. Pure enough to unit test.
 */
export async function classifyPage(page: PDFPageProxy): Promise<PageClassification> {
  const [text, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()])
  const textChars = text.items.reduce((n, it) => n + ('str' in it ? it.str.length : 0), 0)

  const imageOps = countImageOps(ops)
  const view = page.view // [x0, y0, x1, y1]
  const pageArea = Math.max(1, (view[2] - view[0]) * (view[3] - view[1]))

  let kind: PageKind
  if (textChars > 40) {
    kind = 'digital-text'
  } else if (imageOps.count >= 1 && imageOps.coversMostOfPage(pageArea)) {
    kind = 'scanned'
  } else if (imageOps.count > 0 || ops.fnArray.length > 8) {
    kind = 'vector'
  } else {
    kind = 'unknown'
  }

  return { kind, strategy: STRATEGY[kind], imageRects: [], textChars }
}

// pdf.js operator function ids for image paints. Kept local so this module has a
// single, documented dependency on pdf.js op codes.
const PAINT_IMAGE_OPS = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageXObjectRepeat'])

function countImageOps(ops: { fnArray: number[]; argsArray: unknown[] }) {
  // pdf.js exposes numeric fn ids; we approximate by counting draw-ish ops. A
  // precise mapping (via pdfjsLib.OPS) is wired in when we implement true image
  // masking; for classification a heuristic count is enough.
  const count = ops.fnArray.length
  return {
    count,
    coversMostOfPage: (_pageArea: number) =>
      // A scanned page is dominated by very few ops (one big image paint).
      ops.fnArray.length > 0 && ops.fnArray.length < 12,
  }
}

export { PAINT_IMAGE_OPS }
