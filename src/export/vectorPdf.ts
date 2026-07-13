import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Theme } from '../engine/theme'
import { renderPageToCanvas, type CropBox } from '../engine/pdf'
import { dominantLuma, DARK_PAGE_LUMA } from '../engine/pipeline'
import { getPageText, rangeRects, type TextCache } from '../engine/search'

// Vector export — roadmap 10. Instead of rasterizing pages (sharp but huge and
// unselectable), rewrite the PDF's own colour operators so the SAME vector
// page — same fonts, same text layer, same images — draws itself in the theme.
//
// The recolor rules are a port of engine/shader.ts onto colour operands:
//   - low-saturation colours (ink/paper/greys) land on the fg<->bg luminance
//     ramp; saturated colours keep their hue but shift to the ramp's luminance
//     (the "readable hyperlink" treatment).
//   - images are untouched BY CONSTRUCTION: they carry their own pixel data,
//     which colour operators never feed into. No inversion is possible here.
//   - pages that are already dark (dominant tone below the polarity threshold,
//     same detector the live reader uses) pass through untouched.
//
// Deliberate v1 limits: 1-component sc/scn (Separation tints) and shading
// dictionaries pass through unmapped; those pages still get the dark ground
// and ink remap for everything else.

// ---- colour math (shader.ts port) -----------------------------------------

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

function mapRgb(
  r: number,
  g: number,
  b: number,
  theme: Theme,
  satCut: number,
): [number, number, number] {
  const L = luma(r, g, b)
  const achro: [number, number, number] = [
    theme.fg[0] + (theme.bg[0] - theme.fg[0]) * L,
    theme.fg[1] + (theme.bg[1] - theme.fg[1]) * L,
    theme.fg[2] + (theme.bg[2] - theme.fg[2]) * L,
  ]
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const sat = mx <= 1e-4 ? 0 : (mx - mn) / mx
  const keep = smoothstep(satCut * 0.6, satCut, sat)
  const dL = luma(achro[0], achro[1], achro[2]) - L
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  return [
    achro[0] + (clamp01(r + dL) - achro[0]) * keep,
    achro[1] + (clamp01(g + dL) - achro[1]) * keep,
    achro[2] + (clamp01(b + dL) - achro[2]) * keep,
  ]
}

const cmykToRgb = (c: number, m: number, y: number, k: number): [number, number, number] => [
  (1 - c) * (1 - k),
  (1 - m) * (1 - k),
  (1 - y) * (1 - k),
]

function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b)
  if (k >= 1) return [0, 0, 0, 1]
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k]
}

const fmt = (n: number) => (Math.round(n * 10000) / 10000).toString()

// ---- content-stream lexer + rewriter ---------------------------------------

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)))
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c)

interface Operand {
  start: number
  value: number | null // null = non-numeric (name, string, array bracket…)
}

/** How many numeric operands each rewritable colour operator consumes. */
const COLOR_OPS: Record<string, number> = { g: 1, G: 1, rg: 3, RG: 3, k: 4, K: 4 }

/**
 * Stream-rewrite pass: copies bytes through verbatim, replacing only the
 * operands+operator of colour-setting operations. Anything unrecognised —
 * strings, dicts, inline images — is skipped structurally, never altered.
 */
