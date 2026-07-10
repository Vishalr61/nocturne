import type { PDFDocumentProxy, PDFPageProxy } from './pdf'
import type { CropBox } from './pdf'

// Full-text search over a book, using the text layer pdf.js already extracts
// (the same one classify.ts reads). No server, no index built ahead of time:
// pages are scanned lazily, cached per document, and results stream out as
// they're found so a 1747-page textbook stays responsive.
//
// Pages are scanned in "reading order from where you are" (see searchBook), so
// the first hits you see are usually the ones you meant.

/** One text run on a page, with its slice of the page's flattened text. */
export interface Run {
  start: number
  end: number
  str: string
  transform: number[]
  width: number
  height: number
}

export interface PageText {
  text: string
  runs: Run[]
}

export type TextCache = Map<number, PageText>

export interface SearchHit {
  page: number
  /** The matched text with a little context on either side, for the results list. */
  before: string
  match: string
  after: string
}

export interface HighlightRect {
  left: number
  top: number
  width: number
  height: number
}

/** 2×3 affine matrix multiply — pdf.js's Util.transform, inlined to avoid
 *  depending on an internal export. */
export function mul(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

/**
 * Page text, cached. The key is taken from the proxy itself, never from a page
 * number the caller passes in: a caller whose page state has advanced ahead of
 * its page proxy would otherwise cache the wrong page's text under the new
 * number, and every later read would return it. (That bug was real.)
 */
export async function getPageText(page: PDFPageProxy, cache: TextCache): Promise<PageText> {
  const no = page.pageNumber
  const hit = cache.get(no)
  if (hit) return hit

  const content = await page.getTextContent()
  const runs: Run[] = []
  let text = ''
  for (const item of content.items) {
    if (!('str' in item)) continue // marked-content markers carry no text
    const start = text.length
    text += item.str
    runs.push({
      start,
      end: text.length,
      str: item.str,
      transform: item.transform,
      width: item.width,
      height: item.height,
    })
    // pdf.js signals a line break; a space keeps words from fusing across lines.
    if (item.hasEOL) text += ' '
  }
  const pt = { text, runs }
  cache.set(no, pt)
  return pt
}

/** Case/whitespace-insensitive haystack for matching, same length as the source. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s/g, ' ')
}

/** Snippet cosmetics: contents pages are mostly dot leaders, which read as noise. */
function tidy(s: string): string {
  return s.replace(/[.…·]{3,}/g, ' … ').replace(/\s{2,}/g, ' ')
}

export interface SearchOptions {
  /** Start scanning here and wrap around — hits near your page arrive first. */
  fromPage?: number
  /** Called after each page so the UI can show progress. */
  onProgress?: (scanned: number, total: number) => void
  /** Set aborted.value = true to stop a search in flight. */
  aborted?: { value: boolean }
  maxHits?: number
}

/**
 * Stream hits for `query` across the whole document. Yields as it goes, so the
 * caller can render partial results and abort when the query changes.
 */
export async function* searchBook(
  doc: PDFDocumentProxy,
  query: string,
  cache: TextCache,
  opts: SearchOptions = {},
): AsyncGenerator<SearchHit> {
  const needle = normalize(query.trim())
  if (needle.length < 2) return

  const total = doc.numPages
  const from = Math.min(Math.max(1, opts.fromPage ?? 1), total)
  const maxHits = opts.maxHits ?? 200
  let hits = 0

  for (let i = 0; i < total; i++) {
    if (opts.aborted?.value) return
    // Wrap: from, from+1, … total, 1, 2, … from-1
    const no = ((from - 1 + i) % total) + 1
    let pt: PageText
    try {
      pt = await getPageText(await doc.getPage(no), cache)
    } catch {
      continue // unreadable page; keep going
    }
    opts.onProgress?.(i + 1, total)

    const hay = normalize(pt.text)
    let at = hay.indexOf(needle)
    while (at !== -1) {
      yield {
        page: no,
        before: tidy(pt.text.slice(Math.max(0, at - 40), at)).trimStart(),
        match: pt.text.slice(at, at + needle.length),
        after: tidy(pt.text.slice(at + needle.length, at + needle.length + 60)).trimEnd(),
      }
      if (++hits >= maxHits) return
      at = hay.indexOf(needle, at + needle.length)
      if (opts.aborted?.value) return
    }
    // Let the browser paint between pages; search must never freeze the reader.
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * Boxes to draw over the rendered canvas for every match of `query` on `page`,
 * in CSS pixels relative to the canvas's top-left. `cssScale` and `crop` must
 * be the ones the page was rendered with, or the boxes will sit in the wrong
 * place — the reader passes its own render settings straight through.
 */
export async function matchRectsOnPage(
  page: PDFPageProxy,
  query: string,
  cache: TextCache,
  cssScale: number,
  crop?: CropBox | null,
): Promise<HighlightRect[]> {
  const needle = normalize(query.trim())
  if (needle.length < 2) return []
  const pt = await getPageText(page, cache)
  const hay = normalize(pt.text)

  const rects: HighlightRect[] = []
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    rects.push(...rangeRects(page, pt, at, at + needle.length, cssScale, crop))
  }
  return rects
}

/**
 * The same viewport pdf.js rendered with, so overlays land on the glyphs. Both
 * the crop offset and the scale must match the reader's render exactly.
 */
export function textViewport(page: PDFPageProxy, cssScale: number, crop?: CropBox | null) {
  const full = page.getViewport({ scale: cssScale })
  if (!crop) return full
  return page.getViewport({
    scale: cssScale,
    offsetX: -crop.fx * full.width,
    offsetY: -crop.fy * full.height,
  })
}

/** Boxes covering [start,end) of a page's flattened text, in CSS px. */
export function rangeRects(
  page: PDFPageProxy,
  pt: PageText,
  start: number,
  end: number,
  cssScale: number,
  crop?: CropBox | null,
): HighlightRect[] {
  const viewport = textViewport(page, cssScale, crop)
  const rects: HighlightRect[] = []
  // A range can span several runs; box the overlapping slice of each.
  for (const run of pt.runs) {
    if (run.end <= start || run.start >= end) continue
    const m = mul(viewport.transform, run.transform)
    const fontHeight = Math.hypot(m[2], m[3])
    const runWidth = run.width * cssScale
    // Character offsets within the run, as fractions of its width. Proportional
    // spacing makes this an approximation; it's a highlight, not a caret.
    const n = run.str.length || 1
    const f0 = (Math.max(start, run.start) - run.start) / n
    const f1 = (Math.min(end, run.end) - run.start) / n
    rects.push({
      left: m[4] + runWidth * f0,
      top: m[5] - fontHeight,
      width: Math.max(2, runWidth * (f1 - f0)),
      height: fontHeight * 1.15,
    })
  }
  return rects
}

/** Where each run sits on the rendered page — the text layer's geometry. */
export interface RunBox {
  run: Run
  left: number
  top: number
  width: number
  fontHeight: number
  angle: number
}

export async function runBoxes(
  page: PDFPageProxy,
  cache: TextCache,
  cssScale: number,
  crop?: CropBox | null,
): Promise<{ pt: PageText; boxes: RunBox[] }> {
  const pt = await getPageText(page, cache)
  const viewport = textViewport(page, cssScale, crop)
  const boxes = pt.runs
    .filter((r) => r.str.length > 0)
    .map((run) => {
      const m = mul(viewport.transform, run.transform)
      const fontHeight = Math.hypot(m[2], m[3])
      return {
        run,
        left: m[4],
        top: m[5] - fontHeight,
        width: run.width * cssScale,
        fontHeight,
        angle: Math.atan2(m[1], m[0]),
      }
    })
  return { pt, boxes }
}
