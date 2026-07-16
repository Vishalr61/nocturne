import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type CropBox, type PDFDocumentProxy, type PDFPageProxy } from '../engine/pdf'
import { Recolorizer } from '../engine/recolor'
import { renderDarkPage } from '../engine/pipeline'
import { classifyPage, type PageClassification } from '../engine/classify'
import { getPageText, rangeRects, type TextCache } from '../engine/search'
import type { Theme } from '../engine/theme'
import { tintOf, type Highlight } from '../storage/db'
import { TextLayer, type TextSelection } from './TextLayer'

// Continuous (scroll) reading. A virtualized vertical strip: every page is a
// fixed-height slot, but only the pages near the viewport hold a rendered
// canvas — the rest are empty spacers of the right height, so a 1700-page book
// costs a handful of canvases, not 1700. Recoloring reuses the exact same
// pipeline as the paged reader (so a page looks identical in either mode); the
// one GL context renders each page in turn and its pixels are blitted into that
// page's own 2D canvas.
//
// Deliberately simpler than paged mode: fit-width, pinch commits on release.
// Unlike paged mode there are no page-turn tap zones to protect, so the text
// layer is ALWAYS active here — no select mode: a long-press (or mouse drag)
// selects text directly, and the selection popover (define/copy/highlight)
// appears. Touch-drag still scrolls; only a deliberate selection gesture
// selects.

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
  onZoom: (zoom: number) => void
  /** Current page (controlled): a jump scrolls here; scrolling reports back. */
  page: number
  onPage: (page: number) => void
  /** Exact strip position to restore on first layout, in page units
   *  (scrollTop/slotHeight). Consumed once; ignored if it disagrees with
   *  `page` by more than a page (stale offset from another mode/device). */
  initialOffset?: number | null
  /** Reports the strip position (page units) as the user scrolls, throttled —
   *  the parent persists it so reopening lands on the exact line. */
  onOffset?: (offset: number) => void
  onToggleChrome: () => void
  textCache: TextCache
  highlights: Highlight[]
  /** A selection made on a page's text layer (null when that page's selection
   *  cleared) — the parent shows the popover and records highlights. */
  onSelect?: (page: number, sel: TextSelection | null) => void
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
  onZoom,
  page,
  onPage,
  initialOffset,
  onOffset,
  onToggleChrome,
  textCache,
  highlights,
  onSelect,
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
  // Restore position captured at mount, consumed by the first layout only.
  const initialOffsetRef = useRef<number | null>(initialOffset ?? null)
  // The strip position in page units — scale-free, so a slot-height change
  // (zoom, rotate, crop box arriving) can re-anchor to the exact spot.
  const lastOffsetPages = useRef<number | null>(null)
  // Trailing throttle for offset reports (a Dexie write per scroll frame is waste).
  const onOffsetRef = useRef(onOffset)
  onOffsetRef.current = onOffset
  const offsetPending = useRef(0)
  const offsetTimer = useRef<number | undefined>(undefined)

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
  // phone that's width-bound, on a wide desktop window height-bound. Zoom scales
  // up from there and is allowed to exceed the viewport width, so on a phone
  // (where fit-page already fills the width) zoom actually enlarges the page;
  // the strip then pans horizontally. (Capping at width made zoom a no-op on
  // phones — the "can't zoom in scroll" bug.)
  const availW = Math.max(0, dims.w - 16)
  const availH = Math.max(0, dims.h - PAGE_GAP)
  const fitPage = aspect ? Math.min(availW, availH / aspect) : availW
  const contentWidth = fitPage * zoom

  const slotHeight = contentWidth && aspect ? contentWidth * aspect + PAGE_GAP : 0
  const slotFor = useCallback(
    (n: number): Slot => ({ top: (n - 1) * slotHeight, height: slotHeight }),
    [slotHeight],
  )

  // Content size changed (zoom/resize): existing canvases are the wrong
  // resolution, so drop them and let the render effect repaint the visible
  // ones. DEBOUNCED: a zoom slider drag or stepper spam fires this per tick,
  // and re-rendering every visible page per tick churned enough canvas memory
  // that iOS jetsam killed the app. The old (soft) canvases stay on screen
  // until the value settles, then one repaint lands. First layout paints
  // immediately — there's nothing on screen yet to keep.
  const paintedWidth = useRef(0)
  useEffect(() => {
    if (!contentWidth) return
    if (paintedWidth.current === 0) {
      paintedWidth.current = contentWidth
      return // initial layout: the render effect below handles it, no delay
    }
    if (paintedWidth.current === contentWidth) return
    const t = window.setTimeout(() => {
      paintedWidth.current = contentWidth
      for (const c of rendered.current.values()) releaseCanvas(c)
      rendered.current.clear()
      redraw()
    }, 180)
    return () => window.clearTimeout(t)
  }, [contentWidth, redraw])

  // A new render context whenever the look changes; the old canvases are stale.
  useEffect(() => {
    for (const c of rendered.current.values()) releaseCanvas(c)
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
    // Track the exact strip position (jumps included — that IS the position),
    // trailing-throttled so persistence isn't hammered per scroll frame.
    offsetPending.current = top / slotHeight
    lastOffsetPages.current = top / slotHeight
    if (offsetTimer.current === undefined) {
      offsetTimer.current = window.setTimeout(() => {
        offsetTimer.current = undefined
        onOffsetRef.current?.(offsetPending.current)
      }, 400)
    }
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

  // Pinch to zoom the whole strip (the natural gesture), committing on release —
  // the page width re-renders and the strip re-anchors to your place.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    let d0 = 0
    let ratio = 1
    let active = false
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      e.preventDefault()
      d0 = dist(e.touches)
      ratio = 1
      active = true
    }
    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 2) return
      e.preventDefault()
      if (d0 > 0) ratio = dist(e.touches) / d0
    }
    const onEnd = () => {
      if (!active) return
      active = false
      if (Math.abs(ratio - 1) > 0.05) {
        onZoom(Math.min(4, Math.max(1, zoom * ratio)))
      }
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
  }, [zoom, onZoom])

  // The one place that scrolls the strip programmatically. Suppresses reporting
  // until the scroll settles, and sets the render window for the destination.
  const scrollToTop = useCallback(
    (top: number) => {
      const scroller = scrollerRef.current
      if (!scroller || !slotHeight) return
      programmaticScroll.current = true
      lastOffsetPages.current = top / slotHeight
      scroller.scrollTo({ top })
      setVisible(windowFor(top))
      window.clearTimeout(releaseRef.current)
      releaseRef.current = window.setTimeout(() => {
        programmaticScroll.current = false
      }, 200)
    },
    [slotHeight, windowFor],
  )
  const scrollToPage = useCallback(
    (p: number) => scrollToTop((p - 1) * slotHeight),
    [slotHeight, scrollToTop],
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
      // Exact-position resume: land on the line you left, not the page top —
      // but only when the saved offset agrees with `page` (it goes stale when
      // paged mode or another device moved the position since).
      const off = initialOffsetRef.current
      initialOffsetRef.current = null // consume once
      const ch = scrollerRef.current?.clientHeight ?? 0
      const offMid =
        off != null ? Math.floor((off * slotHeight + ch / 2) / slotHeight) + 1 : null
      if (off != null && offMid != null && Math.abs(offMid - page) <= 1) {
        scrollToTop(off * slotHeight)
      } else {
        scrollToPage(page)
      }
    } else if (slotChanged) {
      // Re-anchor to the exact fractional spot (page units are scale-free) —
      // snapping to the page top here is what used to lose your place on
      // zoom, rotate, and the async crop-box arrival right after resume.
      const frac = lastOffsetPages.current
      if (frac != null) scrollToTop(frac * slotHeight)
      else scrollToPage(lastReported.current ?? page)
    } else if (page !== lastReported.current) {
      lastReported.current = page
      scrollToPage(page)
    }
  }, [page, slotHeight, scrollToPage, scrollToTop])

  // Evicted canvases go back in a small pool for reuse — allocating a fresh
  // multi-megabyte canvas per page per scroll/zoom leaves a wake of garbage
  // that iOS is slow to reclaim (part of the zoom-spam crash).
  const canvasPool = useRef<HTMLCanvasElement[]>([])
  const releaseCanvas = (c: HTMLCanvasElement) => {
    if (canvasPool.current.length < 6) canvasPool.current.push(c)
  }

  // Render (and evict) canvases to match the visible window. Renders are
  // serialized on one chain because they share the GL + source canvases.
  useEffect(() => {
    if (!contentWidth || !slotHeight || !recolorRef.current) return
    // Evict far pages so memory stays bounded on a phone.
    for (const n of [...rendered.current.keys()]) {
      if (n < visible.from - 1 || n > visible.to + 1) {
        const c = rendered.current.get(n)
        rendered.current.delete(n)
        if (c) releaseCanvas(c)
      }
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
          const out = canvasPool.current.pop() ?? document.createElement('canvas')
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
      // pan-x too so a zoomed (wider-than-screen) page can be panned sideways.
      style={{ touchAction: 'pan-x pan-y' }}
      onClick={() => {
        // One tap anywhere toggles the chrome, both directions — consistency
        // won over the earlier keep-text-taps-quiet rule (tried 2026-07-16;
        // mid-page taps felt dead). The one exception: the click that ends a
        // text selection is part of selecting, not a toggle.
        const s = window.getSelection()
        if (s && !s.isCollapsed) return
        onToggleChrome()
      }}
    >
      {/* One tall spacer establishes the full scroll height; pages are absolutely
          positioned into it so only the visible few exist in the DOM. Its width
          is the (possibly zoomed) page width, centred when it fits and
          horizontally scrollable when it's wider than the screen. */}
      <div
        style={{
          height: pageCount * slotHeight,
          width: contentWidth,
          margin: '0 auto',
          position: 'relative',
        }}
      >
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
            onSelect={onSelect}
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
  onSelect?: (page: number, sel: TextSelection | null) => void
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
  onSelect,
}: PageSlotProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [rects, setRects] = useState<
    { id: string; color?: 'amber' | 'sage'; left: number; top: number; w: number; h: number }[]
  >([])
  // The page proxy + scale for the text layer — the SAME pair the canvas was
  // rendered with (contentWidth / effective width), per the overlay invariant.
  const [layer, setLayer] = useState<{ pdfPage: PDFPageProxy; cssScale: number } | null>(null)

  useEffect(() => {
    if (!canvas || !contentWidth) {
      setLayer(null)
      return
    }
    let alive = true
    void (async () => {
      try {
        const pdfPage = await doc.getPage(n)
        if (!alive) return
        const vp = pdfPage.getViewport({ scale: 1 })
        setLayer({ pdfPage, cssScale: contentWidth / (vp.width * (crop?.fw ?? 1)) })
      } catch {
        if (alive) setLayer(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [canvas, n, doc, crop, contentWidth])

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
              color: h.color,
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
              className="pointer-events-none absolute rounded-[2px]"
              style={{ left: r.left, top: r.top, width: r.w, height: r.h, background: tintOf(r.color) }}
            />
          ))}
        {canvas && layer && onSelect && (
          <TextLayer
            page={layer.pdfPage}
            pageNo={n}
            cssScale={layer.cssScale}
            crop={crop}
            cache={textCache}
            active
            onSelect={(sel) => onSelect(n, sel)}
          />
        )}
      </div>
    </div>
  )
}
