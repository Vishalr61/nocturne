import { zipSync, strToU8 } from 'fflate'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { getPageText, type TextCache } from '../engine/search'
import { reconstructPage, stitch, spansText, type Block, type Span } from '../engine/reflow'

// EPUB export — "free the book". Text Mode already reconstructs real
// paragraphs from the PDF's text layer (engine/reflow.ts); written out as
// EPUB, a prose book becomes reflowable in every reader app there is. Only
// honest for digital prose: scans have no text layer, and figure-heavy
// layouts lose their figures (that's what the PDF exports are for).

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

interface Chapter {
  title: string
  blocks: Block[]
}

/** Headings begin chapters; leading blocks before any heading are "front matter". */
function chapterize(blocks: Block[]): Chapter[] {
  const chapters: Chapter[] = []
  let cur: Chapter | null = null
  for (const b of blocks) {
    if (b.kind === 'h') {
      cur = { title: spansText(b.spans).trim() || `Chapter ${chapters.length + 1}`, blocks: [b] }
      chapters.push(cur)
    } else {
      if (!cur) {
        cur = { title: 'Front matter', blocks: [] }
        chapters.push(cur)
      }
      cur.blocks.push(b)
    }
  }
  return chapters.filter((c) => c.blocks.some((b) => spansText(b.spans).trim()))
}

function chapterXhtml(c: Chapter): string {
  const body = c.blocks
    .map((b) => (b.kind === 'h' ? `<h2>${spanHtml(b.spans)}</h2>` : `<p>${spanHtml(b.spans)}</p>`))
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
    onProgress?: (done: number, total: number) => void
  },
): Promise<Blob> {
  // Reconstruct the whole book's prose, joining paragraphs across pages.
  const all: Block[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    opts.onProgress?.(p - 1, doc.numPages)
    const page = await doc.getPage(p)
    const pt = await getPageText(page, opts.textCache, true)
    const blocks = reconstructPage(pt)
    stitch(all, blocks)
    all.push(...blocks)
    if (p % 10 === 0) await new Promise((r) => setTimeout(r, 0)) // let the UI breathe
  }

  const chapters = chapterize(all)
  const totalChars = all.reduce((n, b) => n + spansText(b.spans).length, 0)
  if (totalChars < 500) {
    throw new Error('This book has no usable text layer (a scan needs OCR first).')
  }

  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-nocturne`

  const manifest = chapters
    .map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n  ')
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')
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

  const css = `body { line-height: 1.5; } h2 { page-break-before: always; }
p { margin: 0 0 0.6em; text-indent: 0; }`

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    // Spec: `mimetype` must be first and stored uncompressed.
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/style.css': strToU8(css),
  }
  chapters.forEach((c, i) => {
    files[`OEBPS/c${i}.xhtml`] = strToU8(chapterXhtml(c))
  })

  opts.onProgress?.(doc.numPages, doc.numPages)
  const zipped = zipSync(files)
  const buf = new Uint8Array(zipped.length)
  buf.set(zipped)
  return new Blob([buf], { type: 'application/epub+zip' })
}
