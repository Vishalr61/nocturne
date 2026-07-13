import { zipSync, strToU8 } from 'fflate'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { getPageText, type TextCache } from '../engine/search'
import { classifyPage } from '../engine/classify'
import { renderPageToCanvas } from '../engine/pdf'
import {
  reconstructPage,
  stitch,
  spansText,
  type Block,
  type ImageBlock,
  type Span,
} from '../engine/reflow'

// EPUB export — "free the book". Text Mode already reconstructs real
// paragraphs from the PDF's text layer (engine/reflow.ts); written out as
// EPUB, a prose book becomes reflowable in every reader app there is. Only
// honest for digital prose: scans have no text layer, and page-sized figure
// layouts still belong to the PDF exports.
//
// The book ships in YOUR reading setup: the Text Mode face is embedded (WOFF,
// the widest e-reader support) and line spacing / justification / paragraph
// style become the stylesheet defaults — so the export opens looking like the
// app, not like the destination reader's defaults. Readers can still override,
// as EPUB readers always can.
//
// Inline illustrations survive: the same declared-image blocks Text Mode
// weaves into its flow (a chapter-divider icon, an inline figure) are cropped
// out of the ORIGINAL page render and embedded as JPEGs. Original colours,
// deliberately — an EPUB is theme-agnostic, the destination reader styles it.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function spanHtml(spans: Span[]): string {
  return spans
    .map((s) => {
      let t = esc(s.text)
      if (s.i) t = `<em>${t}</em>`
      if (s.b) t = `<strong>${t}</strong>`
      return t
    })
    .join('')
}

// ---- typography -------------------------------------------------------------

/** The Text Mode typography carried into the EPUB's stylesheet. */
export interface EpubTypography {
  /** TEXT_FONTS id — selects which bundled faces to embed. */
  fontId: string
  /** Family name for @font-face rules (e.g. 'Lora'). */
  fontName: string
  /** Full CSS fallback stack from TEXT_FONTS. */
  stack: string
  leading: number
  justify: boolean
  para: 'indent' | 'spaced'
}

type FaceKey = 'regular' | 'italic' | 'bold' | 'boldItalic'

// Lazy URL imports of the app's self-hosted reading faces — resolved and
// fetched only at export time, so they cost nothing until then. Each family's
// heavier cut (600/700) is declared as CSS `bold` so <strong> lands on it.
const FONT_FILES: Record<string, Record<FaceKey, () => Promise<{ default: string }>>> = {
  lora: {
    regular: () => import('@fontsource/lora/files/lora-latin-400-normal.woff'),
    italic: () => import('@fontsource/lora/files/lora-latin-400-italic.woff'),
    bold: () => import('@fontsource/lora/files/lora-latin-600-normal.woff'),
    boldItalic: () => import('@fontsource/lora/files/lora-latin-600-italic.woff'),
  },
  literata: {
    regular: () => import('@fontsource/literata/files/literata-latin-400-normal.woff'),
    italic: () => import('@fontsource/literata/files/literata-latin-400-italic.woff'),
    bold: () => import('@fontsource/literata/files/literata-latin-600-normal.woff'),
    boldItalic: () => import('@fontsource/literata/files/literata-latin-600-italic.woff'),
  },
  merriweather: {
    regular: () => import('@fontsource/merriweather/files/merriweather-latin-400-normal.woff'),
    italic: () => import('@fontsource/merriweather/files/merriweather-latin-400-italic.woff'),
    bold: () => import('@fontsource/merriweather/files/merriweather-latin-600-normal.woff'),
    boldItalic: () => import('@fontsource/merriweather/files/merriweather-latin-600-italic.woff'),
  },
  inter: {
    regular: () => import('@fontsource/inter/files/inter-latin-400-normal.woff'),
    italic: () => import('@fontsource/inter/files/inter-latin-400-italic.woff'),
    bold: () => import('@fontsource/inter/files/inter-latin-600-normal.woff'),
    boldItalic: () => import('@fontsource/inter/files/inter-latin-600-italic.woff'),
  },
  atkinson: {
    regular: () =>
      import('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff'),
    italic: () =>
      import('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-italic.woff'),
    bold: () =>
      import('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff'),
    boldItalic: () =>
      import('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-italic.woff'),
  },
  dyslexic: {
    regular: () => import('@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff'),
    italic: () => import('@fontsource/opendyslexic/files/opendyslexic-latin-400-italic.woff'),
    bold: () => import('@fontsource/opendyslexic/files/opendyslexic-latin-700-normal.woff'),
    boldItalic: () => import('@fontsource/opendyslexic/files/opendyslexic-latin-700-italic.woff'),
  },
}

