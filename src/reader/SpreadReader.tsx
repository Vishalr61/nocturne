import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type CropBox, type PDFDocumentProxy } from '../engine/pdf'
import { Recolorizer } from '../engine/recolor'
import { renderDarkPage } from '../engine/pipeline'
import { classifyPage, type PageClassification } from '../engine/classify'
import { getPageText, rangeRects, type TextCache } from '../engine/search'
import type { Theme } from '../engine/theme'
import { tintOf, type Highlight } from '../storage/db'

// Two-page spread for landscape: an open-book view (left = current page, right =
// the next), turning two at a time. Like the scroll reader it reuses the exact
// paged pipeline via one shared GL context blitted into each page's own canvas,
// so a page looks identical to single-page mode. No pinch / text selection here
// (those live in single-page paged mode); saved highlights are still shown.

const GAP = 16 // px between the two pages
const dpr = () => Math.min(window.devicePixelRatio || 1, 3)
const hapticsEnabled = () => {
  try {
    return localStorage.getItem('nocturne-haptics') !== '0'
  } catch {
    return true
  }
}

interface SpreadReaderProps {
  doc: PDFDocumentProxy
  pageCount: number
  theme: Theme
  satCut: number
  imageDim: number
  crop: CropBox | null
  /** The LEFT page of the spread (controlled by tap-to-turn). */
  page: number
  onPage: (page: number) => void
  onToggleChrome: () => void
  textCache: TextCache
  highlights: Highlight[]
  renderKey: string
}