function recolorContentStream(src: Uint8Array, theme: Theme, satCut: number): Uint8Array {
  const out: Uint8Array[] = []
  const enc = new TextEncoder()
  let flushed = 0
  let i = 0
  let operands: Operand[] = []

  const emit = (upto: number, replacement: string) => {
    out.push(src.subarray(flushed, upto))
    out.push(enc.encode(replacement))
    flushed = i
  }

  const mapped = (nums: number[], op: string): string | null => {
    if (op === 'g' || op === 'G') {
      const [r, g, b] = mapRgb(nums[0], nums[0], nums[0], theme, satCut)
      return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${op === 'g' ? 'rg' : 'RG'}`
    }
    if (op === 'rg' || op === 'RG') {
      const [r, g, b] = mapRgb(nums[0], nums[1], nums[2], theme, satCut)
      return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${op}`
    }
    if (op === 'k' || op === 'K') {
      const [r0, g0, b0] = cmykToRgb(nums[0], nums[1], nums[2], nums[3])
      const [r, g, b] = mapRgb(r0, g0, b0, theme, satCut)
      return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${op === 'k' ? 'rg' : 'RG'}`
    }
    // sc/scn in a 3- or 4-component numeric colourspace: rewrite the numbers,
    // keep the operator (and so the declared colourspace and operand count).
    if (op === 'sc' || op === 'SC' || op === 'scn' || op === 'SCN') {
      if (nums.length === 3) {
        const [r, g, b] = mapRgb(nums[0], nums[1], nums[2], theme, satCut)
        return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${op}`
      }
      if (nums.length === 4) {
        const [r0, g0, b0] = cmykToRgb(nums[0], nums[1], nums[2], nums[3])
        const [r, g, b] = mapRgb(r0, g0, b0, theme, satCut)
        const [c, m, y, k] = rgbToCmyk(r, g, b)
        return `${fmt(c)} ${fmt(m)} ${fmt(y)} ${fmt(k)} ${op}`
      }
    }
    return null
  }

  while (i < src.length) {
    const c = src[i]

    if (WS.has(c)) {
      i++
      continue
    }
    if (c === 0x25 /* % */) {
      while (i < src.length && src[i] !== 10 && src[i] !== 13) i++
      continue
    }
    if (c === 0x28 /* ( */) {
      const start = i
      let depth = 0
      do {
        if (src[i] === 0x5c /* \ */) i++ // escape: skip next byte
        else if (src[i] === 0x28) depth++
        else if (src[i] === 0x29) depth--
        i++
      } while (i < src.length && depth > 0)
      operands.push({ start, value: null })
      continue
    }
    if (c === 0x3c /* < */) {
      const start = i
      if (src[i + 1] === 0x3c) {
        i += 2 // << dict open; contents lex as ordinary tokens
      } else {
        while (i < src.length && src[i] !== 0x3e /* > */) i++
        i++
      }
      operands.push({ start, value: null })
      continue
    }
    if (c === 0x3e /* > */) {
      i += src[i + 1] === 0x3e ? 2 : 1 // >> dict close (bare > is malformed)
      operands.push({ start: i, value: null })
      continue
    }
    if (c === 0x5b || c === 0x5d /* [ ] */ || c === 0x7b || c === 0x7d /* { } */) {
      operands.push({ start: i, value: null })
      i++
      continue
    }
    if (c === 0x2f /* /name */) {
      const start = i
      i++
      while (i < src.length && isRegular(src[i])) i++
      operands.push({ start, value: null })
      continue
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const start = i
      while (
        i < src.length &&
        ((src[i] >= 0x30 && src[i] <= 0x39) || src[i] === 0x2b || src[i] === 0x2d || src[i] === 0x2e)
      )
        i++
      const text = String.fromCharCode(...src.subarray(start, i))
      const v = parseFloat(text)
      operands.push({ start, value: Number.isFinite(v) ? v : null })
      continue
    }

    // operator token
    {
      const start = i
      while (i < src.length && isRegular(src[i])) i++
      if (i === start) {
        i++ // lone delimiter we don't model; never part of a colour op
        continue
      }
      const op = String.fromCharCode(...src.subarray(start, i))

      if (op === 'BI') {
        // Inline image: binary payload — skip to EI at a token boundary.
        while (i < src.length) {
          if (
            src[i] === 0x45 &&
            src[i + 1] === 0x49 &&
            WS.has(src[i - 1]) &&
            (i + 2 >= src.length || WS.has(src[i + 2]) || DELIM.has(src[i + 2]))
          ) {
            i += 2
            break
          }
          i++
        }
        operands = []
        continue
      }

      const need = COLOR_OPS[op]
      const isScn = op === 'sc' || op === 'SC' || op === 'scn' || op === 'SCN'
      if (need !== undefined || isScn) {
        const take = need ?? operands.length
        const args = operands.slice(-take)
        const nums = args.map((a) => a.value)
        if (args.length === take && take > 0 && nums.every((v) => v !== null)) {
          const rep = mapped(nums as number[], op)
          if (rep) emit(args[0].start, rep)
        }
      }
      operands = []
      continue
    }
  }

  out.push(src.subarray(flushed))
  const total = out.reduce((n, a) => n + a.length, 0)
  const joined = new Uint8Array(total)
  let off = 0
  for (const a of out) {
    joined.set(a, off)
    off += a.length
  }
  return joined
}

// ---- document walking -------------------------------------------------------

const NL = new Uint8Array([10])

function concatStreams(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, a) => n + a.length + 1, 0)
  const joined = new Uint8Array(total)
  let off = 0
  for (const a of parts) {
    joined.set(a, off)
    off += a.length
    joined.set(NL, off)
    off += 1
  }
  return joined
}