interface EmbeddedFace {
  file: string // filename inside OEBPS/fonts/
  data: Uint8Array
  weight: 'normal' | 'bold'
  style: 'normal' | 'italic'
}

async function loadFontFaces(fontId: string): Promise<EmbeddedFace[]> {
  const files = FONT_FILES[fontId]
  if (!files) return []
  const specs: [FaceKey, EmbeddedFace['weight'], EmbeddedFace['style']][] = [
    ['regular', 'normal', 'normal'],
    ['italic', 'normal', 'italic'],
    ['bold', 'bold', 'normal'],
    ['boldItalic', 'bold', 'italic'],
  ]
  const faces: EmbeddedFace[] = []
  for (const [key, weight, style] of specs) {
    const url = (await files[key]()).default
    const res = await fetch(url)
    if (!res.ok) throw new Error(`font fetch failed: ${url}`)
    faces.push({
      file: `${key === 'boldItalic' ? 'bold-italic' : key}.woff`,
      data: new Uint8Array(await res.arrayBuffer()),
      weight,
      style,
    })
  }
  return faces
}

const FIG_CSS = '.fig { margin: 1em 0; text-align: center; } .fig img { max-width: 100%; }'

function styleCss(style: EpubTypography | undefined, faces: EmbeddedFace[]): string {
  if (!style) {
    // No typography passed: the plain, reader-controlled stylesheet.
    return `body { line-height: 1.5; } h2 { page-break-before: always; }
p { margin: 0 0 0.6em; text-indent: 0; }
${FIG_CSS}`
  }
  const fontFaces = faces
    .map(
      (f) =>
        `@font-face { font-family: '${style.fontName}'; font-weight: ${f.weight}; ` +
        `font-style: ${f.style}; src: url('fonts/${f.file}') format('woff'); }`,
    )
    .join('\n')
  const para =
    style.para === 'spaced'
      ? 'p { margin: 0 0 0.9em; text-indent: 0; }'
      : 'p { margin: 0; text-indent: 1.3em; }\nh2 + p { text-indent: 0; }'
  const justify = style.justify
    ? '\np { text-align: justify; -webkit-hyphens: auto; hyphens: auto; }'
    : ''
  return `${fontFaces}
body { font-family: ${style.stack}; line-height: ${style.leading}; }
h2 { page-break-before: always; }
${para}${justify}
${FIG_CSS}`
}

// Apple Books ignores publisher fonts unless this switch is present.
const APPLE_DISPLAY_OPTIONS = `<?xml version="1.0" encoding="UTF-8"?>
<display_options>
  <platform name="*">
    <option name="specified-fonts">true</option>
  </platform>
</display_options>`

// ---- inline illustrations ---------------------------------------------------

interface EpubImage {
  file: string // filename inside OEBPS/images/
  wf: number // width as a fraction of the source page width
}

function canvasJpeg(c: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob(
      async (b) => {
        if (!b) return reject(new Error('image-encode-failed'))
        resolve(new Uint8Array(await b.arrayBuffer()))
      },
      'image/jpeg',
      quality,
    )
  })
}

// ---- cover ------------------------------------------------------------------

/**
 * The book's cover for the EPUB: page 1's art when the book has a real cover
 * page, otherwise a generated title card (dark ground, serif title) so the
 * export never lands in a library grid as a blank tile.
 */