export function SpreadReader({
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
}: SpreadReaderProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const recolorRef = useRef<Recolorizer | null>(null)
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendered = useRef(new Map<number, HTMLCanvasElement>())
  const clsCache = useRef(new Map<number, PageClassification>())
  const renderChain = useRef<Promise<void>>(Promise.resolve())

  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [aspect, setAspect] = useState(0)
  const [, force] = useState(0)
  const redraw = useCallback(() => force((n) => n + 1), [])

  // The spread's two page numbers: left = current, right = the following page
  // (absent past the end, so the last odd page sits alone on the left).
  const leftNo = Math.min(Math.max(1, page), pageCount)
  const rightNo = leftNo + 1 <= pageCount ? leftNo + 1 : null

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setDims({ w: host.clientWidth, h: host.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    void doc.getPage(1).then((p) => {
      if (!alive) return
      const vp = p.getViewport({ scale: 1 })
      setAspect(crop ? (vp.height * crop.fh) / (vp.width * crop.fw) : vp.height / vp.width)
    })
    return () => {
      alive = false
    }
  }, [doc, crop])

  // Each page fills half the width, but no taller than the viewport — so the
  // whole open book is visible at once (that's the point of the landscape view).
  const availW = Math.max(0, dims.w - 32)
  const availH = Math.max(0, dims.h - 24)
  const pageWidth = aspect ? Math.min((availW - GAP) / 2, availH / aspect) : 0
  const pageHeight = pageWidth * aspect

  // Shared offscreen GL recolorizer.
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

  // Stale renders when the look or page size changes.
  useEffect(() => {
    rendered.current.clear()
    clsCache.current.clear()
    redraw()
  }, [renderKey, pageWidth, redraw])

  // Render the spread's pages (and the next spread, so a forward turn is
  // instant), evicting anything outside a small window.
  useEffect(() => {
    if (!pageWidth || !recolorRef.current) return
    const wanted = [leftNo, rightNo, leftNo + 2, leftNo + 3].filter(
      (n): n is number => n !== null && n >= 1 && n <= pageCount,
    )
    for (const n of [...rendered.current.keys()]) {
      if (n < leftNo - 2 || n > leftNo + 3) rendered.current.delete(n)
    }
    for (const n of wanted) {
      if (rendered.current.has(n)) continue
      renderChain.current = renderChain.current
        .then(async () => {
          if (rendered.current.has(n)) return
          const recolor = recolorRef.current
          if (!recolor) return
          const pdfPage = await doc.getPage(n)
          let cls = clsCache.current.get(n)
          if (!cls) {
            cls = await classifyPage(pdfPage)
            clsCache.current.set(n, cls)
          }
          const vp = pdfPage.getViewport({ scale: 1 })
          const cssScale = pageWidth / (vp.width * (crop?.fw ?? 1))
          await renderDarkPage(pdfPage, cssScale, dpr(), recolor, {
            theme,
            satCut,
            imageDim,
            crop,
            cls,
            sourceCanvas: srcCanvasRef.current ?? undefined,
          })
          const gl = glCanvasRef.current!
          const out = document.createElement('canvas')
          out.width = gl.width
          out.height = gl.height
          out.getContext('2d')!.drawImage(gl, 0, 0)
          rendered.current.set(n, out)
          redraw()
        })
        .catch(() => undefined)
    }
  }, [leftNo, rightNo, pageWidth, doc, theme, satCut, imageDim, crop, pageCount, renderKey, redraw])

  const turn = (delta: number) => {
    const next = Math.min(pageCount, Math.max(1, leftNo + delta))
    if (next !== leftNo) {
      onPage(next)
      // Faint tick where the platform supports it (silent on iOS Safari).
      if (hapticsEnabled() && typeof navigator.vibrate === 'function') navigator.vibrate(8)
    }
  }

  // Single-finger horizontal swipe turns the spread (two pages at a time).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let x0 = 0
    let y0 = 0
    let t0 = 0
    let tracking = false
    const onStart = (e: TouchEvent) => {
      tracking = e.touches.length === 1
      if (!tracking) return
      x0 = e.touches[0].clientX
      y0 = e.touches[0].clientY
      t0 = e.timeStamp
    }
    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return
      const dx = e.touches[0].clientX - x0
      const dy = e.touches[0].clientY - y0
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) e.preventDefault()
    }
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return
      tracking = false
      const t = e.changedTouches[0]
      const dx = t.clientX - x0
      const dy = t.clientY - y0
      if (e.timeStamp - t0 < 600 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        turn(dx < 0 ? 2 : -2)
      }
    }
    host.addEventListener('touchstart', onStart, { passive: true })
    host.addEventListener('touchmove', onMove, { passive: false })
    host.addEventListener('touchend', onEnd)
    return () => {
      host.removeEventListener('touchstart', onStart)
      host.removeEventListener('touchmove', onMove)
      host.removeEventListener('touchend', onEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftNo, pageCount])

  return (
    <div ref={hostRef} className="relative flex-1 overflow-hidden">
      {/* Tap zones: left third back a spread, right third forward, centre chrome. */}
      <button
        aria-label="Previous pages"
        className="absolute inset-y-0 left-0 z-10 w-1/4"
        onClick={() => turn(-2)}
      />
      <button
        aria-label="Toggle controls"
        className="absolute inset-x-1/4 inset-y-0 z-10"
        onClick={onToggleChrome}
      />
      <button
        aria-label="Next pages"
        className="absolute inset-y-0 right-0 z-10 w-1/4"
        onClick={() => turn(2)}
      />

      <div className="flex h-full w-full items-center justify-center" style={{ gap: GAP }}>
        {pageWidth > 0 && (
          <>
            <Leaf
              n={leftNo}
              width={pageWidth}
              height={pageHeight}
              canvas={rendered.current.get(leftNo) ?? null}
              highlights={highlights.filter((h) => h.page === leftNo)}
              doc={doc}
              crop={crop}
              textCache={textCache}
            />
            {rightNo && (
              <Leaf
                n={rightNo}
                width={pageWidth}
                height={pageHeight}
                canvas={rendered.current.get(rightNo) ?? null}
                highlights={highlights.filter((h) => h.page === rightNo)}
                doc={doc}
                crop={crop}
                textCache={textCache}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface LeafProps {
  n: number
  width: number
  height: number
  canvas: HTMLCanvasElement | null
  highlights: Highlight[]
  doc: PDFDocumentProxy
  crop: CropBox | null
  textCache: TextCache
}

function Leaf({ n, width, height, canvas, highlights, doc, crop, textCache }: LeafProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [rects, setRects] = useState<
    { id: string; color?: 'amber' | 'sage'; left: number; top: number; w: number; h: number }[]
  >([])

  // Mount the parent-owned canvas into a dedicated leaf node (never mixing
  // manual DOM with React children on one node — that crashes reconciliation).
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

  useEffect(() => {
    if (!canvas || !highlights.length || !width) {
      setRects([])
      return
    }
    let alive = true
    void (async () => {
      try {
        const pdfPage = await doc.getPage(n)
        const pt = await getPageText(pdfPage, textCache)
        const vp = pdfPage.getViewport({ scale: 1 })
        const cssScale = width / (vp.width * (crop?.fw ?? 1))
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
  }, [canvas, highlights, n, doc, crop, textCache, width])

  return (
    <div className="relative" style={{ width, height }}>
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
    </div>
  )
}