/** Rewrite every Form XObject reachable from a Resources dict (recursively). */
function rewriteForms(
  res: PDFDict | undefined,
  doc: PDFDocument,
  theme: Theme,
  satCut: number,
  visited: Set<string>,
): void {
  if (!res) return
  const xo = res.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (!xo) return
  for (const key of xo.keys()) {
    const ref = xo.get(key)
    if (!(ref instanceof PDFRef) || visited.has(ref.toString())) continue
    visited.add(ref.toString())
    const stream = doc.context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) continue
    const subtype = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)
    if (subtype?.asString() !== '/Form') continue // images stay byte-identical
    try {
      const decoded = decodePDFRawStream(stream).decode()
      const rewritten = recolorContentStream(decoded, theme, satCut)
      const dict = stream.dict.clone(doc.context)
      dict.delete(PDFName.of('Filter'))
      dict.delete(PDFName.of('DecodeParms'))
      dict.set(PDFName.of('Length'), doc.context.obj(rewritten.length))
      doc.context.assign(ref, PDFRawStream.of(dict, rewritten))
      rewriteForms(
        dict.lookupMaybe(PDFName.of('Resources'), PDFDict),
        doc,
        theme,
        satCut,
        visited,
      )
    } catch {
      /* undecodable form: leave it as it was */
    }
  }
}

/** Pages whose dominant tone is already dark — pass through, like the reader. */
async function findDarkPages(doc: PDFDocumentProxy, from: number, to: number): Promise<Set<number>> {
  const dark = new Set<number>()
  for (let p = from; p <= to; p++) {
    const page = await doc.getPage(p)
    const thumb = await renderPageToCanvas(page, 0.12, 1)
    if (dominantLuma(thumb) < DARK_PAGE_LUMA) dark.add(p - 1)
  }
  return dark
}

export interface ExportHighlight {
  page: number
  start: number
  end: number
  text: string
}

/**
 * Write stored character-range highlights into the document as real Highlight
 * annotations (QuadPoints), so Apple Books/Preview show them. Geometry comes
 * from the same rangeRects the live reader draws with, converted back into
 * PDF user space via the page viewport.
 */
async function addHighlightAnnots(
  pdf: PDFDocument,
  doc: PDFDocumentProxy,
  highlights: ExportHighlight[],
  textCache: TextCache,
): Promise<void> {
  const byPage = new Map<number, ExportHighlight[]>()
  for (const h of highlights) {
    if (!byPage.has(h.page)) byPage.set(h.page, [])
    byPage.get(h.page)!.push(h)
  }

  for (const [pageNo, hls] of byPage) {
    if (pageNo < 1 || pageNo > pdf.getPageCount()) continue
    const pdfjsPage = await doc.getPage(pageNo)
    const pt = await getPageText(pdfjsPage, textCache)
    const vp = pdfjsPage.getViewport({ scale: 1 })
    const leaf = pdf.getPage(pageNo - 1)

    let annots = leaf.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    if (!annots) {
      annots = pdf.context.obj([]) as PDFArray
      leaf.node.set(PDFName.of('Annots'), annots)
    }

    for (const h of hls) {
      const rects = rangeRects(pdfjsPage, pt, h.start, h.end, 1)
      if (!rects.length) continue
      const quads: number[] = []
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const r of rects) {
        // Viewport space is top-left origin; PDF space is bottom-up. The four
        // corners convert to the de-facto QuadPoints order UL,UR,LL,LR.
        const ul = vp.convertToPdfPoint(r.left, r.top)
        const ur = vp.convertToPdfPoint(r.left + r.width, r.top)
        const ll = vp.convertToPdfPoint(r.left, r.top + r.height)
        const lr = vp.convertToPdfPoint(r.left + r.width, r.top + r.height)
        quads.push(ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1])
        for (const [px, py] of [ul, ur, ll, lr]) {
          x0 = Math.min(x0, px)
          y0 = Math.min(y0, py)
          x1 = Math.max(x1, px)
          y1 = Math.max(y1, py)
        }
      }
      const annot = pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [x0, y0, x1, y1],
        QuadPoints: quads,
        C: [0.79, 0.65, 0.42], // the accent gold, readable on dark and light
        CA: 0.45,
        F: 4, // print flag; keeps viewers from hiding it
        Contents: PDFHexString.fromText(h.text.slice(0, 500)),
      })
      annots.push(pdf.context.register(annot))
    }
  }
}

