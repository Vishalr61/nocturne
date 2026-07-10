import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type CropBox, type PDFDocumentProxy } from '../engine/pdf'
import { Recolorizer } from '../engine/recolor'
import { renderDarkPage } from '../engine/pipeline'
import { classifyPage, type PageClassification } from '../engine/classify'
import { getPageText, rangeRects, type TextCache } from '../engine/search'
import type { Theme } from '../engine/theme'
import type { Highlight } from '../storage/db'

// Continuous (scroll) reading. A virtualized vertical strip: every page is a
// fixed-height slot, but only the pages near the viewport hold a rendered
// canvas — the rest are empty spacers of the right height, so a 1700-page book
// costs a handful of canvases, not 1700. Recoloring reuses the exact same
// pipeline as the paged reader (so a page looks identical in either mode); the
// one GL context renders each page in turn and its pixels are blitted into that
// page's own 2D canvas.
//
// Deliberately simpler than paged mode: fit-width, no pinch-zoom, and text
// selection/highlight *creation* stays in paged mode (a drag here means scroll,
// not select). Saved highlights are still shown, and jumps still land.

const RENDER_BUFFER = 2 // pages rendered above/below the viewport
const PAGE_GAP = 12 // px between pages in the strip
const dpr = () => Math.min(window.devicePixelRatio || 1, 3)

interface ContinuousReaderProps {
  doc: PDFDocumentProxy
  pageCount: number
  theme: Theme
  satCut: number
  imageDim: number
  crop: CropBox | null
  /** Page width multiplier. 1 = whole page fits the viewport (fit-page). */
  zoom: number
  /** Current page (controlled): a jump scrolls here; scrolling reports back. */
  page: number
  onPage: (page: number) => void
  onToggleChrome: () => void
  textCache: TextCache
  highlights: Highlight[]
  /** Bumped by the parent when doc/theme/crop/imageDim change, to force re-render. */
  renderKey: string
}

interface Slot {
  top: number
  height: number
}

