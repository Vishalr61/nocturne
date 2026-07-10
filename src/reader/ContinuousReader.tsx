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
  const programmaticScroll = useRef(false)

  const [contentWidth, setContentWidth] = useState(0)
  const [aspect, setAspect] = useState(0) // page height / width, uniform estimate
  const [visible, setVisible] = useState<{ from: number; to: number }>({ from: 1, to: 1 })
  const [, force] = useState(0)
  const redraw = useCallback(() => force((n) => n + 1), [])

  // Measure the container and the book's page aspect (page 1 — books are
  // near-always uniform, which makes slot heights exact and jumps land true).
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => setContentWidth(Math.max(0, scroller.clientWidth - 16))
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

  const slotHeight = contentWidth && aspect ? contentWidth * aspect + PAGE_GAP : 0
  const slotFor = useCallback(
    (n: number): Slot => ({ top: (n - 1) * slotHeight, height: slotHeight }),
    [slotHeight],
  )

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

  // Recompute which pages are near the viewport, and report the current page.
  const recompute = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !slotHeight) return
    const top = scroller.scrollTop
    const mid = top + scroller.clientHeight / 2
    const current = Math.min(pageCount, Math.max(1, Math.floor(mid / slotHeight) + 1))
    if (!programmaticScroll.current) onPage(current)
    const first = Math.max(1, Math.floor(top / slotHeight) + 1 - RENDER_BUFFER)
    const last = Math.min(
      pageCount,
      Math.floor((top + scroller.clientHeight) / slotHeight) + 1 + RENDER_BUFFER,
    )
    setVisible((v) => (v.from === first && v.to === last ? v : { from: first, to: last }))
  }, [slotHeight, pageCount, onPage])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onScroll = () => recompute()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    recompute()
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [recompute])

  // Jump: when the controlled page changes and it's off-screen, scroll to it.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !slotHeight) return
    const target = (page - 1) * slotHeight
    // Only scroll if we're not already showing that page (avoids fighting the
    // user's own scroll, which reports the page back up).
    if (Math.abs(scroller.scrollTop - target) < scroller.clientHeight * 0.4) return
    programmaticScroll.current = true
    scroller.scrollTo({ top: target })
    // Release after the scroll settles so recompute stops suppressing reports.
    const t = setTimeout(() => {
      programmaticScroll.current = false
      recompute()
    }, 120)
    return () => clearTimeout(t)
  }, [page, slotHeight, recompute])

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
