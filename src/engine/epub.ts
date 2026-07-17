import { unzipSync, strFromU8 } from 'fflate'

// EPUB input. An EPUB is a ZIP of XHTML chapters plus a manifest (OPF) that
// lists reading order (the spine) and a table of contents — the structure
// reflow.ts works so hard to RECONSTRUCT from PDFs, provided losslessly by
// the publisher. So none of the PDF pipeline applies here: no classify, no
// recolor, no trust score. This module parses the container and hands the
// reader sanitized chapter HTML; themes and typography are plain CSS.
//
// Framework-free, DOM APIs only (DOMParser). Fixed-layout EPUBs (comics)
// are detected and refused with a clear error — they need a page renderer,
// not a text column.

export interface EpubToc {
  title: string
  /** Spine index the entry points into (fragment targets collapse to it). */
  chapter: number
}

export interface EpubDoc {
  title: string
  author?: string
  /** One entry per spine item, in reading order. */
  chapterCount: number
  toc: EpubToc[]
  /** Plain-text length per chapter — the whole-book percent weighting. */
  charCounts: number[]
  totalChars: number
  /** Sanitized, self-contained HTML for one chapter (cached). Image srcs are
   *  blob: URLs owned by this doc — call dispose() when done with the book. */
  chapterHtml(index: number): string
  /** Cover image bytes (jpeg/png/webp) when the book declares one. */
  cover?: { data: Uint8Array; mime: string }
  /** Whole-book fraction for a position (chapter + fraction within it). */
  percentAt(chapter: number, frac: number): number
  /** Plain text of a fragment target (a footnote body) in a chapter. */
  noteText(chapter: number, fragId: string): string | null
  dispose(): void
}

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li',
  'hr', 'br', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'td',
  'th', 'pre', 'div', 'section', 'aside',
])
const INLINE_TAGS = new Set(['em', 'i', 'strong', 'b', 'span', 'small', 'sup', 'sub', 'code', 'a', 'cite', 'q', 's', 'u'])
const IMAGE_MIMES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml',
}

/** Resolve a relative href against the directory of `from` (zip paths). */
function resolveHref(from: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]).replace(/^\.\//, '')
  if (!clean) return from
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
  const parts = (base + clean).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  return out.join('/')
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml')
}

