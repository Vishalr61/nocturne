import type { PageText, Run } from './search'

// Text Mode's hard half: turn pdf.js's loose positioned text runs back into
// paragraphs. pdf.js gives you fragments with (x, y, size) in PDF text space
// (y increases upward) and no notion of paragraphs, headings, columns, or which
// bits are running headers/page numbers. This reconstructs a readable block
// list — headings and paragraphs, de-hyphenated — for a single-column prose
// page. It is deliberately conservative: on multi-column or figure-heavy pages
// the result is imperfect (that's what Faithful mode is for), but on a novel it
// reads cleanly.

export interface Block {
  kind: 'h' | 'p'
  text: string
  /** Paragraph likely continues onto the next page (join when stitching). */
  openEnd?: boolean
  /** Paragraph likely continues from the previous page. */
  openStart?: boolean
}

interface Line {
  text: string
  x0: number
  x1: number
  y: number
  size: number
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
    let text = ''
    let prevRight = -Infinity
    for (const r of ordered) {
      const gap = runX(r) - prevRight
      // Insert a space when there's a visible gap and neither side already has
      // one. The threshold is a fraction of the font size (roughly a space
      // width); too high drops spaces between words ("notmine"), too low splits
      // words, so this is tuned low-ish.
      if (text && gap > runSize(r) * 0.16 && !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' '
      text += r.str
      prevRight = runX(r) + r.width
    }
    const x0 = Math.min(...ordered.map(runX))
    const x1 = Math.max(...ordered.map((r) => runX(r) + r.width))
    const size = Math.max(...ordered.map(runSize))
    lines.push({ text: text.replace(/\s+/g, ' ').trim(), x0, x1, y: curY, size })
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

/** Reconstruct readable blocks from one page's extracted text. */
export function reconstructPage(pt: PageText): Block[] {
  const lines = toLines(pt.runs)
  if (!lines.length) return []

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
  // or bottom margin, or a bare page number anywhere near an edge.
  const body = lines.filter((l) => {
    const nearEdge = l.y > topY - span * 0.06 || l.y < bottomY + span * 0.06
    if (!nearEdge) return true
    const short = l.x1 - l.x0 < textWidth * 0.5
    const pageNumberish = /^[\divxlc]+$|^\d+\s*$/i.test(l.text)
    return !(short || pageNumberish)
  })
  if (!body.length) return []

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
  const pushPara = () => {
    if (!para.length) return
    let text = ''
    for (let i = 0; i < para.length; i++) {
      const t = para[i].text
      if (i === 0) {
        text = t
      } else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(t)) {
        text = text.slice(0, -1) + t // de-hyphenate a word split across lines
      } else {
        text += ' ' + t
      }
    }
    const last = para[para.length - 1]
    const first = para[0]
    blocks.push({
      kind: 'p',
      text: text.trim(),
      openEnd: last.x1 > rightEdge - bodySize * 2 && !SENTENCE_END.test(text),
      openStart: /^[a-z]/.test(first.text),
    })
    para = []
  }

  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    const heading = line.size > bodySize * 1.25
    if (heading) {
      pushPara()
      blocks.push({ kind: 'h', text: line.text })
      continue
    }
    if (i > 0 && para.length) {
      const prev = body[i - 1]
      const gap = prev.y - line.y // downward gap between baselines
      // Break on a gap clearly bigger than the book's own line spacing, or an
      // indented first line. Relative-to-line-spacing (not a fixed size) is what
      // lets one rule fit both an indent-only novel and one that adds a little
      // space between paragraphs, without splitting ordinary wrapped lines.
      const bigGap = gap > lineGap * 1.5 && gap > line.size * 1.1
      // Half an em catches a one-em first-line indent (the common novel marker)
      // without tripping on the tiny x jitter of ordinary wrapped lines.
      const indented = line.x0 - leftMargin > bodySize * 0.5
      if (bigGap || indented) pushPara()
    }
    para.push(line)
  }
  pushPara()
  return blocks
}

/** Join a paragraph split across a page boundary (last of A into first of B). */
export function stitch(a: Block[], b: Block[]): void {
  const tail = a[a.length - 1]
  const head = b[0]
  if (tail?.kind === 'p' && tail.openEnd && head?.kind === 'p' && head.openStart) {
    if (/[A-Za-z]-$/.test(tail.text) && /^[a-z]/.test(head.text)) {
      tail.text = tail.text.slice(0, -1) + head.text
    } else {
      tail.text = tail.text + ' ' + head.text
    }
    tail.openEnd = head.openEnd
    b.shift()
  }
}
