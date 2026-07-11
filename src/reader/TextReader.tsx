import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from '../engine/pdf'
import { getPageText, type TextCache } from '../engine/search'
import { reconstructPage, stitch, type Block } from '../engine/reflow'
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
// (cover, title pages, figures, system screens) so nothing visual is lost.
type Item =
  | { page: number; kind: 'text'; blocks: Block[] }
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
  const [empty, setEmpty] = useState(false)
  const loadingRef = useRef(false)
  const anchorRef = useRef<number | null>(null) // scrollHeight before a prepend
  const reportedRef = useRef(startPage)

  // Offscreen GL context for recoloring image pages (never touches other views).
  const glRef = useRef<HTMLCanvasElement | null>(null)
  const recolorRef = useRef<Recolorizer | null>(null)
  const imgSrcRef = useRef<HTMLCanvasElement | null>(null)
  const clsRef = useRef(new Map<number, PageClassification>())
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
    async (pdfPage: PDFPageProxy): Promise<Item | null> => {
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
    },
    [theme, imageDim],
  )

  // Decide per page: reflow prose, but render image-heavy or near-textless
  // pages (cover, title pages, figures, scans) as their recolored image so
  // everything is preserved — only the prose is refonted.
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
      const pt = await getPageText(pdfPage, textCache)
      return { page: pageNo, kind: 'text', blocks: reconstructPage(pt) }
    },
    [doc, textCache, renderPageImage],
  )

  // Load ONCE at the page you were on (re-running on the doc, i.e. a new book).
  // Crucially NOT on startPage: TextReader reports its own page as you scroll,
  // which changes startPage — re-loading on that would collapse the continuous
  // reader back to one page every time you crossed a boundary (the bug).
  const initialPageRef = useRef(startPage)
  useEffect(() => {
    let alive = true
    void (async () => {
      const first = await reflowPage(initialPageRef.current)
      if (!alive) return
      // Image pages render; only a genuinely blank text page yields nothing.
      if (first.kind === 'text' && first.blocks.length === 0) setEmpty(true)
      else {
        setItems([first])
        reportedRef.current = first.page
      }
    })()
    return () => {
      alive = false
    }
  }, [reflowPage, pageCount])

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
      loadingRef.current = true
      try {
        const it = await reflowPage(next)
        setItems((cur) => {
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
      className="relative flex-1 overflow-y-auto overflow-x-hidden"
      style={{ background: bg, color: fg }}
      onClick={onToggleChrome}
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
              if (b.kind === 'h') {
                // Short headings (chapter markers like "[ 1 ]") read best
                // centered with room; longer section titles stay left.
                const marker = b.text.length <= 24
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
                    {b.text}
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
                  {b.text}
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