export function ContinuousReader({
  doc,
  pageCount,
  theme,
  satCut,
  imageDim,
  crop,
  zoom,
  page,
  onPage,
  onToggleChrome,
  textCache,
  highlights,
  renderKey,
}: ContinuousReaderProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const recolorRef = useRef<Recolorizer | null>(null)
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // Rendered page canvases by page number, and the queue that serializes the
  // one shared GL context across pages.
  const rendered = useRef(new Map<number, HTMLCanvasElement>())
  const clsCache = useRef(new Map<number, PageClassification>())
  const renderChain = useRef<Promise<void>>(Promise.resolve())
  // Suppress scroll reports while WE are scrolling programmatically (a jump or a
  // zoom re-anchor), so an auto-scroll doesn't get mistaken for the user's.
  const programmaticScroll = useRef(false)
  // The last page WE reported up. A `page` prop equal to this is our own echo,
  // not a jump — so it must not trigger a scroll (that was the teleport bug).
  const lastReported = useRef<number | null>(null)
  const prevSlotHeight = useRef(0)
  const releaseRef = useRef<number | undefined>(undefined)

  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [aspect, setAspect] = useState(0) // page height / width, uniform estimate
  const [visible, setVisible] = useState<{ from: number; to: number }>({ from: 1, to: 1 })
  const [, force] = useState(0)
  const redraw = useCallback(() => force((n) => n + 1), [])

  // Measure the container (both dimensions) and the book's page aspect (page 1 —
  // books are near-always uniform, which makes slot heights exact and jumps
  // land true).
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => setDims({ w: scroller.clientWidth, h: scroller.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    void doc.getPage(1).then((p) => {
      if (!alive) return
      const vp = p.getViewport({ scale: 1 })
      const cropped = crop ? (vp.height * crop.fh) / (vp.width * crop.fw) : vp.height / vp.width
      setAspect(cropped)
    })
    return () => {
      alive = false
    }
  }, [doc, crop])

  // Content width: at zoom 1 the WHOLE page fits the viewport (fit-page) — on a
  // phone that's width-bound (unchanged), on a wide desktop window it's
  // height-bound, which is the fix for "too zoomed in, can't zoom out". Zoom
  // scales up from there, capped at the container width so a vertical scroll
  // never also needs a horizontal one.
  const availW = Math.max(0, dims.w - 16)
  const availH = Math.max(0, dims.h - PAGE_GAP)
  const fitPage = aspect ? Math.min(availW, availH / aspect) : availW
  const contentWidth = Math.min(availW, fitPage * zoom)

  const slotHeight = contentWidth && aspect ? contentWidth * aspect + PAGE_GAP : 0
  const slotFor = useCallback(
    (n: number): Slot => ({ top: (n - 1) * slotHeight, height: slotHeight }),
    [slotHeight],
  )

  // Content size changed (zoom/resize): existing canvases are the wrong
  // resolution, so drop them and let the render effect repaint the visible ones.
  useEffect(() => {
    rendered.current.clear()
    redraw()
  }, [contentWidth, redraw])

  // A new render context whenever the look changes; the old canvases are stale.
  useEffect(() => {
    rendered.current.clear()
    clsCache.current.clear()
    redraw()
  }, [renderKey, redraw])

  // Set up the shared offscreen GL recolorizer once.
  useEffect(() => {
    const gl = document.createElement('canvas')
    glCanvasRef.current = gl
    srcCanvasRef.current = document.createElement('canvas')
    try {
      recolorRef.current = new Recolorizer(gl, /* preserveDrawingBuffer */ true)
    } catch {
      recolorRef.current = null
    }
    return () => {
      recolorRef.current?.dispose()
      recolorRef.current = null
    }
  }, [])

  // The render window for a given scroll position.
  const windowFor = useCallback(
    (top: number) => {
      const ch = scrollerRef.current?.clientHeight ?? 0
      return {
        from: Math.max(1, Math.floor(top / slotHeight) + 1 - RENDER_BUFFER),
        to: Math.min(pageCount, Math.floor((top + ch) / slotHeight) + 1 + RENDER_BUFFER),
      }
    },
    [slotHeight, pageCount],
  )

  // On a real user scroll: update the window, and report the page it lands on.
  // Reporting is skipped while WE are scrolling (jump/re-anchor), and only fires
  // on a genuine change — so the resulting `page` prop update reads as our own
  // echo, never a jump back (that echo-as-jump was the mid-page teleport).
  const onUserScroll = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !slotHeight) return
    const top = scroller.scrollTop
    setVisible((v) => {
      const w = windowFor(top)
      return v.from === w.from && v.to === w.to ? v : w
    })
    if (programmaticScroll.current) return
    const mid = top + scroller.clientHeight / 2
    const current = Math.min(pageCount, Math.max(1, Math.floor(mid / slotHeight) + 1))
    if (current !== lastReported.current) {
      lastReported.current = current
      onPage(current)
    }
  }, [slotHeight, pageCount, onPage, windowFor])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', onUserScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onUserScroll)
  }, [onUserScroll])

  // The one place that scrolls the strip programmatically. Suppresses reporting
  // until the scroll settles, and sets the render window for the destination.
  const scrollToPage = useCallback(
    (p: number) => {
      const scroller = scrollerRef.current
      if (!scroller || !slotHeight) return
      const top = (p - 1) * slotHeight
      programmaticScroll.current = true
      scroller.scrollTo({ top })
      setVisible(windowFor(top))
      window.clearTimeout(releaseRef.current)
      releaseRef.current = window.setTimeout(() => {
        programmaticScroll.current = false
      }, 200)
    },
    [slotHeight, windowFor],
  )

  // The single owner of programmatic scrolling. Three cases, in priority:
  //   - first layout: land on the resume page.
  //   - slot heights changed (zoom/resize/rotate): re-anchor to the page we are
  //     ACTUALLY on (lastReported), computed before the change — never from the
  //     now-stale scroll position, which would resolve to the wrong page.
  //   - a genuine jump: the `page` prop differs from what we last reported
  //     (scrubber/TOC/search/bookmark). An equal `page` is our own echo: ignore.
  useEffect(() => {
    if (!slotHeight) return
    const firstLayout = prevSlotHeight.current === 0
    const slotChanged = prevSlotHeight.current !== slotHeight
    prevSlotHeight.current = slotHeight
    if (firstLayout) {
      lastReported.current = page
      scrollToPage(page)
    } else if (slotChanged) {
      scrollToPage(lastReported.current ?? page)
    } else if (page !== lastReported.current) {
      lastReported.current = page
      scrollToPage(page)
    }
  }, [page, slotHeight, scrollToPage])

  // Render (and evict) canvases to match the visible window. Renders are
  // serialized on one chain because they share the GL + source canvases.
  useEffect(() => {
    if (!contentWidth || !slotHeight || !recolorRef.current) return
    // Evict far pages so memory stays bounded on a phone.
    for (const n of [...rendered.current.keys()]) {
      if (n < visible.from - 1 || n > visible.to + 1) rendered.current.delete(n)
    }
    for (let n = visible.from; n <= visible.to; n++) {
      if (rendered.current.has(n)) continue
      const target = n
      renderChain.current = renderChain.current
        .then(async () => {
          if (target < visible.from - 1 || target > visible.to + 1) return // scrolled away
          if (rendered.current.has(target)) return
          const recolor = recolorRef.current
          if (!recolor) return
          const pdfPage = await doc.getPage(target)
          let cls = clsCache.current.get(target)
          if (!cls) {
            cls = await classifyPage(pdfPage)
            clsCache.current.set(target, cls)
          }
          const vp = pdfPage.getViewport({ scale: 1 })
          const effW = vp.width * (crop?.fw ?? 1)
          const cssScale = contentWidth / effW
          await renderDarkPage(pdfPage, cssScale, dpr(), recolor, {
            theme,
            satCut,
            imageDim,
            crop,
            cls,
            sourceCanvas: srcCanvasRef.current ?? undefined,
          })
          // Blit the recolored pixels out of the shared GL canvas into this
          // page's own 2D canvas, before the next page overwrites the GL canvas.
          const gl = glCanvasRef.current!
          const out = document.createElement('canvas')
          out.width = gl.width
          out.height = gl.height
          out.getContext('2d')!.drawImage(gl, 0, 0)
          rendered.current.set(target, out)
          redraw()
        })
        .catch(() => undefined)
    }
  }, [visible, contentWidth, slotHeight, doc, theme, satCut, imageDim, crop, renderKey, redraw])

  if (!slotHeight) {
    return (
      <div ref={scrollerRef} className="relative flex-1 overflow-auto">
        <div className="grid h-full place-items-center font-serif italic opacity-60">Loading…</div>
      </div>
    )
  }

  const items = []
  for (let n = visible.from; n <= visible.to; n++) items.push(n)

  return (
    <div
      ref={scrollerRef}
      className="relative flex-1 overflow-auto"
      style={{ touchAction: 'pan-y' }}
      onClick={onToggleChrome}
    >
      {/* One tall spacer establishes the full scroll height; pages are absolutely
          positioned into it so only the visible few exist in the DOM. */}
      <div style={{ height: pageCount * slotHeight, position: 'relative' }}>
        {items.map((n) => (
          <PageSlot
            key={n}
            n={n}
            top={slotFor(n).top}
            width={contentWidth}
            height={contentWidth * aspect}
            canvas={rendered.current.get(n) ?? null}
            highlights={highlights.filter((h) => h.page === n)}
            doc={doc}
            crop={crop}
            textCache={textCache}
            contentWidth={contentWidth}
          />
        ))}
      </div>
    </div>
  )
}

