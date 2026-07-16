import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from '../engine/pdf'
import { getPageText, type TextCache } from '../engine/search'
import { reconstructPageScored, stitch, spansText, type Block, type ImageBlock, type Span } from '../engine/reflow'
import { Recolorizer } from '../engine/recolor'
import { renderDarkPage } from '../engine/pipeline'
import { classifyPage, type PageClassification } from '../engine/classify'
import type { Theme } from '../engine/theme'

// Text Mode: the reflow reader. Instead of showing the page image, it extracts
// the text (digital PDFs only) and re-lays it in your font, size and spacing —
// the "font dream". Pages are reconstructed into paragraphs by engine/reflow.ts
// and streamed into a continuous column, loading forward as you scroll down and
// backward (with scroll anchoring) as you scroll up, like an ebook. Figures and
// tables don't survive reflow — that's what Faithful mode is for.

// Curated reading faces, self-hosted (see main.tsx). Each carries a fallback
// stack and whether it reads best as a serif preview label.
export interface TextFontDef {
  id: string
  name: string
  stack: string
  serif: boolean
}
export const TEXT_FONTS: TextFontDef[] = [
  { id: 'lora', name: 'Lora', stack: "'Lora', Georgia, serif", serif: true },
  { id: 'literata', name: 'Literata', stack: "'Literata', Georgia, serif", serif: true },
  { id: 'merriweather', name: 'Merriweather', stack: "'Merriweather', Georgia, serif", serif: true },
  { id: 'inter', name: 'Inter', stack: "'Inter', system-ui, sans-serif", serif: false },
  {
    id: 'atkinson',
    name: 'Atkinson',
    stack: "'Atkinson Hyperlegible', system-ui, sans-serif",
    serif: false,
  },
  { id: 'dyslexic', name: 'OpenDyslexic', stack: "'OpenDyslexic', sans-serif", serif: false },
]
export const fontStack = (id: string) =>
  (TEXT_FONTS.find((f) => f.id === id) ?? TEXT_FONTS[0]).stack

export type ParaStyle = 'indent' | 'spaced'

interface TextReaderProps {
  doc: PDFDocumentProxy
  pageCount: number
  startPage: number
  fg: string
  bg: string
  theme: Theme // for recoloring image-heavy pages
  imageDim: number
  fontPx: number
  leading: number
  family: string // resolved CSS font-family stack
  maxWidth: number
  justify: boolean
  paraStyle: ParaStyle
  textCache: TextCache
  onPage: (page: number) => void
  /** Pinch in Text Mode resizes the text (reflowing) rather than zooming the page. */
  onFontSize: (px: number) => void
  onToggleChrome: () => void
}

// A page renders either as reflowed text (prose) or as its recolored image
// (cover, title pages, figures, system screens) so nothing visual is lost. A
// reflowed page can still carry inline illustrations: `crops` maps each 'img'
// block to its recolored bitmap and page-relative width, keyed by the block.
type Crop = { canvas: HTMLCanvasElement; wf: number }
type Item =
  | { page: number; kind: 'text'; blocks: Block[]; crops?: Map<Block, Crop> }
  | { page: number; kind: 'image'; canvas: HTMLCanvasElement; w: number; h: number }

const SAT_CUT = 0.25
/** Logical width to render page images at (displayed responsively). */
const IMG_RENDER_W = 900