export async function openEpub(bytes: Uint8Array): Promise<EpubDoc> {
  const files = unzipSync(bytes)
  const get = (path: string): Uint8Array | undefined =>
    files[path] ?? files[Object.keys(files).find((k) => k.toLowerCase() === path.toLowerCase()) ?? '']

  const containerRaw = get('META-INF/container.xml')
  if (!containerRaw) throw new Error('Not an EPUB (no META-INF/container.xml).')
  const container = parseXml(strFromU8(containerRaw))
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path')
  if (!opfPath || !get(opfPath)) throw new Error('EPUB has no readable package file.')

  const opf = parseXml(strFromU8(get(opfPath)!))
  const title =
    opf.getElementsByTagName('dc:title')[0]?.textContent?.trim() ||
    opf.querySelector('title')?.textContent?.trim() ||
    'Untitled'
  const author = opf.getElementsByTagName('dc:creator')[0]?.textContent?.trim() || undefined

  // Fixed-layout books are page images in HTML clothing — refuse honestly.
  for (const m of Array.from(opf.querySelectorAll('meta[property="rendition:layout"]'))) {
    if (m.textContent?.trim() === 'pre-paginated')
      throw new Error('This is a fixed-layout EPUB (comic/picture book) — not supported yet.')
  }

  // Manifest: id → zip path (+ the nav/cover roles).
  const items = new Map<string, { path: string; type: string; props: string }>()
  let navPath: string | null = null
  let coverId: string | null = null
  for (const it of Array.from(opf.querySelectorAll('manifest > item'))) {
    const id = it.getAttribute('id') ?? ''
    const href = it.getAttribute('href') ?? ''
    const type = it.getAttribute('media-type') ?? ''
    const props = it.getAttribute('properties') ?? ''
    const path = resolveHref(opfPath, href)
    items.set(id, { path, type, props })
    if (props.split(/\s+/).includes('nav')) navPath = path
    if (props.split(/\s+/).includes('cover-image')) coverId = id
  }
  if (!coverId) coverId = opf.querySelector('meta[name="cover"]')?.getAttribute('content') ?? null

  // Spine: reading order of chapter paths.
  const spine: string[] = []
  for (const ref of Array.from(opf.querySelectorAll('spine > itemref'))) {
    const item = items.get(ref.getAttribute('idref') ?? '')
    if (item && /x?html/.test(item.type)) spine.push(item.path)
  }
  if (!spine.length) throw new Error('EPUB has an empty spine.')
  const spineIndex = new Map(spine.map((p, i) => [p, i]))

  // TOC: EPUB3 nav doc, else EPUB2 NCX.
  const toc: EpubToc[] = []
  const addToc = (label: string, href: string, fromPath: string) => {
    const target = spineIndex.get(resolveHref(fromPath, href))
    const t = label.replace(/\s+/g, ' ').trim()
    if (target !== undefined && t) toc.push({ title: t, chapter: target })
  }
  if (navPath && get(navPath)) {
    const nav = new DOMParser().parseFromString(strFromU8(get(navPath)!), 'text/html')
    const tocNav =
      nav.querySelector('nav[epub\\:type="toc"], nav[*|type="toc"]') ?? nav.querySelector('nav')
    for (const a of Array.from(tocNav?.querySelectorAll('a[href]') ?? [])) {
      addToc(a.textContent ?? '', a.getAttribute('href') ?? '', navPath)
    }
  }
  if (!toc.length) {
    const ncxId = opf.querySelector('spine')?.getAttribute('toc')
    const ncxPath = ncxId ? items.get(ncxId)?.path : undefined
    const ncxRaw = ncxPath ? get(ncxPath) : undefined
    if (ncxPath && ncxRaw) {
      const ncx = parseXml(strFromU8(ncxRaw))
      for (const np of Array.from(ncx.querySelectorAll('navPoint'))) {
        addToc(
          np.querySelector('navLabel > text')?.textContent ?? '',
          np.querySelector('content')?.getAttribute('src') ?? '',
          ncxPath,
        )
      }
    }
  }
  // Dedupe consecutive entries collapsing to the same chapter.
  const dedupedToc = toc.filter((e, i) => i === 0 || e.chapter !== toc[i - 1].chapter)

  // Character weights for whole-book percent (cheap tag-strip; one pass).
  const charCounts = spine.map((path) => {
    const raw = get(path)
    if (!raw) return 1
    return Math.max(1, strFromU8(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').length)
  })
  const totalChars = charCounts.reduce((a, b) => a + b, 0)

  const cover = (() => {
    const item = coverId ? items.get(coverId) : undefined
    const data = item ? get(item.path) : undefined
    return data ? { data, mime: item!.type || 'image/jpeg' } : undefined
  })()

  // --- chapter sanitization (lazy, cached) ---------------------------------
  const htmlCache = new Map<number, string>()
  const blobUrls: string[] = []

  const imageUrl = (chapterPath: string, src: string): string | null => {
    const path = resolveHref(chapterPath, src)
    const data = get(path)
    if (!data) return null
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const url = URL.createObjectURL(
      new Blob([data.slice().buffer as ArrayBuffer], { type: IMAGE_MIMES[ext] ?? 'image/jpeg' }),
    )
    blobUrls.push(url)
    return url
  }

  // Attributes that survive sanitization: fragment ids (so internal links
  // and footnotes have targets), and lang/dir (mixed-language books).
  const safeAttrs = (el: Element): string => {
    let s = ''
    const id = el.getAttribute('id')
    if (id && /^[\w.:-]+$/.test(id)) s += ` id="${id}"`
    const lang = el.getAttribute('lang') ?? el.getAttribute('xml:lang')
    if (lang && /^[\w-]+$/.test(lang)) s += ` lang="${lang}"`
    const dir = el.getAttribute('dir')
    if (dir === 'rtl' || dir === 'ltr') s += ` dir="${dir}"`
    return s
  }

  const sanitizeNode = (node: Node, chapterPath: string, out: string[]): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(escapeHtml(node.textContent ?? ''))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'video' || tag === 'audio') return
    if (tag === 'img' || tag === 'image') {
      const src = el.getAttribute('src') ?? el.getAttribute('xlink:href') ?? el.getAttribute('href')
      const url = src ? imageUrl(chapterPath, src) : null
      if (url) out.push(`<img src="${url}" alt="" loading="lazy" />`)
      return
    }
    if (tag === 'svg') {
      // SVG wrappers around a single image are a common cover idiom.
      const inner = el.querySelector('image')
      if (inner) sanitizeNode(inner, chapterPath, out)
      return
    }
    if (tag === 'a') {
      // Internal links resolve to our position model (chapter + fragment id)
      // and become tappable spans; footnote refs are flagged so the reader
      // can pop the note up in place instead of jumping away. External URLs
      // flatten to plain text — the outside web doesn't belong in a book.
      const href = el.getAttribute('href') ?? ''
      const isExternal = /^[a-z][a-z0-9+.-]*:/i.test(href)
      const targetChapter = href && !isExternal ? spineIndex.get(resolveHref(chapterPath, href)) : undefined
      const frag = href.includes('#') ? href.slice(href.indexOf('#') + 1) : ''
      const sameFile = !isExternal && href.startsWith('#')
      const chapterAttr = sameFile ? undefined : targetChapter
      const epubType = el.getAttribute('epub:type') ?? el.getAttribute('role') ?? ''
      const isNote = /noteref|doc-noteref/.test(epubType)
      if (!isExternal && (chapterAttr !== undefined || sameFile)) {
        const attrs =
          ` data-el="${chapterAttr ?? 'same'}"` +
          (frag && /^[\w.:-]+$/.test(frag) ? ` data-ef="${frag}"` : '') +
          (isNote ? ' data-note="1"' : '') +
          safeAttrs(el)
        out.push(`<span${attrs}>`)
        for (const child of Array.from(el.childNodes)) sanitizeNode(child, chapterPath, out)
        out.push('</span>')
        return
      }
      out.push(`<span${safeAttrs(el)}>`)
      for (const child of Array.from(el.childNodes)) sanitizeNode(child, chapterPath, out)
      out.push('</span>')
      return
    }
    const keepBlock = BLOCK_TAGS.has(tag)
    const keepInline = INLINE_TAGS.has(tag)
    if (keepBlock || keepInline) {
      const outTag = tag === 'div' || tag === 'section' || tag === 'aside' ? 'div' : tag
      out.push(`<${outTag}${safeAttrs(el)}>`)
      for (const child of Array.from(el.childNodes)) sanitizeNode(child, chapterPath, out)
      out.push(`</${outTag}>`)
      return
    }
    // Unknown element: keep its children, drop the wrapper.
    for (const child of Array.from(el.childNodes)) sanitizeNode(child, chapterPath, out)
  }

  const chapterHtml = (index: number): string => {
    const cached = htmlCache.get(index)
    if (cached !== undefined) return cached
    const path = spine[index]
    const raw = path ? get(path) : undefined
    if (!raw) return '<p>(missing chapter)</p>'
    let doc = new DOMParser().parseFromString(strFromU8(raw), 'application/xhtml+xml')
    if (doc.querySelector('parsererror')) {
      doc = new DOMParser().parseFromString(strFromU8(raw), 'text/html')
    }
    const out: string[] = []
    const body = doc.querySelector('body') ?? doc.documentElement
    for (const child of Array.from(body.childNodes)) sanitizeNode(child, path, out)
    const html = out.join('')
    htmlCache.set(index, html)
    return html
  }

  return {
    title,
    author,
    chapterCount: spine.length,
    toc: dedupedToc,
    charCounts,
    totalChars,
    chapterHtml,
    cover,
    percentAt(chapter: number, frac: number): number {
      const c = Math.max(0, Math.min(spine.length - 1, chapter))
      let before = 0
      for (let i = 0; i < c; i++) before += charCounts[i]
      const f = Math.max(0, Math.min(1, frac))
      return Math.max(0, Math.min(1, (before + charCounts[c] * f) / totalChars))
    },
    noteText(chapter: number, fragId: string): string | null {
      if (chapter < 0 || chapter >= spine.length || !/^[\w.:-]+$/.test(fragId)) return null
      const host = document.createElement('div')
      host.innerHTML = chapterHtml(chapter)
      const el = host.querySelector(`#${CSS.escape(fragId)}`)
      // The id often sits on the marker inside the note — read the whole block.
      const block = el?.closest('p, li, div, blockquote') ?? el
      const text = block?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      return text.length > 1 ? text.slice(0, 600) : null
    },
    dispose() {
      for (const u of blobUrls) URL.revokeObjectURL(u)
      blobUrls.length = 0
      htmlCache.clear()
    },
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Cheap magic sniff: is this file an EPUB (zip with the EPUB mimetype)? */
export function looksLikeEpub(bytes: Uint8Array, name?: string): boolean {
  if (name?.toLowerCase().endsWith('.epub')) return true
  if (bytes.length < 60 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  // The first entry of a valid EPUB is the uncompressed `mimetype` file.
  const head = new TextDecoder().decode(bytes.slice(0, 100))
  return head.includes('mimetypeapplication/epub+zip')
}