async function makeCover(doc: PDFDocumentProxy, title: string): Promise<Uint8Array> {
  const page = await doc.getPage(1)
  const vp = page.getViewport({ scale: 1 })
  const cls = await classifyPage(page)
  const coverIsArt = cls.imageRects.some(
    (r) => (r.w * r.h) / (vp.width * vp.height) > 0.45,
  )
  if (coverIsArt) {
    const canvas = await renderPageToCanvas(page, Math.max(1, 1200 / vp.width), 1)
    return canvasJpeg(canvas, 0.85)
  }

  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 1800
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#15110b'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.textAlign = 'center'
  ctx.fillStyle = '#c9a56a'
  ctx.font = '160px Georgia, serif'
  ctx.fillText('☾', 600, 560)
  // Wrap the title into short centred lines.
  ctx.font = '600 92px Lora, Georgia, serif'
  ctx.fillStyle = '#f3e8d3'
  const words = (title || 'Untitled').split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 18 && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = (cur + ' ' + w).trim()
    }
  }
  if (cur) lines.push(cur)
  lines.slice(0, 6).forEach((l, i) => ctx.fillText(l, 600, 800 + i * 120))
  ctx.font = '44px Inter, sans-serif'
  ctx.fillStyle = '#9a875f'
  ctx.fillText('N O C T U R N E', 600, 1680)
  return canvasJpeg(c, 0.85)
}

// ---- book assembly ----------------------------------------------------------

interface Chapter {
  title: string
  blocks: Block[]
  /** Title came from the PDF outline; synthesize an <h2> if the body lacks one. */
  labelled?: boolean
}

/** An outline entry as the reader's Contents panel already resolves them. */
export interface OutlineEntry {
  title: string
  page: number
  depth?: number
}

/**
 * Chapters cut at the PDF's own outline destinations — the author's TOC beats
 * any heading heuristic. Only trusted when it yields real structure (≥2 cuts
 * inside the range); otherwise the caller falls back to the heuristic.
 */
function chapterizeByOutline(
  all: Block[],
  imgs: Map<Block, EpubImage>,
  pageOf: Map<Block, number>,
  outline: OutlineEntry[],
  from: number,
  to: number,
): Chapter[] {
  const inRange = outline.filter((e) => e.page >= from && e.page <= to)
  const top = inRange.filter((e) => (e.depth ?? 0) === 0)
  const picked = (top.length >= 2 ? top : inRange).slice().sort((a, b) => a.page - b.page)
  // At most one cut per page: same-page entries collapse into the first.
  const cuts = picked.filter((e, i) => i === 0 || e.page !== picked[i - 1].page)
  if (cuts.length < 2) return []

  const chapters: Chapter[] = []
  let cur: Chapter = { title: 'Front matter', blocks: [] }
  chapters.push(cur)
  let at = 0
  for (const b of all) {
    if (b.kind === 'img' && !imgs.has(b)) continue
    const pg = pageOf.get(b) ?? from
    while (at < cuts.length && pg >= cuts[at].page) {
      cur = {
        title: cuts[at].title.trim() || `Chapter ${chapters.length}`,
        blocks: [],
        labelled: true,
      }
      chapters.push(cur)
      at++
    }
    cur.blocks.push(b)
  }
  return chapters.filter((c) =>
    c.blocks.some((b) => b.kind === 'img' || spansText(b.spans).trim()),
  )
}

/** Headings begin chapters; leading blocks before any heading are "front matter".
 *  Image blocks ride along only when a crop was actually captured for them. */
function chapterize(blocks: Block[], imgs: Map<Block, EpubImage>): Chapter[] {
  const chapters: Chapter[] = []
  let cur: Chapter | null = null
  for (const b of blocks) {
    if (b.kind === 'img' && !imgs.has(b)) continue
    if (b.kind === 'h') {
      const title = spansText(b.spans).trim()
      // A chapter often opens with stacked heading lines ("2" then "Peter") —
      // one chapter titled "2 · Peter", not a chapter per line.
      const prevIsBareHeading = cur && cur.blocks.every((x) => x.kind === 'h')
      if (cur && prevIsBareHeading && cur.title !== 'Front matter') {
        cur.title = [cur.title, title].filter(Boolean).join(' · ')
        cur.blocks.push(b)
      } else {
        cur = { title: title || `Chapter ${chapters.length + 1}`, blocks: [b] }
        chapters.push(cur)
      }
    } else {
      if (!cur) {
        cur = { title: 'Front matter', blocks: [] }
        chapters.push(cur)
      }
      cur.blocks.push(b)
    }
  }
  return chapters.filter((c) =>
    c.blocks.some((b) => b.kind === 'img' || spansText(b.spans).trim()),
  )
}