interface PageSlotProps {
  n: number
  top: number
  width: number
  height: number
  canvas: HTMLCanvasElement | null
  highlights: Highlight[]
  doc: PDFDocumentProxy
  crop: CropBox | null
  textCache: TextCache
  contentWidth: number
}

function PageSlot({
  n,
  top,
  width,
  height,
  canvas,
  highlights,
  doc,
  crop,
  textCache,
  contentWidth,
}: PageSlotProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [rects, setRects] = useState<{ id: string; left: number; top: number; w: number; h: number }[]>([])

  // Mount the recolored canvas (owned by the parent's map) into a dedicated
  // leaf node. That node has NO React children, so imperatively swapping the
  // canvas can never collide with React's own child reconciliation (mixing the
  // two on one node crashes with "removeChild: not a child of this node").
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.replaceChildren()
    if (canvas) {
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      canvas.className = 'block rounded shadow-2xl'
      host.appendChild(canvas)
    }
  }, [canvas, width, height])

  // Saved highlights for this page, positioned against the fit-width render.
  useEffect(() => {
    if (!canvas || !highlights.length || !contentWidth) {
      setRects([])
      return
    }
    let alive = true
    void (async () => {
      try {
        const pdfPage = await doc.getPage(n)
        const pt = await getPageText(pdfPage, textCache)
        const vp = pdfPage.getViewport({ scale: 1 })
        const cssScale = contentWidth / (vp.width * (crop?.fw ?? 1))
        if (!alive) return
        setRects(
          highlights.flatMap((h) =>
            rangeRects(pdfPage, pt, h.start, h.end, cssScale, crop).map((r) => ({
              id: h.id,
              left: r.left,
              top: r.top,
              w: r.width,
              h: r.height,
            })),
          ),
        )
      } catch {
        if (alive) setRects([])
      }
    })()
    return () => {
      alive = false
    }
  }, [canvas, highlights, n, doc, crop, textCache, contentWidth])

  return (
    <div
      className="absolute left-0 right-0 flex flex-col items-center"
      style={{ top, height }}
    >
      <div className="relative" style={{ width, height }}>
        {/* leaf node for the imperative canvas — React never adds children here */}
        <div ref={hostRef} className="absolute inset-0" />
        {!canvas && (
          <div className="grid h-full w-full place-items-center rounded bg-black/20 text-xs opacity-40">
            {n}
          </div>
        )}
        {canvas &&
          rects.map((r, i) => (
            <div
              key={`${r.id}-${i}`}
              className="pointer-events-none absolute rounded-[2px] bg-accent/[0.22]"
              style={{ left: r.left, top: r.top, width: r.w, height: r.h }}
            />
          ))}
      </div>
    </div>
  )
}
