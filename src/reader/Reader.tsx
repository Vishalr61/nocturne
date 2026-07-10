import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampRenderDpr,
  openPdf,
  renderPageToCanvas,
  type CropBox,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from '../engine/pdf'
import { Recolorizer } from '../engine/recolor'
import { THEMES, themeById, DEFAULT_THEME } from '../engine/theme'
import {
  finishDarkPage,
  generateThumbnail,
  renderDarkPage,
  type DarkPageResult,
} from '../engine/pipeline'
import { classifyPage, type PageClassification } from '../engine/classify'
import { detectContentBox } from '../engine/crop'
import { exportDarkPdf, downloadBlob } from '../export/exportPdf'
import {
  getBook,
  getProfile,
  getProgress,
  saveProfile,
  saveProgress,
  saveThumb,
  touchBook,
} from '../storage/db'

// The reader: a saved book, recolored crisply on a canvas. Phone-first:
//   - tap left/right thirds to turn pages, tap the middle to hide/show chrome
//     (immersive reading — the header/footer get out of the way)
//   - pinch to zoom the PAGE (re-rendered vector-crisp at the new scale, then
//     pan by dragging); the zoom slider does the same on desktop
// Position + look are persisted per book, so reopening resumes exactly.

const SAT_CUT = 0.25 // colour threshold; per-page structure decides the rest

interface ReaderProps {
  bookId: string
  onShelf: () => void
}

