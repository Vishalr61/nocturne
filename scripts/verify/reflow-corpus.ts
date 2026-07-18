// Reflow verification corpus — the regression net under Text Mode trust.
//
// Reflow is a stack of heuristics, and heuristics fail silently: a tweak that
// fixes one book can quietly mangle another. This harness reflows the corpus
// books with the real engine (src/engine/reflow.ts, imported directly — it is
// framework-free by design) and compares the text that comes out against
// PyMuPDF ground truth, page by page. Scores are compared to a committed
// baseline; a drop fails the run. No book text is ever written to the repo —
// only similarity numbers.
//
//   npx tsx scripts/verify/reflow-corpus.ts                  # compare to baseline
//   npx tsx scripts/verify/reflow-corpus.ts --write-baseline # accept current scores
//
// Similarity metric: Dice coefficient over word bigrams. Order-sensitive
// enough to catch interleaved columns (bigrams break at every join) and
// dropped paragraphs, cheap enough to run over every page of four books.
// Expected values sit below 1.0 even when reflow is perfect: reflow drops
// running headers and page numbers on purpose, and heals hyphenation the
// ground truth keeps. The baseline captures that offset; regressions show as
// deltas from it.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPageText, type TextCache } from '../../src/engine/search'
import { reconstructPageScored, spansText } from '../../src/engine/reflow'

const HOME = homedir()
const PYTHON = join(HOME, 'patchpdf/backend/.venv/bin/python')
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'reflow-baseline.json')

/** stride: score every Nth page — Sybex is 1700+ pages of mostly tables. */
const CORPUS: { name: string; path: string; stride: number }[] = [
  { name: 'dcc', path: join(HOME, 'Documents/Hobby/Books/DCC/DungeonCrawlerCarl.pdf'), stride: 1 },
  { name: 'red-rising', path: join(HOME, 'Documents/Hobby/Books/Red Rising/red-rising.pdf'), stride: 1 },
  { name: 'enders-game', path: join(HOME, 'Documents/Hobby/Books/enders_game_-_full_novel.pdf'), stride: 1 },
  { name: 'sybex', path: join(HOME, 'Documents/CompTIA/SybexCompTIA.pdf'), stride: 5 },
]

interface BookScore {
  pages: number
  /** Median bigram-dice similarity of confident pages vs ground truth. */
  medianSim: number
  /** 10th percentile — the tail is where mangling hides. */
  p10Sim: number
  /** Confident pages scoring under 0.6 — likely-mangled prose shown as text. */
  lowPages: number
  /** Pages the engine itself declined (confidence < 0.5 → image fallback). */
  fallbackPages: number
}

function normalizeWords(s: string): string[] {
  return s
    .normalize('NFKC')
    .replace(/­/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function bigramDice(a: string[], b: string[]): number {
  if (a.length < 2 && b.length < 2) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a[i] + ' ' + a[i + 1]
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let hit = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b[i] + ' ' + b[i + 1]
    const n = grams.get(g) ?? 0
    if (n > 0) {
      hit++
      grams.set(g, n - 1)
    }
  }
  return (2 * hit) / (a.length - 1 + (b.length - 1))
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

/** Ground truth: PyMuPDF's per-page plain text, via the patchpdf venv. */
function groundTruth(pdfPath: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'reflow-gt-'))
  const out = join(dir, 'gt.json')
  try {
    execFileSync(PYTHON, [
      '-c',
      'import fitz, json, sys\n' +
        'doc = fitz.open(sys.argv[1])\n' +
        'json.dump([p.get_text() for p in doc], open(sys.argv[2], "w"))',
      pdfPath,
      out,
    ])
    return JSON.parse(readFileSync(out, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function scoreBook(path: string, stride: number): Promise<BookScore> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const truth = groundTruth(path)
  const data = new Uint8Array(readFileSync(path))
  const doc = await getDocument({ data, disableFontFace: true, verbosity: 0 }).promise
  const cache: TextCache = new Map()
  const sims: number[] = []
  let lowPages = 0
  let fallbackPages = 0
  let scored = 0
  for (let p = 1; p <= doc.numPages; p += stride) {
    const page = await doc.getPage(p)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pt = await getPageText(page as any, cache)
    const { blocks, quality } = reconstructPageScored(pt)
    cache.delete(p) // keep memory flat across 1700-page books
    const text = blocks
      .map((b) => (b.kind === 'p' || b.kind === 'h' ? spansText(b.spans) : ''))
      .join(' ')
    const truthWords = normalizeWords(truth[p - 1] ?? '')
    if (truthWords.length < 20) continue // covers, blanks: nothing to judge
    scored++
    if (quality.confidence < 0.5) {
      fallbackPages++ // the app shows these as the page image — honest, not wrong
      continue
    }
    const sim = bigramDice(truthWords, normalizeWords(text))
    sims.push(sim)
    if (sim < 0.6) lowPages++
  }
  await doc.destroy()
  return {
    pages: scored,
    medianSim: Number(median(sims).toFixed(4)),
    p10Sim: Number((sims.length ? [...sims].sort((a, b) => a - b)[Math.floor(sims.length * 0.1)] : 0).toFixed(4)),
    lowPages,
    fallbackPages,
  }
}

const writeBaseline = process.argv.includes('--write-baseline')

const results: Record<string, BookScore> = {}
let failed = false
for (const book of CORPUS) {
  if (!existsSync(book.path)) {
    console.log(`~ ${book.name}: missing (${book.path}) — skipped`)
    continue
  }
  const t0 = Date.now()
  results[book.name] = await scoreBook(book.path, book.stride)
  const r = results[book.name]
  console.log(
    `  ${book.name}: ${r.pages} pages scored · median ${r.medianSim} · p10 ${r.p10Sim} · ` +
      `${r.lowPages} low · ${r.fallbackPages} image-fallback · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  )
}

if (writeBaseline) {
  writeFileSync(BASELINE, JSON.stringify(results, null, 2) + '\n')
  console.log(`Baseline written to ${BASELINE}`)
} else if (existsSync(BASELINE)) {
  const base: Record<string, BookScore> = JSON.parse(readFileSync(BASELINE, 'utf8'))
  for (const [name, r] of Object.entries(results)) {
    const b = base[name]
    if (!b) continue
    const problems: string[] = []
    if (r.medianSim < b.medianSim - 0.02) problems.push(`median ${b.medianSim} → ${r.medianSim}`)
    if (r.p10Sim < b.p10Sim - 0.03) problems.push(`p10 ${b.p10Sim} → ${r.p10Sim}`)
    if (r.lowPages > b.lowPages + Math.max(2, b.lowPages * 0.2))
      problems.push(`low pages ${b.lowPages} → ${r.lowPages}`)
    if (r.fallbackPages > b.fallbackPages + Math.max(2, b.fallbackPages * 0.2))
      problems.push(`fallbacks ${b.fallbackPages} → ${r.fallbackPages}`)
    if (problems.length) {
      failed = true
      console.error(`✗ ${name} regressed: ${problems.join(' · ')}`)
    } else {
      console.log(`✓ ${name} holds the baseline`)
    }
  }
} else {
  console.log('No baseline yet — run with --write-baseline to create one.')
}

process.exit(failed ? 1 : 0)
