import type { PageText, Run } from './search'
import type { Rect } from './classify'

// Text Mode's hard half: turn pdf.js's loose positioned text runs back into
// paragraphs. pdf.js gives you fragments with (x, y, size, bold, italic) in PDF
// text space (y increases upward) and no notion of paragraphs, headings,
// columns, or which bits are running headers/page numbers. This reconstructs a
// readable block list — headings and paragraphs, de-hyphenated, with bold/italic
// preserved as styled spans — for a single-column prose page. It's deliberately
// conservative: multi-column or figure-heavy pages come out imperfect (that's
// what Faithful mode is for), but a novel reads cleanly.

/** A run of text with uniform styling within a block. */
export interface Span {
  text: string
  b?: boolean
  i?: boolean
}

export interface TextBlock {
  kind: 'h' | 'p'
  spans: Span[]
  /** Paragraph likely continues onto the next page (join when stitching). */
  openEnd?: boolean
  /** Paragraph likely continues from the previous page. */
  openStart?: boolean
}

/** An illustration kept in the flow at its original vertical position. The rect
 *  is in PDF user space (the same space as classify.ts's imageRects); the reader
 *  renders the recolored crop. This is what lets a chapter-divider icon or an
 *  inline figure survive reflow instead of being dropped with the layout. */
export interface ImageBlock {
  kind: 'img'
  rect: Rect
}

/** A scene break: a line of pure break glyphs ("* * *", "···", "⁂"). Blank-gap
 *  breaks are deliberately NOT detected — measured on the corpus, big gaps mark
 *  set-off boxes, verse, and section spacing far more often than scenes. */
export interface SepBlock {
  kind: 'sep'
}

export type Block = TextBlock | ImageBlock | SepBlock

/** How much to trust one page's reconstruction. The score is heuristic (1 =
 *  clean single-column prose, 0 = don't show this as text); `flags` name the
 *  detectors that fired so the verification harness can explain a low score. */
export interface ReflowQuality {
  confidence: number
  flags: string[]
}

interface Line {
  segs: Span[]
  text: string // plain, for measurement and regex checks
  x0: number
  x1: number
  y: number
  size: number
  /** Widest horizontal gap between runs inside the line, in font-size units.
   *  Prose is ~0; table rows and TOC leaders have big ones. */
  maxGap: number
}

function runX(r: Run): number {
  return r.transform[4]
}
function runY(r: Run): number {
  return r.transform[5]
}
function runSize(r: Run): number {
  return r.height || Math.hypot(r.transform[2], r.transform[3]) || 10
}

export function spansText(spans: Span[]): string {
  return spans.map((s) => s.text).join('')
}

/** Append a styled fragment, merging into the previous span if same style. */
function pushSpan(arr: Span[], text: string, b?: boolean, i?: boolean): void {
  if (!text) return
  const last = arr[arr.length - 1]
  if (last && !!last.b === !!b && !!last.i === !!i) last.text += text
  else arr.push({ text, b: b || undefined, i: i || undefined })
}