export function TextReader({
  doc,
  pageCount,
  startPage,
  fg,
  bg,
  theme,
  imageDim,
  fontPx,
  leading,
  family,
  maxWidth,
  justify,
  paraStyle,
  textCache,
  onPage,
  onFontSize,
  onToggleChrome,
}: TextReaderProps) {
  const fontPxRef = useRef(fontPx)
  fontPxRef.current = fontPx
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const itemsRef = useRef<Item[]>([])
  itemsRef.current = items
  const [empty, setEmpty] = useState(false)
  const loadingRef = useRef(false)
  const anchorRef = useRef<number | null>(null) // scrollHeight before a prepend
  const reportedRef = useRef(startPage)

  // Offscreen GL context for recoloring image pages (never touches other views).
  const glRef = useRef<HTMLCanvasElement | null>(null)
  const recolorRef = useRef<Recolorizer | null>(null)
  const imgSrcRef = useRef<HTMLCanvasElement | null>(null)
  const clsRef = useRef(new Map<number, PageClassification>())

  // There's ONE offscreen source canvas and ONE GL context, so page renders must
  // not overlap — pdf.js throws "same canvas during multiple render()" and the
  // recolor output would race. This serializes every render through them (page
  // images and inline-image crops alike). Without it, StrictMode's double-invoked
  // effects or a fast scroll can fire two renders at once and Text Mode dies.
  const renderLock = useRef<Promise<unknown>>(Promise.resolve())
  const withRenderLock = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = renderLock.current.then(fn, fn)
    renderLock.current = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }, [])
  useEffect(() => {
    const c = document.createElement('canvas')
    glRef.current = c
    imgSrcRef.current = document.createElement('canvas')
    try {
      recolorRef.current = new Recolorizer(c, /* preserveDrawingBuffer */ true)
    } catch {
      recolorRef.current = null
    }
    return () => {
      recolorRef.current?.dispose()
      recolorRef.current = null
    }
  }, [])

  const renderPageImage = useCallback(
    (pdfPage: PDFPageProxy): Promise<Item | null> =>
      withRenderLock(async () => {
        const recolor = recolorRef.current
        if (!recolor) return null
        const vp = pdfPage.getViewport({ scale: 1 })
        const dpr = Math.min(window.devicePixelRatio || 1, 3)
        await renderDarkPage(pdfPage, IMG_RENDER_W / vp.width, dpr, recolor, {
          theme,
          satCut: SAT_CUT,
          imageDim,
          sourceCanvas: imgSrcRef.current ?? undefined,
        })
        const gl = glRef.current!
        const out = document.createElement('canvas')
        out.width = gl.width
        out.height = gl.height
        out.getContext('2d')!.drawImage(gl, 0, 0)
        return { page: pdfPage.pageNumber, kind: 'image', canvas: out, w: IMG_RENDER_W, h: IMG_RENDER_W * (vp.height / vp.width) }
      }),
    [theme, imageDim, withRenderLock],
  )

  // Render the recolored page once, then crop each inline-image block out of it.
  // Cropping the recolored page (not the raw image) keeps the illustration on the
  // theme ground and dimmed, exactly as Faithful mode shows it — the pipeline
  // already preserves declared image regions, so the crop is the real picture.
  const renderInlineCrops = useCallback(
    (pdfPage: PDFPageProxy, imgBlocks: ImageBlock[]): Promise<Map<Block, Crop> | undefined> =>
      withRenderLock(async () => {
        const recolor = recolorRef.current
        if (!recolor) return undefined
        const vp = pdfPage.getViewport({ scale: 1 })
        const dpr = Math.min(window.devicePixelRatio || 1, 3)
        await renderDarkPage(pdfPage, IMG_RENDER_W / vp.width, dpr, recolor, {
          theme,
          satCut: SAT_CUT,
          imageDim,
          sourceCanvas: imgSrcRef.current ?? undefined,
        })
        const gl = glRef.current!
        const view = pdfPage.view // [x0, y0, x1, y1], PDF user space, y up
        const viewW = view[2] - view[0]
        const viewH = view[3] - view[1]
        const crops = new Map<Block, Crop>()
        for (const b of imgBlocks) {
          const r = b.rect
          // PDF user space (y up) -> canvas pixels (y down), full page fills gl.
          const sx = ((r.x - view[0]) / viewW) * gl.width
          const sy = ((view[3] - (r.y + r.h)) / viewH) * gl.height
          const sw = (r.w / viewW) * gl.width
          const sh = (r.h / viewH) * gl.height
          const c = document.createElement('canvas')
          c.width = Math.max(1, Math.round(sw))
          c.height = Math.max(1, Math.round(sh))
          c.getContext('2d')!.drawImage(gl, sx, sy, sw, sh, 0, 0, c.width, c.height)
          crops.set(b, { canvas: c, wf: r.w / viewW })
        }
        return crops
      }),
    [theme, imageDim, withRenderLock],
  )

  // Decide per page: reflow prose, but render image-heavy or near-textless pages
  // (cover, title pages, full-page figures, scans) as their recolored image.
  // Prose pages still keep their illustrations — declared images of a sensible
  // size are woven back into the flow at their original position (the goblin on a
  // chapter-divider page, an inline figure) instead of being dropped by reflow.
  const reflowPage = useCallback(
    async (pageNo: number): Promise<Item> => {
      const pdfPage = await doc.getPage(pageNo)
      let cls = clsRef.current.get(pageNo)
      if (!cls) {
        cls = await classifyPage(pdfPage)
        clsRef.current.set(pageNo, cls)
      }
      const asImage = cls.textChars < 120 || cls.imageCoverage > 0.4 || cls.kind === 'scanned'
      if (asImage) {
        const img = await renderPageImage(pdfPage)
        if (img) return img
      }
      const view = pdfPage.view
      const pageArea = Math.max(1, (view[2] - view[0]) * (view[3] - view[1]))
      const pageH = view[3] - view[1]
      // Keep images worth showing: not hairline rules, not a full-page background
      // (that path is handled above), big enough to read as a picture.
      const inlineRects = cls.imageRects.filter((r) => {
        const areaFrac = (r.w * r.h) / pageArea
        return areaFrac >= 0.004 && areaFrac <= 0.85 && Math.min(r.w, r.h) > pageH * 0.02
      })
      const pt = await getPageText(pdfPage, textCache, /* ensureStyle */ true)
      const { blocks, quality } = reconstructPageScored(pt, inlineRects)
      // Low confidence means the reconstruction would read wrong (interleaved
      // columns, a table as word soup). Show the recolored page instead —
      // worst case looks like scroll mode, never like mangled prose.
      if (quality.confidence < 0.5) {
        const img = await renderPageImage(pdfPage)
        if (img) return img
      }
      const imgBlocks = blocks.filter((b): b is ImageBlock => b.kind === 'img')
      const crops = imgBlocks.length ? await renderInlineCrops(pdfPage, imgBlocks) : undefined
      return { page: pageNo, kind: 'text', blocks, crops }
    },
    [doc, textCache, renderPageImage, renderInlineCrops],
  )

  // Latest reflowPage / startPage read through refs so the load effects don't
  // list them as deps. reflowPage's identity changes on every theme/dimmer
  // change; if the initial load depended on it, changing theme in Text Mode
  // would reset the whole reader back to one page (a real bug).
  const reflowPageRef = useRef(reflowPage)
  reflowPageRef.current = reflowPage
  const startPageRef = useRef(startPage)
  startPageRef.current = startPage

  // A theme / image-brightness change must REPAINT the canvases already in the
  // column (image pages, inline crops) — they were rendered under the old
  // palette and would otherwise stay stale: a dark goblin icon left floating
  // on a Paper page. The text column needs nothing (it recolors via CSS), and
  // scroll position holds because every replacement keeps its box size. This
  // is deliberately NOT a reload — see the load-once effect below.
  const paletteRef = useRef({ theme, imageDim })
  useEffect(() => {
    if (paletteRef.current.theme === theme && paletteRef.current.imageDim === imageDim) return
    paletteRef.current = { theme, imageDim }
    let alive = true
    void (async () => {
      const repainted = new Map<number, Item>()
      for (const it of itemsRef.current) {
        if (!alive) return
        if (it.kind === 'image') {
          const fresh = await renderPageImage(await doc.getPage(it.page))
          if (fresh) repainted.set(it.page, fresh)
        } else if (it.crops?.size) {
          const imgBlocks = it.blocks.filter((b): b is ImageBlock => b.kind === 'img')
          const crops = await renderInlineCrops(await doc.getPage(it.page), imgBlocks)
          if (crops) repainted.set(it.page, { ...it, crops })
        }
      }
      if (alive && repainted.size) {
        setItems((cur) => cur.map((it) => repainted.get(it.page) ?? it))
      }
    })()
    return () => {
      alive = false
    }
  }, [theme, imageDim, doc, renderPageImage, renderInlineCrops])

  // Load ONCE per document (a new book), at the page you were on. Crucially NOT
  // on startPage (TextReader reports its own page as you scroll) nor reflowPage
  // (changes on theme/dimmer) — either would collapse the continuous reader.
  useEffect(() => {
    let alive = true
    void (async () => {
      const first = await reflowPageRef.current(startPageRef.current)
      if (!alive) return
      // Image pages render; only a genuinely blank text page yields nothing.
      if (first.kind === 'text' && first.blocks.length === 0 && !first.crops?.size) setEmpty(true)
      else {
        setItems([first])
        reportedRef.current = first.page
      }
    })()
    return () => {
      alive = false
    }
  }, [doc])

  // Respond to an EXTERNAL jump (scrubber, Contents, bookmark) — a startPage
  // that isn't the page we just reported. Scroll to it if it's loaded, else
  // reset the reader to it. An equal startPage is our own scroll echo: ignore.
  useEffect(() => {
    if (startPage === reportedRef.current) return
    reportedRef.current = startPage
    const scroller = scrollerRef.current
    if (!scroller) return
    const sec = scroller.querySelector<HTMLElement>(`[data-textpage="${startPage}"]`)
    if (sec) {
      scroller.scrollTop += sec.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      return
    }
    let alive = true
    void (async () => {
      const it = await reflowPage(startPage)
      if (!alive) return
      setItems([it])
      setEmpty(it.kind === 'text' && it.blocks.length === 0)
      requestAnimationFrame(() => {
        if (scrollerRef.current) scrollerRef.current.scrollTop = 0
      })
    })()
    return () => {
      alive = false
    }
  }, [startPage, reflowPage])

  const extend = useCallback(
    async (dir: 1 | -1) => {
      if (loadingRef.current) return
      const scroller = scrollerRef.current
      if (!scroller || !items.length) return
      const edge = dir === 1 ? items[items.length - 1].page : items[0].page
      const next = edge + dir
      if (next < 1 || next > pageCount) return
      if (items.some((x) => x.page === next)) return // already loaded; never twice
      loadingRef.current = true
      try {
        const it = await reflowPage(next)
        setItems((cur) => {
          // Guard against a race adding the same page twice (the duplicate-page bug).
          if (cur.some((x) => x.page === it.page)) return cur
          if (dir === 1) {
            const prev = cur[cur.length - 1]
            if (prev.kind === 'text' && it.kind === 'text') stitch(prev.blocks, it.blocks)
            return [...cur, it]
          }
          anchorRef.current = scroller.scrollHeight // preserve position on prepend
          const nextFirst = cur[0]
          if (it.kind === 'text' && nextFirst.kind === 'text') stitch(it.blocks, nextFirst.blocks)
          return [it, ...cur]
        })
      } finally {
        loadingRef.current = false
      }
    },
    [items, pageCount, reflowPage],
  )

  // After a prepend, keep the reader visually still by restoring the offset.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller && anchorRef.current !== null) {
      scroller.scrollTop += scroller.scrollHeight - anchorRef.current
      anchorRef.current = null
    }
  }, [items])

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const { scrollTop, clientHeight, scrollHeight } = scroller
    if (scrollTop < 700) void extend(-1)
    if (scrollTop + clientHeight > scrollHeight - 1000) void extend(1)
    // Report the page whose section currently sits at the top of the viewport.
    const secs = scroller.querySelectorAll<HTMLElement>('[data-textpage]')
    const top = scroller.getBoundingClientRect().top
    let current = reportedRef.current
    for (const s of secs) {
      if (s.getBoundingClientRect().top - top <= 1) current = Number(s.dataset.textpage)
      else break
    }
    if (current !== reportedRef.current) {
      reportedRef.current = current
      onPage(current)
    }
  }, [extend, onPage])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [onScroll])

  // Pinch resizes the text (reflowing to stay on-screen) instead of letting iOS
  // zoom the whole page — which, with nothing to pan, just slid the text off
  // into blank space. preventDefault on the two-finger gesture suppresses the
  // native zoom; the size change is pure CSS, so it reflows instantly.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    let d0 = 0
    let s0 = 0
    let active = false
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      e.preventDefault()
      d0 = dist(e.touches)
      s0 = fontPxRef.current
      active = true
    }
    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 2) return
      e.preventDefault()
      if (d0 <= 0) return
      const next = Math.max(14, Math.min(30, Math.round((s0 * dist(e.touches)) / d0)))
      if (next !== fontPxRef.current) onFontSize(next)
    }
    const onEnd = () => {
      active = false
    }
    scroller.addEventListener('touchstart', onStart, { passive: false })
    scroller.addEventListener('touchmove', onMove, { passive: false })
    scroller.addEventListener('touchend', onEnd)
    scroller.addEventListener('touchcancel', onEnd)
    return () => {
      scroller.removeEventListener('touchstart', onStart)
      scroller.removeEventListener('touchmove', onMove)
      scroller.removeEventListener('touchend', onEnd)
      scroller.removeEventListener('touchcancel', onEnd)
    }
  }, [onFontSize])

  const fontFamily = family

  if (empty) {
    return (
      <div ref={scrollerRef} className="relative flex-1 overflow-y-auto overflow-x-hidden" onClick={onToggleChrome}>
        <div className="mx-auto mt-24 max-w-sm px-6 text-center" style={{ color: fg }}>
          <p className="font-serif text-lg opacity-80">No selectable text here.</p>
          <p className="mt-2 text-sm opacity-50">
            This looks like a scanned book, so there's nothing to reflow. Switch back to Faithful to
            read it. (Text from scans needs OCR — that's coming.)
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={scrollerRef}
      data-textreader
      className="relative flex-1 overflow-y-auto overflow-x-hidden"
      style={{ background: bg, color: fg }}
      onClick={() => {
        // One tap anywhere toggles the chrome, both directions; the click that
        // ends a text selection is the one exception.
        const s = window.getSelection()
        if (s && !s.isCollapsed) return
        onToggleChrome()
      }}
    >
      <div
        lang="en"
        className="mx-auto px-6 py-10"
        style={{
          maxWidth,
          fontFamily,
          fontSize: fontPx,
          lineHeight: leading,
          textAlign: justify ? 'justify' : 'left',
          hyphens: justify ? 'auto' : 'manual',
          WebkitHyphens: justify ? 'auto' : 'manual',
          hangingPunctuation: 'first last',
        }}
      >
        {items.map((it) => (
          <section key={it.page} data-textpage={it.page}>
            {it.kind === 'image' ? (
              <ImagePage item={it} />
            ) : (
              it.blocks.map((b, i) => {
              if (b.kind === 'img') {
                // An illustration kept in the flow (chapter-divider icon, figure).
                const crop = it.crops?.get(b)
                return crop ? <InlineImage key={i} crop={crop} /> : null
              }
              if (b.kind === 'sep') {
                // A scene break: quiet, centered, unmistakably deliberate.
                return (
                  <div key={i} aria-hidden className="my-8 text-center opacity-50" style={{ letterSpacing: '0.6em' }}>
                    * * *
                  </div>
                )
              }
              if (b.kind === 'h') {
                // Short headings (chapter markers like "[ 1 ]") read best
                // centered with room; longer section titles stay left.
                const marker = spansText(b.spans).length <= 24
                return (
                  <h2
                    key={i}
                    className={marker ? 'mb-6 mt-12 opacity-80' : 'mb-4 mt-9 font-semibold'}
                    style={{
                      fontSize: marker ? '1.5em' : '1.3em',
                      lineHeight: 1.2,
                      fontFamily,
                      textAlign: marker ? 'center' : 'left',
                    }}
                  >
                    {renderSpans(b.spans)}
                  </h2>
                )
              }
              // A drop cap opens each chapter (the paragraph right after a heading).
              const opensChapter = i > 0 && it.blocks[i - 1].kind === 'h'
              const indent = paraStyle === 'indent' && !opensChapter && !b.openStart
              return (
                <p
                  key={i}
                  className={opensChapter ? 'nocturne-dropcap' : undefined}
                  style={{
                    textWrap: 'pretty',
                    overflowWrap: 'break-word',
                    marginBottom: paraStyle === 'spaced' ? '0.9em' : 0,
                    textIndent: indent ? '1.3em' : 0,
                  }}
                >
                  {renderSpans(b.spans)}
                </p>
              )
              })
            )}
          </section>
        ))}
        {items.length > 0 && (
          <div className="py-10 text-center text-xs opacity-40">
            {items[items.length - 1].page >= pageCount ? 'End' : 'Loading…'}
          </div>
        )}
      </div>
    </div>
  )
}

/** An illustration kept inline in the reflowed column, sized relative to the
 *  page (floored so small icons stay visible) and centered. */
function InlineImage({ crop }: { crop: Crop }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    host.replaceChildren()
    crop.canvas.style.width = '100%'
    crop.canvas.style.height = 'auto'
    crop.canvas.style.display = 'block'
    host.appendChild(crop.canvas)
    return () => {
      if (host) host.replaceChildren()
    }
  }, [crop.canvas])
  const widthPct = Math.min(1, Math.max(crop.wf, 0.25)) * 100
  return <div ref={ref} className="mx-auto my-6" style={{ width: `${widthPct}%` }} />
}

/** Render a block's styled spans, preserving bold/italic from the source. */
function renderSpans(spans: Span[]) {
  return spans.map((s, i) => {
    if (s.b && s.i)
      return (
        <strong key={i}>
          <em>{s.text}</em>
        </strong>
      )
    if (s.b) return <strong key={i}>{s.text}</strong>
    if (s.i) return <em key={i}>{s.text}</em>
    return s.text
  })
}

/** Renders a page's recolored image (cover, figure, system screen) in the flow. */
function ImagePage({ item }: { item: Extract<Item, { kind: 'image' }> }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    host.replaceChildren()
    item.canvas.style.width = '100%'
    item.canvas.style.height = '100%'
    item.canvas.style.display = 'block'
    host.appendChild(item.canvas)
    return () => {
      if (host) host.replaceChildren()
    }
  }, [item.canvas])
  return (
    <div
      ref={ref}
      className="mx-auto my-6 overflow-hidden rounded shadow-2xl"
      style={{ width: '100%', maxWidth: item.w, aspectRatio: `${item.w} / ${item.h}` }}
    />
  )
}