function chapterXhtml(c: Chapter, imgs: Map<Block, EpubImage>): string {
  // An outline-titled chapter whose page never set a display-size heading
  // still deserves one — that's how publisher EPUBs read.
  const lead = c.labelled && c.blocks[0]?.kind !== 'h' ? [`<h2>${esc(c.title)}</h2>`] : []
  const body = lead
    .concat(
      c.blocks.map((b) => {
        if (b.kind === 'img') {
          const im = imgs.get(b)!
          // Sized like Text Mode shows it: relative to the page width, floored
          // so a small divider icon doesn't vanish at e-reader column widths.
          const pct = Math.max(25, Math.min(100, Math.round(im.wf * 100)))
          return `<div class="fig"><img src="images/${im.file}" style="width:${pct}%" alt=""/></div>`
        }
        return b.kind === 'h' ? `<h2>${spanHtml(b.spans)}</h2>` : `<p>${spanHtml(b.spans)}</p>`
      }),
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${esc(c.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>
${body}
</body>
</html>`
}

export async function exportEpub(
  doc: PDFDocumentProxy,
  opts: {
    title: string
    textCache: TextCache
    /** Inclusive 1-based page range; defaults to the whole book. */
    from?: number
    to?: number
    /** Text Mode typography — embedded font + stylesheet defaults. */
    style?: EpubTypography
    /** The PDF's resolved outline; when present, chapters cut at its pages. */
    outline?: OutlineEntry[]
    onProgress?: (done: number, total: number) => void
  },
): Promise<Blob> {
  const from = Math.max(1, opts.from ?? 1)
  const to = Math.min(doc.numPages, opts.to ?? doc.numPages)
  const total = Math.max(1, to - from + 1)

  // Reconstruct the range's prose, joining paragraphs across pages; keep the
  // inline illustrations Text Mode keeps (same filter: not hairlines, not
  // full-page backgrounds, big enough to read as a picture).
  const all: Block[] = []
  const imgMap = new Map<Block, EpubImage>()
  const imageFiles: { file: string; data: Uint8Array }[] = []
  const pageOf = new Map<Block, number>() // for outline chapter cuts
  for (let p = from; p <= to; p++) {
    opts.onProgress?.(p - from, total)
    const page = await doc.getPage(p)
    const cls = await classifyPage(page)
    const view = page.view // [x0, y0, x1, y1], PDF user space, y up
    const viewW = view[2] - view[0]
    const viewH = view[3] - view[1]
    const pageArea = Math.max(1, viewW * viewH)
    const inlineRects = cls.imageRects.filter((r) => {
      const areaFrac = (r.w * r.h) / pageArea
      return areaFrac >= 0.004 && areaFrac <= 0.85 && Math.min(r.w, r.h) > viewH * 0.02
    })
    const pt = await getPageText(page, opts.textCache, true)
    const blocks = reconstructPage(pt, inlineRects)

    const imgBlocks = blocks.filter((b): b is ImageBlock => b.kind === 'img')
    if (imgBlocks.length) {
      // One original-colour render of the page, then crop each block out. The
      // scale rises for pages whose smallest figure is tiny (a chapter-divider
      // icon), so crops don't turn soft when the e-reader scales them up.
      const vp = page.getViewport({ scale: 1 })
      const minSide = Math.min(...imgBlocks.map((b) => Math.min(b.rect.w, b.rect.h)))
      const scale = Math.min(4, Math.max(1400 / vp.width, 300 / Math.max(1, minSide)))
      const canvas = await renderPageToCanvas(page, scale, 1)
      for (const b of imgBlocks) {
        const r = b.rect
        // PDF user space (y up) -> canvas pixels (y down); canvas is the full page.
        const sx = ((r.x - view[0]) / viewW) * canvas.width
        const sy = ((view[3] - (r.y + r.h)) / viewH) * canvas.height
        const sw = (r.w / viewW) * canvas.width
        const sh = (r.h / viewH) * canvas.height
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(sw))
        c.height = Math.max(1, Math.round(sh))
        c.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height)
        try {
          const data = await canvasJpeg(c, 0.9)
          const file = `img${imageFiles.length}.jpg`
          imageFiles.push({ file, data })
          imgMap.set(b, { file, wf: r.w / viewW })
        } catch {
          /* unencodable crop: drop the figure, keep the prose */
        }
      }
    }

    stitch(all, blocks) // may absorb blocks[0] into the previous page's tail
    for (const b of blocks) pageOf.set(b, p)
    all.push(...blocks)
    if (p % 10 === 0) await new Promise((r) => setTimeout(r, 0)) // let the UI breathe
  }

  const byOutline = opts.outline?.length
    ? chapterizeByOutline(all, imgMap, pageOf, opts.outline, from, to)
    : []
  const chapters = byOutline.length ? byOutline : chapterize(all, imgMap)
  const totalChars = all.reduce(
    (n, b) => n + (b.kind === 'img' ? 0 : spansText(b.spans).length),
    0,
  )
  if (totalChars < 500) {
    throw new Error('This book has no usable text layer (a scan needs OCR first).')
  }

  // Embed the reading font; a fetch failure degrades to the CSS stack alone
  // (destination fallbacks) rather than failing the export.
  let faces: EmbeddedFace[] = []
  if (opts.style) {
    try {
      faces = await loadFontFaces(opts.style.fontId)
    } catch {
      faces = []
    }
  }

  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-nocturne`

  // Cover: page-1 art or a generated title card. Optional — a render failure
  // costs the cover, never the book.
  let cover: Uint8Array | null = null
  try {
    cover = await makeCover(doc, opts.title)
  } catch {
    cover = null
  }

  const manifest = [
    ...(cover
      ? [
          `<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`,
          `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
        ]
      : []),
    ...chapters.map(
      (_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`,
    ),
    ...faces.map(
      (f, i) => `<item id="font${i}" href="fonts/${f.file}" media-type="font/woff"/>`,
    ),
    ...imageFiles.map(
      (f, i) => `<item id="img${i}" href="images/${f.file}" media-type="image/jpeg"/>`,
    ),
  ].join('\n  ')
  const spine =
    (cover ? '<itemref idref="cover"/>' : '') +
    chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')
  const navList = chapters
    .map((c, i) => `<li><a href="c${i}.xhtml">${esc(c.title)}</a></li>`)
    .join('\n      ')

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
  <dc:title>${esc(opts.title || 'Untitled')}</dc:title>
  <dc:language>en</dc:language>
  <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  ${cover ? '<meta name="cover" content="cover-img"/>' : ''}
 </metadata>
 <manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="css" href="style.css" media-type="text/css"/>
  ${manifest}
 </manifest>
 <spine>${spine}</spine>
</package>`

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc"><h1>Contents</h1>
    <ol>
      ${navList}
    </ol>
  </nav>
</body>
</html>`

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    // Spec: `mimetype` must be first and stored uncompressed.
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/style.css': strToU8(styleCss(opts.style, faces)),
  }
  if (faces.length) {
    files['META-INF/com.apple.ibooks.display-options.xml'] = strToU8(APPLE_DISPLAY_OPTIONS)
    for (const f of faces) {
      // WOFF is already compressed; storing it beats deflating it again.
      files[`OEBPS/fonts/${f.file}`] = [f.data, { level: 0 }]
    }
  }
  for (const f of imageFiles) {
    files[`OEBPS/images/${f.file}`] = [f.data, { level: 0 }] // JPEG: same story
  }
  if (cover) {
    files['OEBPS/cover.jpg'] = [cover, { level: 0 }]
    files['OEBPS/cover.xhtml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body style="margin:0;text-align:center">
  <img src="cover.jpg" alt="Cover" style="max-width:100%;max-height:100%"/>
</body>
</html>`)
  }
  chapters.forEach((c, i) => {
    files[`OEBPS/c${i}.xhtml`] = strToU8(chapterXhtml(c, imgMap))
  })

  opts.onProgress?.(total, total)
  const zipped = zipSync(files)
  const buf = new Uint8Array(zipped.length)
  buf.set(zipped)
  return new Blob([buf], { type: 'application/epub+zip' })
}