export async function exportVectorPdf(
  doc: PDFDocumentProxy,
  srcBytes: ArrayBuffer,
  opts: {
    theme: Theme
    satCut: number
    /** Inclusive 1-based page range; defaults to the whole book. */
    from?: number
    to?: number
    /** Margin auto-crop: applied as each page's CropBox (content untouched). */
    crop?: CropBox | null
    highlights?: ExportHighlight[]
    textCache?: TextCache
    onProgress?: (done: number, total: number) => void
  },
): Promise<Blob> {
  const { theme, satCut } = opts
  const from = Math.max(1, opts.from ?? 1)
  const to = Math.min(doc.numPages, opts.to ?? doc.numPages)
  const darkPages = await findDarkPages(doc, from, to)

  const pdf = await PDFDocument.load(srcBytes, { updateMetadata: false })
  const ctx = pdf.context
  const pages = pdf.getPages()
  const visited = new Set<string>()
  const enc = new TextEncoder()

  for (let idx = from - 1; idx <= to - 1 && idx < pages.length; idx++) {
    opts.onProgress?.(idx - from + 1, to - from + 1)
    const page = pages[idx]

    // Margin crop travels as the page's CropBox — viewers show the content
    // box, the underlying page stays intact. crop.fy is a fraction from the
    // TOP edge (viewport space); PDF boxes measure from the bottom.
    if (opts.crop) {
      const { x, y, width, height } = page.getMediaBox()
      page.setCropBox(
        x + opts.crop.fx * width,
        y + (1 - opts.crop.fy - opts.crop.fh) * height,
        opts.crop.fw * width,
        opts.crop.fh * height,
      )
    }

    if (darkPages.has(idx)) continue

    // Collect this page's content stream(s), decoded.
    const contentsRaw = page.node.get(PDFName.of('Contents'))
    const refs: PDFRef[] = []
    const resolved = contentsRaw instanceof PDFRef ? ctx.lookup(contentsRaw) : contentsRaw
    if (contentsRaw instanceof PDFRef && resolved instanceof PDFRawStream) refs.push(contentsRaw)
    else if (resolved instanceof PDFArray) {
      for (const el of resolved.asArray()) if (el instanceof PDFRef) refs.push(el)
    }
    if (!refs.length) continue

    let decodedParts: Uint8Array[]
    try {
      decodedParts = refs.map((r) => decodePDFRawStream(ctx.lookup(r) as PDFRawStream).decode())
    } catch {
      continue // undecodable page: leave it untouched (tone floor is "original")
    }

    const rewritten = recolorContentStream(concatStreams(decodedParts), theme, satCut)

    // Dark ground underneath, then the defaults: content that never sets a
    // colour is painted in PDF-default black, which must land on the ink ramp.
    const { x, y, width, height } = page.getMediaBox()
    const [fr, fg2, fb] = mapRgb(0, 0, 0, theme, satCut)
    const prefix =
      `q ${fmt(theme.bg[0])} ${fmt(theme.bg[1])} ${fmt(theme.bg[2])} rg ` +
      `${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)} re f Q ` +
      `${fmt(fr)} ${fmt(fg2)} ${fmt(fb)} rg ${fmt(fr)} ${fmt(fg2)} ${fmt(fb)} RG\n`

    const final = concatStreams([enc.encode(prefix), rewritten])
    const streamRef = ctx.register(ctx.flateStream(final))
    page.node.set(PDFName.of('Contents'), streamRef)

    rewriteForms(page.node.Resources(), pdf, theme, satCut, visited)

    // Let the UI breathe on long books.
    await new Promise((r) => setTimeout(r, 0))
  }
  // Annotate while every page still exists (highlight page numbers index the
  // full document), then trim to the requested range.
  const inRange = opts.highlights?.filter((h) => h.page >= from && h.page <= to)
  if (inRange?.length && opts.textCache) {
    await addHighlightAnnots(pdf, doc, inRange, opts.textCache)
  }
  if (from > 1 || to < pages.length) {
    for (let i = pdf.getPageCount() - 1; i >= 0; i--) {
      if (i < from - 1 || i > to - 1) pdf.removePage(i)
    }
  }
  opts.onProgress?.(to - from + 1, to - from + 1)

  const saved = await pdf.save()
  const buf = new Uint8Array(saved.length)
  buf.set(saved)
  return new Blob([buf], { type: 'application/pdf' })
}