export function Reader({ bookId, onShelf }: ReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const recolorRef = useRef<Recolorizer | null>(null)
  // Two offscreen canvases, ping-ponged: one holds the displayed page's pdf.js
  // render, the other receives the prefetched next page. Reusing them keeps
  // page turns from allocating (and leaving for GC) tens of MB per turn.
  const sourceRef = useRef<HTMLCanvasElement | null>(null)
  const spareCanvasRef = useRef<HTMLCanvasElement | null>(null)
  /** What sourceRef currently holds; lets theme/slider changes skip pdf.js. */
  const sourceMetaRef = useRef<CachedSource | null>(null)
  /** The pre-rendered next page; a forward turn consumes it (instant turn). */
  const prefetchRef = useRef<(CachedSource & { canvas: HTMLCanvasElement }) | null>(null)
  /** Classification is scale-independent; classify each page once per doc. */
  const clsCacheRef = useRef(new Map<string, PageClassification>())
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const loadedIdRef = useRef<string | null>(null)

  // Bumped when a new document is opened. draw() reads the doc from a ref, so it
  // needs a state dep to fire for a fresh book whose page/zoom/theme match the
  // current values — otherwise the first page never renders.
  const [docVersion, setDocVersion] = useState(0)
  const [title, setTitle] = useState('')
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [themeId, setThemeId] = useState(DEFAULT_THEME.id)
  const [imageDim, setImageDim] = useState(0.82)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState(true)
  const [chrome, setChrome] = useState(true)
  const [cls, setCls] = useState<PageClassification | null>(null)
  const [exporting, setExporting] = useState<number | null>(null) // 0..1 progress
  const [toc, setToc] = useState<TocItem[]>([])
  const [showToc, setShowToc] = useState(false)
  /** Doc-level content box for margin auto-crop; null until detected (or never). */
  const [cropBox, setCropBox] = useState<CropBox | null>(null)
  const [cropMargins, setCropMargins] = useState(true)
  // The page number field edits as free text so typing "150" doesn't jump to
  // page 1 then 15; it commits whenever the text is a valid page.
  const [pageStr, setPageStr] = useState('1')

  // Pinch commit data: applied (then cleared) by the next draw(). px/py is the
  // page point that was under the fingers (canvas CSS coords at the old zoom),
  // scale converts it to the new zoom, mx/my is where the fingers ended.
  const pinchCommitRef = useRef<{
    px: number
    py: number
    scale: number
    mx: number
    my: number
  } | null>(null)

  // --- load the book from local storage -------------------------------------
  useEffect(() => {
    let alive = true
    setBusy(true)
    setToc([]) // don't show the previous book's contents while loading
    setCropBox(null)
    clsCacheRef.current.clear()
    prefetchRef.current = null
    sourceMetaRef.current = null
    void (async () => {
      const book = await getBook(bookId)
      if (!book) {
        onShelf() // deleted elsewhere; nothing to read
        return
      }
      const doc = await openPdf(book.data)
      if (!alive) {
        void doc.destroy()
        return
      }
      docRef.current = doc
      loadedIdRef.current = bookId
      setTitle(book.title)
      setPageCount(doc.numPages)
      void loadOutline(doc).then((items) => {
        if (alive) setToc(items)
      })
      // Detect the book's shared content box in the background; when it lands,
      // the page re-fits with the margins cropped away.
      void detectContentBox(doc).then((box) => {
        if (alive && docRef.current === doc) setCropBox(box)
      })

      const [profile, progress] = await Promise.all([getProfile(bookId), getProgress(bookId)])
      if (!alive) return
      if (profile) {
        setThemeId(profile.themeId)
        setImageDim(profile.imageDim ?? 0.82)
        setZoom(profile.zoom)
        setCropMargins(profile.cropMargins ?? true)
      }
      setPage(progress?.page ?? 1)
      setDocVersion((v) => v + 1)
      setBusy(false)
      void touchBook(bookId)

      // Backfill a shelf thumbnail for books added before thumbnails existed.
      if (!book.thumb) {
        try {
          const thumb = await generateThumbnail(await doc.getPage(1), themeById(profile?.themeId ?? DEFAULT_THEME.id))
          void saveThumb(bookId, thumb)
        } catch {
          /* cosmetic only */
        }
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  // Classification is per page and scale-independent; cache it for the doc.
  const classifyCached = useCallback(
    async (pdfPage: PDFPageProxy, pageNo: number): Promise<PageClassification> => {
      const key = `${docVersion}:${pageNo}`
      const hit = clsCacheRef.current.get(key)
      if (hit) return hit
      const cls = await classifyPage(pdfPage)
      clsCacheRef.current.set(key, cls)
      return cls
    },
    [docVersion],
  )

  // --- render the current page ----------------------------------------------
  const draw = useCallback(async () => {
    const doc = docRef.current
    const canvas = canvasRef.current
    const scroller = containerRef.current
    if (!doc || !canvas) return
    if (!recolorRef.current) recolorRef.current = new Recolorizer(canvas)
    if (!sourceRef.current) sourceRef.current = document.createElement('canvas')

    const pdfPage = await doc.getPage(page)
    const cls = await classifyCached(pdfPage, page)

    // Fit-page base scale: at zoom=1 the whole page is visible — width-bound on
    // phones (same as the old fit-width), usually height-bound on landscape
    // desktop windows, which used to overflow with no way to zoom out. The
    // canvas is displayed at its own CSS size (set below) so 1 backing pixel =
    // 1 device pixel — the browser never rescales the render (that rescale = blur).
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const pageVp = pdfPage.getViewport({ scale: 1 })
    // Margin crop applies to the fit, but never to full-bleed pages (covers,
    // photo plates) — slicing their edges is worse than small margins.
    const crop = cropMargins && !isFullBleed(cls, pageVp) ? cropBox : null
    const effW = pageVp.width * (crop?.fw ?? 1)
    const effH = pageVp.height * (crop?.fh ?? 1)
    const availW = scroller ? scroller.clientWidth - 16 : effW // p-2 padding
    const availH = scroller ? scroller.clientHeight - 16 : effH
    const cssScale = Math.max(0.1, Math.min(availW / effW, availH / effH)) * zoom

    const opts = { theme: themeById(themeId), satCut: SAT_CUT, imageDim, crop }
    const matches = (m: CachedSource): boolean =>
      m.pageNo === page &&
      m.docVersion === docVersion &&
      m.dpr === dpr &&
      m.crop === crop &&
      Math.abs(m.cssScale - cssScale) < 1e-6

    // Three paths, cheapest first. The pipeline decides polarity, image
    // masking, and colour-text handling per page either way; it may clamp the
    // dpr to keep the canvas inside iOS's memory budget (extreme zoom).
    const meta = sourceMetaRef.current
    const pf = prefetchRef.current
    let result: DarkPageResult
    if (meta && matches(meta) && sourceRef.current.width > 0) {
      // Same source pixels (theme/brightness tweak, GL context recovery):
      // GPU recolor only, no pdf.js render.
      result = finishDarkPage(
        pdfPage,
        sourceRef.current,
        meta.cls,
        cssScale * meta.safeDpr,
        meta.safeDpr,
        recolorRef.current,
        opts,
      )
    } else if (pf && matches(pf)) {
      // Prefetched while reading the previous page: swap canvases and recolor.
      // This is what makes forward page turns feel instant.
      prefetchRef.current = null
      spareCanvasRef.current = sourceRef.current
      sourceRef.current = pf.canvas
      sourceMetaRef.current = {
        pageNo: pf.pageNo,
        cssScale: pf.cssScale,
        dpr: pf.dpr,
        docVersion: pf.docVersion,
        crop: pf.crop,
        cls: pf.cls,
        safeDpr: pf.safeDpr,
      }
      result = finishDarkPage(
        pdfPage,
        pf.canvas,
        pf.cls,
        cssScale * pf.safeDpr,
        pf.safeDpr,
        recolorRef.current,
        opts,
      )
    } else {
      const full = { ...opts, cls, sourceCanvas: sourceRef.current }
      try {
        result = await renderDarkPage(pdfPage, cssScale, dpr, recolorRef.current, full)
      } catch {
        // Transient render collisions (background crop detection touching the
        // same page) resolve on retry; a second failure surfaces to the chain.
        await new Promise((r) => setTimeout(r, 250))
        result = await renderDarkPage(pdfPage, cssScale, dpr, recolorRef.current, full)
      }
      sourceMetaRef.current = { pageNo: page, cssScale, dpr, docVersion, crop, cls, safeDpr: result.dpr }
    }

    setCls(result.cls)
    // Display exactly at render resolution; when zoom > 1 the canvas overflows
    // the container and overflow-auto provides panning. If the dpr was clamped,
    // the CSS size still honours the requested zoom (slightly soft beats a crash).
    canvas.style.width = `${result.source.width / result.dpr}px`
    canvas.style.height = `${result.source.height / result.dpr}px`
    canvas.style.transform = '' // clear any live pinch preview

    // Keep the pinch focal point where the fingers ended: measure the freshly
    // laid-out canvas and scroll so the page point that was under the fingers
    // lands exactly where they were — exact regardless of centering or padding.
    const commit = pinchCommitRef.current
    if (commit && scroller) {
      pinchCommitRef.current = null
      const rect = canvas.getBoundingClientRect()
      scroller.scrollLeft += rect.left + commit.scale * commit.px - commit.mx
      scroller.scrollTop += rect.top + commit.scale * commit.py - commit.my
    }
  }, [page, zoom, themeId, imageDim, docVersion, cropBox, cropMargins, classifyCached])

  // Pre-render the next page into the spare canvas while the current one is
  // read, so a forward turn is just a canvas swap + GPU recolor. Runs on the
  // draw chain (after the draw it follows), so it never races the shared
  // canvases, and a newer draw supersedes it before it starts.
  const prefetchNext = useCallback(async () => {
    const doc = docRef.current
    const scroller = containerRef.current
    if (!doc || !scroller) return
    const nextNo = page + 1
    if (nextNo > doc.numPages) return
    try {
      const nextPage = await doc.getPage(nextNo)
      const cls = await classifyCached(nextPage, nextNo)
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      const vp = nextPage.getViewport({ scale: 1 })
      const crop = cropMargins && !isFullBleed(cls, vp) ? cropBox : null
      const effW = vp.width * (crop?.fw ?? 1)
      const effH = vp.height * (crop?.fh ?? 1)
      const cssScale =
        Math.max(
          0.1,
          Math.min((scroller.clientWidth - 16) / effW, (scroller.clientHeight - 16) / effH),
        ) * zoom
      const pf = prefetchRef.current
      if (
        pf &&
        pf.pageNo === nextNo &&
        pf.docVersion === docVersion &&
        pf.dpr === dpr &&
        pf.crop === crop &&
        Math.abs(pf.cssScale - cssScale) < 1e-6
      ) {
        return // already prefetched at these exact settings
      }
      const safeDpr = clampRenderDpr(nextPage, cssScale, dpr, crop)
      if (!spareCanvasRef.current) spareCanvasRef.current = document.createElement('canvas')
      const canvas = await renderPageToCanvas(nextPage, cssScale, safeDpr, spareCanvasRef.current, crop)
      prefetchRef.current = { pageNo: nextNo, cssScale, dpr, docVersion, crop, cls, safeDpr, canvas }
    } catch {
      /* prefetch is best-effort */
    }
  }, [page, zoom, docVersion, cropBox, cropMargins, classifyCached])

  // Draws are serialized: pdf.js render and the GL pass each reuse one canvas,
  // and two in-flight draws would interleave into garbage. Rapid page turns
  // supersede queued-but-not-started draws, so only the latest page renders.
  const drawChainRef = useRef<Promise<void>>(Promise.resolve())
  const drawSeqRef = useRef(0)
  const enqueueDraw = useCallback(() => {
    const seq = ++drawSeqRef.current
    drawChainRef.current = drawChainRef.current
      .then(() => (seq === drawSeqRef.current ? draw() : undefined))
      .then(() => (seq === drawSeqRef.current ? prefetchNext() : undefined))
      .catch(() => undefined) // a failed draw must not stall the chain
  }, [draw, prefetchNext])

  useEffect(() => {
    enqueueDraw()
  }, [enqueueDraw])

  // Refit whenever the container resizes for any reason — rotation, window
  // resize, immersive chrome toggling (that changes the height fit-page uses).
  useEffect(() => {
    const scroller = containerRef.current
    if (!scroller) return
    const ro = new ResizeObserver(enqueueDraw)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [enqueueDraw])

  // iOS kills WebGL contexts under memory pressure or when the PWA is
  // backgrounded. Without these handlers the canvas stays black until a manual
  // reload — which reads as a crash. preventDefault on "lost" is what tells the
  // browser we want "restored" to fire; then we rebuild the GL state and redraw.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onLost = (e: Event) => e.preventDefault()
    const onRestored = () => {
      recolorRef.current = null // program/textures died with the old context
      enqueueDraw()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [enqueueDraw])

  // --- pinch to zoom ----------------------------------------------------------
  // The live preview must do what real pinches do: keep the page point that was
  // under the fingers pinned to the fingers as they both spread AND move. So the
  // gesture is measured once at start (untransformed canvas rect, midpoint,
  // finger distance) and every move solves the translate+scale that maps the
  // start point to the current midpoint. The old version recomputed its focal
  // point from the already-transformed canvas each move, which made the anchor
  // drift — the "doesn't feel right" wobble.
  useEffect(() => {
    const scroller = containerRef.current
    const canvas = canvasRef.current
    if (!scroller || !canvas) return

    let active = false
    let startZoom = zoom
    let rect0 = { left: 0, top: 0 } // canvas position at gesture start
    let d0 = 1 // finger distance at start
    let f = 1 // clamped scale factor this gesture
    let m0 = { x: 0, y: 0 } // midpoint at start (viewport coords)
    let mNow = { x: 0, y: 0 }

    const mid = (t: TouchList) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    })
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      e.preventDefault() // stop the browser zooming the whole app
      canvas.style.transform = '' // measure the untransformed canvas
      const r = canvas.getBoundingClientRect()
      rect0 = { left: r.left, top: r.top }
      m0 = mNow = mid(e.touches)
      d0 = dist(e.touches)
      startZoom = zoom
      f = 1
      active = true
      canvas.style.transformOrigin = '0 0'
      canvas.style.willChange = 'transform'
    }

    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 2) return
      e.preventDefault()
      mNow = mid(e.touches)
      // Clamp the preview to what the commit will allow (zoom 1..4).
      f = Math.min(4, Math.max(1, startZoom * (dist(e.touches) / d0))) / startZoom
      // With origin 0 0, the transform maps canvas point p to translate + f·p:
      // solve for the translate that puts the start point at the live midpoint.
      const tx = mNow.x - rect0.left - f * (m0.x - rect0.left)
      const ty = mNow.y - rect0.top - f * (m0.y - rect0.top)
      canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${f})`
    }

    const onEnd = (e: TouchEvent) => {
      if (!active || e.touches.length >= 2) return
      active = false
      canvas.style.willChange = ''
      const next = startZoom * f
      const commit = {
        px: m0.x - rect0.left,
        py: m0.y - rect0.top,
        scale: f,
        mx: mNow.x,
        my: mNow.y,
      }
      if (Math.abs(next - zoom) < 0.02) {
        // Zoom effectively unchanged (tiny pinch, or panning while clamped at
        // 1x/4x): no re-render — apply the pan straight to the scroll position.
        canvas.style.transform = ''
        const r = canvas.getBoundingClientRect()
        scroller.scrollLeft += r.left + commit.px - commit.mx
        scroller.scrollTop += r.top + commit.py - commit.my
        return
      }
      pinchCommitRef.current = commit
      setZoom(next) // crisp re-render; draw() applies the commit and clears the preview
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
  }, [zoom])

  // --- persist look + position -------------------------------------------------
  useEffect(() => {
    const id = loadedIdRef.current
    if (!id) return
    void saveProfile({ bookId: id, themeId, satCut: SAT_CUT, strength: 1, zoom, imageDim, cropMargins })
    void saveProgress({
      bookId: id,
      page,
      percent: pageCount ? page / pageCount : 0,
      updatedAt: Date.now(),
    })
  }, [themeId, imageDim, zoom, page, pageCount, cropMargins])

  const turn = (delta: number) =>
    setPage((p) => Math.min(pageCount || 1, Math.max(1, p + delta)))

  // Keep the editable page field in sync when the page changes any other way.
  useEffect(() => {
    setPageStr(String(page))
  }, [page])

  const onPageInput = (v: string) => {
    setPageStr(v)
    const n = Number(v)
    if (Number.isInteger(n) && n >= 1 && n <= (pageCount || 1)) setPage(n)
  }

  const onExport = useCallback(async () => {
    const doc = docRef.current
    if (!doc) return
    setExporting(0)
    try {
      const blob = await exportDarkPdf(doc, {
        theme: themeById(themeId),
        satCut: SAT_CUT,
        onProgress: (done, total) => setExporting(done / total),
      })
      downloadBlob(blob, `${title || 'nocturne'} (dark).pdf`)
    } finally {
      setExporting(null)
    }
  }, [themeId, title])

  return (
    <div className="relative flex h-full flex-col bg-night-950 text-neutral-200">
      {chrome && (
        <header className="flex items-center gap-3 px-4 py-3 text-sm">
          <button
            className="rounded-md bg-night-700 px-3 py-1.5 text-neutral-200 hover:bg-night-800"
            onClick={onShelf}
          >
            ‹ Library
          </button>
          <span className="truncate text-neutral-400">{title}</span>
        </header>
      )}

      <div
        ref={containerRef}
        className="relative flex-1 overflow-auto"
        style={{ touchAction: 'pan-x pan-y' }}
      >
        {/* Tap zones: left/right thirds turn pages, the middle toggles chrome. */}
        <button
          aria-label="Previous page"
          className="absolute inset-y-0 left-0 z-10 w-1/3"
          onClick={() => turn(-1)}
        />
        <button
          aria-label="Toggle controls"
          className="absolute inset-x-1/3 inset-y-0 z-10"
          onClick={() => setChrome((c) => !c)}
        />
        <button
          aria-label="Next page"
          className="absolute inset-y-0 right-0 z-10 w-1/3"
          onClick={() => turn(1)}
        />
        {/* m-auto centres the canvas when it fits and lets overflow-auto pan from
            the true left edge when zoomed (flex justify-center would clip it). */}
        <div className="flex min-h-full min-w-full p-2">
          <canvas ref={canvasRef} className="m-auto rounded shadow-2xl" />
        </div>
        {busy && (
          <div className="absolute inset-0 grid place-items-center text-neutral-400">Loading…</div>
        )}
      </div>

      {chrome && (
        <footer className="flex flex-wrap items-center gap-3 border-t border-night-800 px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <button className="rounded bg-night-700 px-2 py-1" onClick={() => turn(-1)}>
              ‹
            </button>
            <input
              aria-label="Page number"
              type="text"
              inputMode="numeric"
              className="w-12 rounded bg-night-700 px-1 py-1 text-center tabular-nums"
              value={pageStr}
              onChange={(e) => onPageInput(e.target.value)}
              onBlur={() => setPageStr(String(page))}
            />
            <span className="tabular-nums text-neutral-500">/ {pageCount || '—'}</span>
            <button className="rounded bg-night-700 px-2 py-1" onClick={() => turn(1)}>
              ›
            </button>
          </div>

          {pageCount > 1 && (
            <input
              aria-label="Go to page"
              type="range"
              min={1}
              max={pageCount}
              step={1}
              value={page}
              onChange={(e) => setPage(Number(e.target.value))}
              className="min-w-[120px] flex-1"
            />
          )}

          {toc.length > 0 && (
            <button
              className="rounded bg-night-700 px-3 py-1 text-neutral-200 hover:bg-night-800"
              onClick={() => setShowToc(true)}
            >
              Contents
            </button>
          )}

          <select
            className="rounded bg-night-700 px-2 py-1"
            value={themeId}
            onChange={(e) => setThemeId(e.target.value)}
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-neutral-400">
            Images
            <input
              type="range"
              min={0.4}
              max={1}
              step={0.02}
              value={imageDim}
              onChange={(e) => setImageDim(Number(e.target.value))}
            />
          </label>

          {cropBox && (
            <label className="flex items-center gap-1.5 text-neutral-400">
              <input
                type="checkbox"
                checked={cropMargins}
                onChange={(e) => setCropMargins(e.target.checked)}
              />
              Crop
            </label>
          )}

          <label className="flex items-center gap-2 text-neutral-400">
            Zoom
            <input
              type="range"
              min={1}
              max={4}
              step={0.1}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>

          <button
            className="rounded bg-night-700 px-3 py-1 text-neutral-200 hover:bg-night-800 disabled:opacity-50"
            disabled={!pageCount || exporting !== null}
            onClick={onExport}
          >
            {exporting !== null ? `Exporting ${Math.round(exporting * 100)}%` : 'Export dark PDF'}
          </button>

          {cls && <span className="ml-auto text-xs text-neutral-600">page: {cls.kind}</span>}
        </footer>
      )}

      {showToc && (
        <div className="absolute inset-0 z-20 flex flex-col bg-night-950/95">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm font-medium">Contents</span>
            <button
              className="rounded bg-night-700 px-3 py-1 text-sm"
              onClick={() => setShowToc(false)}
            >
              Close
            </button>
          </div>
          <div className="flex-1 overflow-auto px-2 pb-6">
            {toc.map((t, i) => (
              <button
                key={i}
                className="flex w-full items-baseline justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-night-800"
                style={{ paddingLeft: `${8 + t.depth * 16}px` }}
                onClick={() => {
                  setPage(t.page)
                  setShowToc(false)
                }}
              >
                <span className="truncate">{t.title}</span>
                <span className="tabular-nums text-neutral-500">{t.page}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface TocItem {
  title: string
  page: number
  depth: number
}

/** Everything that pins a rendered source canvas to specific settings. */
interface CachedSource {
  pageNo: number
  cssScale: number
  dpr: number
  docVersion: number
  crop: CropBox | null
  cls: PageClassification
  safeDpr: number
}

/** A page that IS an image (cover, scan, photo plate) must never be cropped. */
function isFullBleed(cls: PageClassification, vp: { width: number; height: number }): boolean {
  return (
    cls.kind === 'scanned' ||
    cls.imageRects.some((r) => r.w * r.h >= 0.85 * vp.width * vp.height)
  )
}

interface OutlineNode {
  title: string
  dest: unknown
  items?: OutlineNode[]
}

/**
 * Flatten the PDF's outline (bookmarks) into a jumpable chapter list. Each
 * entry's destination is resolved to a page index; entries that don't point
 * anywhere usable are skipped. Books without an outline return [] and the
 * Contents button simply doesn't appear.
 */
async function loadOutline(doc: PDFDocumentProxy): Promise<TocItem[]> {
  const out: TocItem[] = []
  const walk = async (items: OutlineNode[], depth: number) => {
    for (const it of items) {
      try {
        let dest = it.dest
        if (typeof dest === 'string') dest = await doc.getDestination(dest)
        if (Array.isArray(dest) && dest[0]) {
          const ref = dest[0] as { num: number; gen: number }
          out.push({ title: it.title, page: (await doc.getPageIndex(ref)) + 1, depth })
        }
      } catch {
        /* unnavigable entry; skip it */
      }
      if (it.items?.length && depth < 2) await walk(it.items, depth + 1)
    }
  }
  const root = (await doc.getOutline()) as OutlineNode[] | null
  if (root) await walk(root, 0)
  return out
}