/** Group runs sharing a baseline into lines, top-to-bottom, left-to-right. */
function toLines(runs: Run[]): Line[] {
  const real = runs.filter((r) => r.str.trim().length > 0)
  if (!real.length) return []
  const sorted = [...real].sort((a, b) => runY(b) - runY(a) || runX(a) - runX(b))
  const lines: Line[] = []
  let cur: Run[] = []
  let curY = runY(sorted[0])
  const flush = () => {
    if (!cur.length) return
    const ordered = [...cur].sort((a, b) => runX(a) - runX(b))
    const segs: Span[] = []
    let text = ''
    let prevRight = -Infinity
    let maxGap = 0
    for (const r of ordered) {
      const gap = runX(r) - prevRight
      if (prevRight > -Infinity) maxGap = Math.max(maxGap, gap / runSize(r))
      // Insert a space when there's a visible gap and neither side has one. The
      // threshold is a fraction of the font size (~a space width): too high drops
      // spaces between words ("notmine"), too low splits words.
      if (text && gap > runSize(r) * 0.16 && !/\s$/.test(text) && !/^\s/.test(r.str)) {
        pushSpan(segs, ' ')
        text += ' '
      }
      pushSpan(segs, r.str, r.bold, r.italic)
      text += r.str
      prevRight = runX(r) + r.width
    }
    // Trim the line's ends without disturbing interior styling.
    if (segs.length) {
      segs[0].text = segs[0].text.replace(/^\s+/, '')
      segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, '')
    }
    const clean = segs.filter((s) => s.text.length > 0)
    lines.push({
      segs: clean,
      text: text.replace(/\s+/g, ' ').trim(),
      x0: Math.min(...ordered.map(runX)),
      x1: Math.max(...ordered.map((r) => runX(r) + r.width)),
      y: curY,
      size: Math.max(...ordered.map(runSize)),
      maxGap,
    })
    cur = []
  }
  for (const r of sorted) {
    if (cur.length && Math.abs(runY(r) - curY) > runSize(r) * 0.6) {
      flush()
      curY = runY(r)
    } else if (!cur.length) {
      curY = runY(r)
    }
    cur.push(r)
  }
  flush()
  return lines.filter((l) => l.text.length > 0)
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const SENTENCE_END = /[.!?"'”’)\]]\s*$/
// A chapter marker: a short isolated line that's a (possibly bracketed) number
// or roman numeral, or "Chapter N" — e.g. DCC's "[ 1 ]". These aren't set in a
// bigger font, so size-based heading detection misses them.
const CHAPTER_MARKER = /^[[(]?\s*(chapter\s+|part\s+)?[\divxlcdm]{1,5}\s*[\])]?$/i
// A *bracketed* marker specifically — distinguishes a chapter number "[ 1 ]"
// from a bare page number "42" (which should still be stripped as a footer).
const BRACKET_MARKER = /^[[(]\s*(chapter\s+|part\s+)?[\divxlcdm]{1,5}\s*[\])]$/i
/** Distributor watermarks ("OceanofPDF.com") masquerade as display type. */
const URLISH = /(?:https?:\/\/|www\.|\.(?:com|net|org|io|co)\b)/i
// A scene-break line: only break glyphs (asterisks, dots, dashes, fleurons),
// short, no letters or digits — "* * *", "· · ·", "⁂", "~".
const SCENE_BREAK = /^[*·•⁂✳~#_—–-\s]{1,16}$/

/**
 * Reconstruct readable blocks from one page's extracted text. `imageRects`
 * (PDF user space, from classify.ts) are woven into the flow at their vertical
 * position, so illustrations land between the paragraphs they sat between on the
 * page rather than being dropped. Pass an already-filtered list (drop hairlines
 * / full-page backgrounds) — this only orders and slots them.
 */
export function reconstructPage(pt: PageText, imageRects: Rect[] = []): Block[] {
  return reconstructPageScored(pt, imageRects).blocks
}

/**
 * reconstructPage plus a trust score. Reflow heuristics fail silently — a
 * two-column page interleaves, a table reads as word soup — and one mangled
 * paragraph costs all trust in Text Mode. The score lets the reader fall back
 * to the recolored page image instead of showing prose it can't stand behind.
 */
export function reconstructPageScored(
  pt: PageText,
  imageRects: Rect[] = [],
): { blocks: Block[]; quality: ReflowQuality } {
  const asImages = (): Block[] =>
    imageRects
      .slice()
      .sort((a, b) => b.y + b.h - (a.y + a.h))
      .map((rect) => ({ kind: 'img', rect }) as ImageBlock)
  const lines = toLines(pt.runs)
  if (!lines.length) {
    // No text to reflow, but there may still be images to show (a bare divider).
    return { blocks: asImages(), quality: { confidence: 1, flags: [] } }
  }

  const bodySize = median(lines.flatMap((l) => Array(Math.max(1, l.text.length)).fill(l.size)))
  // The true left margin: a low percentile of line starts, so it lands on the
  // margin (where wrapped lines begin) even when many first lines are indented.
  const xs = lines.map((l) => l.x0).sort((a, b) => a - b)
  const leftMargin = xs[Math.floor(xs.length * 0.2)]
  const rightEdge = Math.max(...lines.map((l) => l.x1))
  const textWidth = rightEdge - leftMargin
  const topY = Math.max(...lines.map((l) => l.y))
  const bottomY = Math.min(...lines.map((l) => l.y))
  const span = Math.max(1, topY - bottomY)

  // Drop running headers / footers / page numbers: short lines hugging the top
  // or bottom margin, or a bare page number anywhere near an edge. But KEEP a
  // bracketed chapter marker like "[ 1 ]" (DCC) — those sit near the top and
  // would otherwise be stripped, losing the chapter break.
  const body = lines.filter((l) => {
    const nearEdge = l.y > topY - span * 0.06 || l.y < bottomY + span * 0.06
    if (!nearEdge) return true
    // Display-size type near an edge is a chapter TITLE, not furniture: running
    // headers are set at or below body size, chapter openers well above it.
    // (Ender's Game sets "2 / Peter" at 24pt on a 10pt body, flush at the top
    // margin — the edge filter was eating the whole chapter heading.) Same
    // ratio as the heading classifier below, so what we keep, we style.
    // Watermark stamps are the exception: "OceanofPDF.com" is also set big
    // near an edge, but a URL is never a chapter title.
    if (l.size > bodySize * 1.25 && !URLISH.test(l.text)) return true
    if (BRACKET_MARKER.test(l.text.trim())) return true
    const short = l.x1 - l.x0 < textWidth * 0.5
    const pageNumberish = /^[\divxlc]+$|^\d+\s*$/i.test(l.text)
    return !(short || pageNumberish)
  })
  if (!body.length) {
    return { blocks: asImages(), quality: { confidence: 1, flags: [] } }
  }

  // The book's normal line spacing, so paragraph breaks can be judged relative
  // to it (some books separate paragraphs by a small extra gap, some by indent,
  // some by both) rather than by fixed thresholds that fit one book and split
  // or merge another.
  const gaps: number[] = []
  for (let i = 1; i < body.length; i++) {
    const g = body[i - 1].y - body[i].y
    if (g > 0) gaps.push(g)
  }
  const lineGap = median(gaps) || bodySize * 1.2

  const blocks: Block[] = []
  let para: Line[] = []
  // Trust tallies. Interior lines (every merged line except a paragraph's last)
  // should run the full measure in real prose; short ones mean the joins are
  // inventing paragraphs out of verse, lists, or dialogue transcripts.
  let interiorJoins = 0
  let shortInteriorJoins = 0
  // Lines that landed in paragraphs: how many start deep into the measure
  // (column two of a two-column page) or contain a wide interior gap (a table
  // row read left-to-right across its cells).
  let paraLines = 0
  let rightStarts = 0
  let gappyLines = 0
  let leaderLines = 0
  const pushPara = () => {
    if (!para.length) return
    for (let i = 0; i < para.length - 1; i++) {
      interiorJoins++
      if (para[i].x1 - para[i].x0 < textWidth * 0.55) shortInteriorJoins++
    }
    const spans: Span[] = []
    let plain = ''
    for (let i = 0; i < para.length; i++) {
      const line = para[i]
      if (i === 0) {
        plain = line.text
      } else if (/[A-Za-z]-$/.test(plain) && /^[a-z]/.test(line.text)) {
        // de-hyphenate a word split across lines: drop the trailing hyphen, no space
        const last = spans[spans.length - 1]
        if (last) last.text = last.text.replace(/-\s*$/, '')
        plain = plain.replace(/-\s*$/, '') + line.text
      } else {
        const last = spans[spans.length - 1]
        if (last && !/\s$/.test(last.text)) last.text += ' '
        plain = plain + ' ' + line.text
      }
      for (const sg of line.segs) pushSpan(spans, sg.text, sg.b, sg.i)
    }
    const trimmed = spans.filter((s) => s.text.length > 0)
    blocks.push({
      kind: 'p',
      spans: trimmed,
      openEnd: para[para.length - 1].x1 > rightEdge - bodySize * 2 && !SENTENCE_END.test(plain),
      openStart: /^[a-z]/.test(plain),
    })
    para = []
  }

  // Illustrations woven in by vertical position: order top-to-bottom by centre
  // and emit each just before the first text line that sits below it, flushing
  // the current paragraph so the image interrupts the flow where it did on page.
  const imgs = imageRects
    .map((rect) => ({ rect, cy: rect.y + rect.h / 2 }))
    .sort((a, b) => b.cy - a.cy)
  let imgAt = 0
  const emitImagesAbove = (y: number) => {
    while (imgAt < imgs.length && imgs[imgAt].cy >= y) {
      pushPara()
      blocks.push({ kind: 'img', rect: imgs[imgAt].rect })
      imgAt++
    }
  }

  const pushSep = () => {
    pushPara()
    if (blocks[blocks.length - 1]?.kind !== 'sep') blocks.push({ kind: 'sep' })
  }
  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    emitImagesAbove(line.y)
    // A line of pure break glyphs ("* * *", "···") is a scene break, not prose.
    if (line.x1 - line.x0 < textWidth * 0.4 && SCENE_BREAK.test(line.text)) {
      pushSep()
      continue
    }
    const heading =
      (line.size > bodySize * 1.25 && !URLISH.test(line.text)) ||
      (line.text.length <= 24 && CHAPTER_MARKER.test(line.text.trim()))
    if (heading) {
      pushPara()
      blocks.push({ kind: 'h', spans: line.segs.map((s) => ({ ...s })) })
      continue
    }
    if (i > 0 && para.length) {
      const prev = body[i - 1]
      const gap = prev.y - line.y // downward gap between baselines
      // Break on a gap clearly bigger than the book's own line spacing, or an
      // indented first line — relative to the book's own metrics, so one rule
      // fits both indent-only and spaced-paragraph books without splitting
      // wrapped lines or merging paragraphs.
      const bigGap = gap > lineGap * 1.5 && gap > line.size * 1.1
      const indented = line.x0 - leftMargin > bodySize * 0.5
      if (bigGap || indented) pushPara()
    }
    paraLines++
    if (line.x0 > leftMargin + textWidth * 0.4) rightStarts++
    if (line.maxGap > 3) gappyLines++
    if (/([.…]\s?){6,}/.test(line.text)) leaderLines++
    para.push(line)
  }
  pushPara()
  // Any images sitting below all the text (e.g. a footer illustration).
  while (imgAt < imgs.length) {
    blocks.push({ kind: 'img', rect: imgs[imgAt].rect })
    imgAt++
  }

  // Score the reconstruction. Each detector targets a specific way reflow
  // produces confident-looking garbage; penalties scale with how much of the
  // page misbehaves, and small samples don't judge (a 3-line page proves
  // nothing). Thresholds tuned against the corpus in scripts/verify.
  const flags: string[] = []
  let confidence = 1
  const rightFrac = paraLines ? rightStarts / paraLines : 0
  if (paraLines >= 8 && rightFrac > 0.25) {
    flags.push('columns')
    confidence -= 0.4 + rightFrac * 0.4
  }
  const gappyFrac = paraLines ? gappyLines / paraLines : 0
  if (paraLines >= 6 && gappyFrac > 0.15) {
    flags.push('table')
    confidence -= 0.3 + gappyFrac * 0.5
  }
  // Dot-leader lines (a TOC, an index) reflow into dot soup. The words come
  // out in the right order — a text diff can't see this one — but the page
  // reads far better as its image.
  const leaderFrac = paraLines ? leaderLines / paraLines : 0
  if (paraLines >= 4 && leaderFrac > 0.25) {
    flags.push('leaders')
    confidence -= 0.4 + leaderFrac * 0.3
  }
  const raggedFrac = interiorJoins ? shortInteriorJoins / interiorJoins : 0
  if (interiorJoins >= 5 && raggedFrac > 0.3) {
    flags.push('ragged-joins')
    confidence -= 0.2 + raggedFrac * 0.4
  }
  const allChars = lines.reduce((n, l) => n + l.text.length, 0)
  const bodyChars = body.reduce((n, l) => n + l.text.length, 0)
  const coverage = allChars ? bodyChars / allChars : 1
  if (allChars > 200 && coverage < 0.5) {
    flags.push('dropped-text')
    confidence -= 0.5 - coverage
  }
  return {
    blocks,
    quality: { confidence: Math.max(0, Math.min(1, confidence)), flags },
  }
}

/** Join a paragraph split across a page boundary (last of A into first of B). */
export function stitch(a: Block[], b: Block[]): void {
  const tail = a[a.length - 1]
  const head = b[0]
  // A scene break at a page bottom meeting one at the next page's top is the
  // same break twice; keep one.
  if (tail?.kind === 'sep' && head?.kind === 'sep') {
    b.shift()
    return
  }
  if (tail?.kind !== 'p' || !tail.openEnd || head?.kind !== 'p' || !head.openStart) return
  if (/[A-Za-z]-$/.test(spansText(tail.spans)) && /^[a-z]/.test(spansText(head.spans))) {
    const last = tail.spans[tail.spans.length - 1]
    if (last) last.text = last.text.replace(/-\s*$/, '')
  } else {
    const last = tail.spans[tail.spans.length - 1]
    if (last && !/\s$/.test(last.text)) last.text += ' '
  }
  for (const sg of head.spans) pushSpan(tail.spans, sg.text, sg.b, sg.i)
  tail.openEnd = head.openEnd
  b.shift()
}
