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
import {
  getPageText,
  matchRectsOnPage,
  rangeRects,
  searchBook,
  type HighlightRect,
  type SearchHit,
  type TextCache,
} from '../engine/search'
import { TextLayer, type TextSelection } from './TextLayer'
import { ContinuousReader } from './ContinuousReader'
import { SpreadReader } from './SpreadReader'
import { exportDarkPdf, downloadBlob } from '../export/exportPdf'
import {
  addBookmark,
  addHighlight,
  getBook,
  getProfile,
  getProgress,
  listBookmarks,
  listHighlights,
  removeBookmark,
  removeHighlight,
  setBookmarkNote,
  saveProfile,
  saveProgress,
  saveThumb,
  touchBook,
  type Bookmark,
  type Highlight,
} from '../storage/db'

// The reader: a saved book, recolored crisply on a canvas. Phone-first:
//   - tap left/right thirds to turn pages, tap the middle to hide/show chrome
//     (immersive reading — the header/footer get out of the way)
//   - pinch to zoom the PAGE (re-rendered vector-crisp at the new scale, then
//     pan by dragging); the zoom slider does the same on desktop
// Position + look are persisted per book, so reopening resumes exactly.

const SAT_CUT = 0.25 // colour threshold; per-page structure decides the rest

/** Stable empty array so clearing highlights never triggers a needless render. */
const NO_HIGHLIGHTS: HighlightRect[] = []

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
  /** Extracted page text, reused by search and highlighting. */
  const textCacheRef = useRef<TextCache>(new Map())
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
  const [showSettings, setShowSettings] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [scanned, setScanned] = useState(0)
  /** The query whose matches are highlighted on the page (survives closing the panel). */
  const [highlightQuery, setHighlightQuery] = useState('')
  const [highlights, setHighlights] = useState<HighlightRect[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  /** Page whose bookmark note is being edited in the Contents list, and the draft. */
  const [noteFor, setNoteFor] = useState<number | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [marks, setMarks] = useState<Highlight[]>([]) // saved highlights, this book
  const [markRects, setMarkRects] = useState<{ id: string; rects: HighlightRect[] }[]>([])
  /** Select mode: while on, the text layer takes taps so you can select/copy. */
  const [selectMode, setSelectMode] = useState(false)
  const [selection, setSelection] = useState<TextSelection | null>(null)
  /**
   * The page and the geometry it was drawn with, published together. These must
   * never be separate pieces of state: a render where the page number had moved
   * on but the page proxy hadn't produced text-layer boxes for the wrong page.
   */
  const [view, setView] = useState<{
    pdfPage: PDFPageProxy
    pageNo: number
    cssScale: number
    crop: CropBox | null
  } | null>(null)
  /** Doc-level content box for margin auto-crop; null until detected (or never). */
  const [cropBox, setCropBox] = useState<CropBox | null>(null)
  const [cropMargins, setCropMargins] = useState(true)
  const [viewMode, setViewMode] = useState<'paged' | 'scroll'>('paged')
  const [spread, setSpread] = useState(true)
  const [landscape, setLandscape] = useState(
    typeof window !== 'undefined' && window.innerWidth > window.innerHeight,
  )
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
    setBookmarks([])
    setMarks([])
    setMarkRects([])
    setView(null)
    setCropBox(null)
    clsCacheRef.current.clear()
    textCacheRef.current.clear()
    setHighlightQuery('')
    setHighlights([])
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
      void listBookmarks(bookId).then((bs) => {
        if (alive) setBookmarks(bs)
      })
      void listHighlights(bookId).then((hs) => {
        if (alive) setMarks(hs)
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
        setViewMode(profile.viewMode ?? 'paged')
        setSpread(profile.spread ?? true)
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

  // Track orientation so the two-page spread turns on in landscape.
  useEffect(() => {
    const onResize = () => setLandscape(window.innerWidth > window.innerHeight)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  // The two-page spread replaces the single-page canvas only in paged mode, in
  // landscape, with the setting on. Scroll mode is always single-column.
  const spreadActive = viewMode === 'paged' && spread && landscape

  // --- render the current page ----------------------------------------------
  const draw = useCallback(async () => {
    // Scroll and spread each own their rendering; the single-page canvas stays
    // hidden and must not re-render underneath them.
    if (viewMode === 'scroll' || spreadActive) return
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
    // Publish the page together with the exact geometry it was rendered at. The
    // text layer and every highlight box derive from this one object.
    setView((v) =>
      v && v.pdfPage === pdfPage && v.cssScale === cssScale && v.crop === crop
        ? v
        : { pdfPage, pageNo: page, cssScale, crop },
    )
    // Display exactly at render resolution; when zoom > 1 the canvas overflows
    // the container and overflow-auto provides panning. If the dpr was clamped,
    // the CSS size still honours the requested zoom (slightly soft beats a crash).
    canvas.style.width = `${result.source.width / result.dpr}px`
    canvas.style.height = `${result.source.height / result.dpr}px`
    canvas.style.transform = '' // clear any live pinch preview

    // Search highlights are positioned against this exact render. NO_HIGHLIGHTS
    // is a stable reference, so clearing twice doesn't re-render.
    if (highlightQuery) {
      try {
        setHighlights(
          await matchRectsOnPage(pdfPage, highlightQuery, textCacheRef.current, cssScale, crop),
        )
      } catch {
        setHighlights(NO_HIGHLIGHTS)
      }
    } else {
      setHighlights(NO_HIGHLIGHTS)
    }

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
  }, [page, zoom, themeId, imageDim, docVersion, cropBox, cropMargins, classifyCached, highlightQuery, viewMode, spreadActive])

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
    void saveProfile({ bookId: id, themeId, satCut: SAT_CUT, strength: 1, zoom, imageDim, cropMargins, viewMode, spread })
    void saveProgress({
      bookId: id,
      page,
      percent: pageCount ? page / pageCount : 0,
      updatedAt: Date.now(),
    })
  }, [themeId, imageDim, zoom, page, pageCount, cropMargins, viewMode, spread])

  const turn = (delta: number) =>
    setPage((p) => Math.min(pageCount || 1, Math.max(1, p + delta)))

  // Real keyboard nav on desktop: ←/→ turn pages; Esc closes whatever is on
  // top (settings, contents) and finally returns to the library.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F takes over the browser's find, which can't see a canvas anyway.
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
        return
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowLeft') turn(-1)
      else if (e.key === 'ArrowRight') turn(1)
      else if (e.key === 'Escape') {
        if (showSearch) setShowSearch(false)
        else if (showSettings) setShowSettings(false)
        else if (showToc) setShowToc(false)
        else if (selectMode) {
          setSelectMode(false)
          setSelection(null)
        } else if (highlightQuery) setHighlightQuery('')
        else onShelf()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, showSettings, showToc, showSearch, selectMode, highlightQuery, onShelf])

  // Keep the editable page field in sync when the page changes any other way.
  useEffect(() => {
    setPageStr(String(page))
  }, [page])

  const onPageInput = (v: string) => {
    setPageStr(v)
    const n = Number(v)
    if (Number.isInteger(n) && n >= 1 && n <= (pageCount || 1)) setPage(n)
  }

  // --- search -----------------------------------------------------------------
  // Debounced, streaming, and cancellable: results appear as pages are scanned,
  // and a new keystroke aborts the previous scan rather than queueing behind it.
  useEffect(() => {
    if (!showSearch) return
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    const aborted = { value: false }
    const timer = setTimeout(() => {
      void (async () => {
        const doc = docRef.current
        if (!doc) return
        setSearching(true)
        setHits([])
        setScanned(0)
        const found: SearchHit[] = []
        try {
          for await (const hit of searchBook(doc, q, textCacheRef.current, {
            fromPage: page,
            aborted,
            onProgress: (n) => !aborted.value && setScanned(n),
          })) {
            found.push(hit)
            // Paint incrementally, but don't thrash React on every hit.
            if (found.length <= 20 || found.length % 10 === 0) setHits([...found])
          }
        } finally {
          if (!aborted.value) {
            setHits([...found])
            setSearching(false)
          }
        }
      })()
    }, 250)
    return () => {
      aborted.value = true
      clearTimeout(timer)
    }
    // `page` is intentionally omitted: turning pages must not restart the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, showSearch, docVersion])

  // --- bookmarks ----------------------------------------------------------------
  const marked = bookmarks.some((b) => b.page === page)

  const toggleBookmark = useCallback(async () => {
    const id = loadedIdRef.current
    if (!id) return
    if (bookmarks.some((b) => b.page === page)) await removeBookmark(id, page)
    else await addBookmark(id, page)
    setBookmarks(await listBookmarks(id))
  }, [bookmarks, page])

  const dropBookmark = useCallback(async (p: number) => {
    const id = loadedIdRef.current
    if (!id) return
    await removeBookmark(id, p)
    setBookmarks(await listBookmarks(id))
  }, [])

  // --- highlights ---------------------------------------------------------------
  // Boxes are derived, never stored: recomputed from each highlight's character
  // range against the current render, so zoom and crop can't misplace them.
  useEffect(() => {
    if (!view) return
    const onPage = marks.filter((m) => m.page === view.pageNo)
    if (!onPage.length) {
      setMarkRects((r) => (r.length ? [] : r))
      return
    }
    let alive = true
    void (async () => {
      try {
        const pt = await getPageText(view.pdfPage, textCacheRef.current)
        if (!alive) return
        setMarkRects(
          onPage.map((m) => ({
            id: m.id,
            rects: rangeRects(view.pdfPage, pt, m.start, m.end, view.cssScale, view.crop),
          })),
        )
      } catch {
        if (alive) setMarkRects([])
      }
    })()
    return () => {
      alive = false
    }
  }, [view, marks])

  const saveHighlight = useCallback(async () => {
    const id = loadedIdRef.current
    // Record against the page the selection was actually made on, not the page
    // state, which could have moved on.
    if (!id || !selection || !view) return
    await addHighlight({
      bookId: id,
      page: view.pageNo,
      start: selection.start,
      end: selection.end,
      text: selection.text.slice(0, 400),
    })
    setMarks(await listHighlights(id))
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [selection, view])

  const dropHighlight = useCallback(async (hid: string) => {
    const id = loadedIdRef.current
    if (!id) return
    await removeHighlight(hid)
    setMarks(await listHighlights(id))
  }, [])

  const commitNote = useCallback(async () => {
    const id = loadedIdRef.current
    if (!id || noteFor === null) return
    const p = noteFor
    setNoteFor(null)
    await setBookmarkNote(id, p, noteDraft)
    setBookmarks(await listBookmarks(id))
  }, [noteFor, noteDraft])

  const openHit = useCallback((hit: SearchHit, q: string) => {
    setHighlightQuery(q)
    setPage(hit.page)
    setShowSearch(false)
  }, [])

  const closeSearch = useCallback(() => {
    setShowSearch(false)
    setSearching(false)
  }, [])

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

  // The reader's chrome follows the reading theme, so the page and its frame
  // are one calm surface instead of a dark app around a differently-dark page.
  const theme = themeById(themeId)
  const chromeBg = rgbCss(theme.bg)
  const hairline = 'color-mix(in srgb, currentColor 14%, transparent)'
  const pagePct = pageCount > 1 ? ((page - 1) / (pageCount - 1)) * 100 : 0

  return (
    <div
      className="anim-fade relative flex h-full flex-col font-sans"
      style={{ background: chromeBg, color: rgbCss(theme.fg) }}
    >
      {chrome && (
        <header
          className="z-20 flex items-center gap-3 px-4 py-3 text-sm"
          style={{ borderBottom: `1px solid ${hairline}` }}
        >
          <button
            className="flex items-center gap-1 whitespace-nowrap opacity-70 transition-opacity hover:opacity-100"
            onClick={onShelf}
          >
            ‹ Library
          </button>
          <div className="min-w-0 flex-1 text-center">
            <span className="block truncate font-serif text-sm italic opacity-60">{title}</span>
          </div>
          <span className="whitespace-nowrap text-xs tabular-nums opacity-50">
            {pageCount ? `${page} / ${pageCount}` : '—'}
          </span>
          <button
            aria-label={marked ? 'Remove bookmark' : 'Bookmark this page'}
            className={`rounded-[10px] border px-2.5 py-1 text-sm transition-opacity hover:opacity-100 ${
              marked ? 'border-accent text-accent opacity-100' : 'opacity-80'
            }`}
            style={marked ? undefined : { borderColor: hairline }}
            onClick={() => void toggleBookmark()}
          >
            {marked ? '★' : '☆'}
          </button>
          {viewMode === 'paged' && !spreadActive && (cls?.textChars ?? 0) > 0 && (
            <button
              aria-label={selectMode ? 'Leave select mode' : 'Select text'}
              title="Select text to copy or highlight"
              className={`rounded-[10px] border px-2.5 py-1 font-serif text-sm transition-opacity hover:opacity-100 ${
                selectMode ? 'border-accent text-accent opacity-100' : 'opacity-80'
              }`}
              style={selectMode ? undefined : { borderColor: hairline }}
              onClick={() => {
                setSelection(null)
                setSelectMode((s) => !s)
              }}
            >
              T
            </button>
          )}
          <button
            aria-label="Search in book"
            className="rounded-[10px] border px-2.5 py-1 text-sm opacity-80 transition-opacity hover:opacity-100"
            style={{ borderColor: hairline }}
            onClick={() => setShowSearch(true)}
          >
            ⌕
          </button>
          <button
            aria-label="Reading settings"
            className="rounded-[10px] border px-3 py-1 font-serif text-sm opacity-80 transition-opacity hover:opacity-100"
            style={{ borderColor: hairline }}
            onClick={() => setShowSettings(true)}
          >
            Aa
          </button>
        </header>
      )}

      {viewMode === 'scroll' && docVersion > 0 && docRef.current && (
        <ContinuousReader
          doc={docRef.current}
          pageCount={pageCount}
          theme={themeById(themeId)}
          satCut={SAT_CUT}
          imageDim={imageDim}
          crop={cropMargins ? cropBox : null}
          zoom={zoom}
          page={page}
          onPage={setPage}
          onToggleChrome={() => setChrome((c) => !c)}
          textCache={textCacheRef.current}
          highlights={marks}
          renderKey={`${docVersion}:${themeId}:${imageDim}:${cropMargins}:${cropBox ? 'c' : 'n'}`}
        />
      )}

      {spreadActive && docVersion > 0 && docRef.current && (
        <SpreadReader
          doc={docRef.current}
          pageCount={pageCount}
          theme={themeById(themeId)}
          satCut={SAT_CUT}
          imageDim={imageDim}
          crop={cropMargins ? cropBox : null}
          page={page}
          onPage={setPage}
          onToggleChrome={() => setChrome((c) => !c)}
          textCache={textCacheRef.current}
          highlights={marks}
          renderKey={`${docVersion}:${themeId}:${imageDim}:${cropMargins}:${cropBox ? 'c' : 'n'}`}
        />
      )}

      <div
        ref={containerRef}
        className="relative flex-1 overflow-auto"
        style={{
          touchAction: 'pan-x pan-y',
          // Stay visible (showing "Loading…") until a replacement view can mount.
          display: (viewMode === 'scroll' || spreadActive) && docVersion > 0 ? 'none' : undefined,
        }}
      >
        {/* Tap zones: left/right thirds turn pages, the middle toggles chrome.
            Inert in select mode, where a drag means "select", not "turn". */}
        <button
          aria-label="Previous page"
          className="absolute inset-y-0 left-0 z-10 w-1/3 disabled:pointer-events-none"
          disabled={selectMode}
          onClick={() => turn(-1)}
        />
        <button
          aria-label="Toggle controls"
          className="absolute inset-x-1/3 inset-y-0 z-10 disabled:pointer-events-none"
          disabled={selectMode}
          onClick={() => setChrome((c) => !c)}
        />
        <button
          aria-label="Next page"
          className="absolute inset-y-0 right-0 z-10 w-1/3 disabled:pointer-events-none"
          disabled={selectMode}
          onClick={() => turn(1)}
        />
        {/* quiet edge chevrons: a desktop affordance for the tap zones */}
        {chrome && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute left-2 top-1/2 z-10 hidden -translate-y-1/2 select-none text-2xl opacity-20 sm:block"
            >
              ‹
            </div>
            <div
              aria-hidden
              className="pointer-events-none absolute right-2 top-1/2 z-10 hidden -translate-y-1/2 select-none text-2xl opacity-20 sm:block"
            >
              ›
            </div>
          </>
        )}
        {/* m-auto centres the canvas when it fits and lets overflow-auto pan from
            the true left edge when zoomed (flex justify-center would clip it). */}
        <div className="flex min-h-full min-w-full p-2">
          <div className="relative m-auto">
            <canvas ref={canvasRef} className="block rounded shadow-2xl" />

            {/* Saved highlights, then search matches, both drawn over the
                recolored page. Pointer-events off so taps still turn pages. */}
            {markRects.flatMap(({ id, rects }) =>
              rects.map((r, i) => (
                <div
                  key={`${id}-${i}`}
                  className="pointer-events-none absolute rounded-[2px] bg-accent/[0.22]"
                  style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
                />
              )),
            )}
            {highlights.map((r, i) => (
              <div
                key={i}
                className="pointer-events-none absolute rounded-[2px] bg-accent/[0.28]"
                style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
              />
            ))}

            {/* Invisible selectable text. Inert unless select mode is on, so it
                never steals the taps that turn pages. */}
            {view && (cls?.textChars ?? 0) > 0 && (
              <TextLayer
                page={view.pdfPage}
                pageNo={view.pageNo}
                cssScale={view.cssScale}
                crop={view.crop}
                cache={textCacheRef.current}
                active={selectMode}
                onSelect={setSelection}
              />
            )}
          </div>
        </div>
        {busy && (
          <div className="absolute inset-0 grid place-items-center font-serif italic opacity-60">
            Loading…
          </div>
        )}
      </div>

      {/* Selection popover: the only way a highlight gets made. */}
      {selectMode && selection && (
        <div
          className="anim-fade fixed z-40 -translate-x-1/2 -translate-y-full"
          style={{ left: selection.x, top: Math.max(48, selection.y - 10) }}
        >
          <div className="flex overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
            <button
              className="px-4 py-2.5 text-[13px] font-semibold text-accent hover:bg-night-800"
              onClick={() => void saveHighlight()}
            >
              ★ Highlight
            </button>
            <button
              className="border-l border-line px-4 py-2.5 text-[13px] text-ink-mid hover:bg-night-800"
              onClick={() => {
                void navigator.clipboard?.writeText(selection.text)
                setSelection(null)
                window.getSelection()?.removeAllRanges()
              }}
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {chrome && (
        <footer
          className="z-20 flex items-center gap-3 px-4 py-2.5"
          style={{ borderTop: `1px solid ${hairline}` }}
        >
          <input
            aria-label="Page number"
            type="text"
            inputMode="numeric"
            className="w-11 rounded-lg border bg-transparent px-1 py-1 text-center text-[13px] tabular-nums"
            style={{ borderColor: hairline }}
            value={pageStr}
            onChange={(e) => onPageInput(e.target.value)}
            onBlur={() => setPageStr(String(page))}
          />
          <span className="whitespace-nowrap text-xs tabular-nums opacity-50">
            / {pageCount || '—'}
          </span>

          {pageCount > 1 && (
            <input
              aria-label="Go to page"
              type="range"
              min={1}
              max={pageCount}
              step={1}
              value={page}
              onChange={(e) => setPage(Number(e.target.value))}
              className="cozy-range min-w-[100px] flex-1"
              style={{ '--fill': `${pagePct}%` } as React.CSSProperties}
            />
          )}

          <span className="whitespace-nowrap text-xs tabular-nums opacity-50">
            {pageCount ? `${Math.round((page / pageCount) * 100)}%` : ''}
          </span>

          {(toc.length > 0 || bookmarks.length > 0 || marks.length > 0) && (
            <button
              className="whitespace-nowrap text-[13px] opacity-70 transition-opacity hover:opacity-100"
              onClick={() => setShowToc(true)}
            >
              Contents
            </button>
          )}
        </footer>
      )}

      {/* While selecting, taps must not turn pages — say so, and offer the exit. */}
      {selectMode && !selection && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-30 flex justify-center">
          <span className="rounded-full bg-panel/90 px-4 py-1.5 text-xs text-ink-mid shadow-lg">
            Select text to copy or highlight · page turns paused
          </span>
        </div>
      )}

      {/* Reading settings: a focused drawer, not a toolbar. Everything that
          shapes the page lives here, surfaced only when you want it. */}
      {showSettings && (
        <>
          <div
            className="anim-fade fixed inset-0 z-30 bg-black/45"
            onClick={() => setShowSettings(false)}
          />
          <div className="anim-panel fixed inset-y-0 right-0 z-40 w-[min(400px,100%)] overflow-y-auto border-l border-line bg-panel p-6 pb-10 font-sans text-ink-body">
            <div className="mb-7 flex items-center justify-between">
              <div className="font-serif text-xl text-ink-bright">Reading settings</div>
              <button
                aria-label="Close settings"
                className="h-8 w-8 rounded-lg border border-line bg-inset text-ink-soft transition-colors hover:text-ink-body"
                onClick={() => setShowSettings(false)}
              >
                ✕
              </button>
            </div>

            <div className="mb-3.5 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
              Theme
            </div>
            <div className="mb-8 grid grid-cols-2 gap-3">
              {THEMES.map((t) => (
                <button key={t.id} className="text-left" onClick={() => setThemeId(t.id)}>
                  <div
                    className={`flex h-16 items-center rounded-xl border-2 px-4 ${
                      t.id === themeId ? 'border-accent' : 'border-night-700'
                    }`}
                    style={{ background: rgbCss(t.bg) }}
                  >
                    <span className="font-serif text-xl" style={{ color: rgbCss(t.fg) }}>
                      Aa
                    </span>
                  </div>
                  <div
                    className={`mt-1.5 text-[11px] ${
                      t.id === themeId ? 'text-accent' : 'text-ink-soft'
                    }`}
                  >
                    {t.name}
                  </div>
                </button>
              ))}
            </div>

            <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
              Layout
            </div>
            <div className="mb-2.5 flex rounded-xl bg-inset p-1">
              <button
                className={`flex-1 rounded-[9px] py-2.5 text-[13px] font-semibold ${
                  viewMode === 'paged' ? 'bg-accent text-accent-on' : 'text-ink-mid'
                }`}
                onClick={() => setViewMode('paged')}
              >
                Paged
              </button>
              <button
                className={`flex-1 rounded-[9px] py-2.5 text-[13px] font-semibold ${
                  viewMode === 'scroll' ? 'bg-accent text-accent-on' : 'text-ink-mid'
                }`}
                onClick={() => setViewMode('scroll')}
              >
                Scroll
              </button>
            </div>
            <p className="mb-6 text-xs leading-relaxed text-ink-faint">
              {viewMode === 'paged'
                ? 'Tap the sides to turn pages. Pinch to zoom; select text to copy or highlight.'
                : 'Flow through the whole book by scrolling. Text select and highlight-making live in Paged mode.'}
            </p>

            {viewMode === 'paged' && (
              <label className="mb-8 flex cursor-pointer items-center justify-between">
                <span className="text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                  Two-page spread{' '}
                  <span className="lowercase tracking-normal text-ink-faint">(landscape)</span>
                </span>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={spread}
                  onChange={(e) => setSpread(e.target.checked)}
                />
              </label>
            )}

            {/* Zoom is meaningless in the spread (pages are fit to the open
                book), so it hides there. */}
            {!spreadActive && (
              <>
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                    Zoom
                  </span>
                  <span className="text-xs tabular-nums text-ink-soft">{zoom.toFixed(1)}×</span>
                </div>
                <div className="mb-7 flex items-center gap-3.5">
                  <span className="font-serif text-[13px] text-ink-soft">A</span>
                  <input
                    aria-label="Zoom"
                    type="range"
                    min={1}
                    max={4}
                    step={0.1}
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                    className="cozy-range flex-1"
                    style={{ '--fill': `${((zoom - 1) / 3) * 100}%` } as React.CSSProperties}
                  />
                  <span className="font-serif text-2xl text-ink-soft">A</span>
                </div>
                {viewMode === 'scroll' && (
                  <p className="-mt-5 mb-7 text-xs leading-relaxed text-ink-faint">
                    At 1× the whole page fits the screen; slide up to fill the width.
                  </p>
                )}
              </>
            )}

            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                Image brightness
              </span>
              <span className="text-xs tabular-nums text-ink-soft">
                {Math.round(imageDim * 100)}%
              </span>
            </div>
            <input
              aria-label="Images"
              type="range"
              min={0.4}
              max={1}
              step={0.02}
              value={imageDim}
              onChange={(e) => setImageDim(Number(e.target.value))}
              className="cozy-range mb-7 w-full"
              style={{ '--fill': `${((imageDim - 0.4) / 0.6) * 100}%` } as React.CSSProperties}
            />

            {cropBox && (
              <label className="mb-7 flex cursor-pointer items-center justify-between">
                <span className="text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                  Crop margins
                </span>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={cropMargins}
                  onChange={(e) => setCropMargins(e.target.checked)}
                />
              </label>
            )}

            <button
              className="w-full rounded-xl border border-accent/40 py-3 text-sm font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
              disabled={!pageCount || exporting !== null}
              onClick={onExport}
            >
              {exporting !== null ? `Exporting ${Math.round(exporting * 100)}%` : 'Export dark PDF'}
            </button>

            {cls && (
              <div className="mt-6 text-center text-[11px] text-ink-faint">page: {cls.kind}</div>
            )}
          </div>
        </>
      )}

      {showSearch && (
        <div className="anim-fade absolute inset-0 z-30 flex flex-col bg-night-950/95 text-ink-body backdrop-blur-sm">
          <div className="mx-auto flex w-full max-w-xl items-center gap-3 px-5 py-4">
            <input
              aria-label="Search in book"
              autoFocus
              placeholder="Search this book…"
              className="flex-1 rounded-lg border border-line bg-inset px-3 py-2 text-[15px] text-ink-body outline-none placeholder:text-ink-faint focus:border-accent/60"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits.length) openHit(hits[0], query)
                else if (e.key === 'Escape') closeSearch()
              }}
            />
            <button
              aria-label="Close search"
              className="h-9 w-9 flex-none rounded-lg border border-line bg-inset text-ink-soft transition-colors hover:text-ink-body"
              onClick={closeSearch}
            >
              ✕
            </button>
          </div>

          <div className="mx-auto w-full max-w-xl px-5 pb-2 text-xs text-ink-faint">
            {query.trim().length < 2
              ? 'Type at least two characters.'
              : searching
                ? `Searching… ${hits.length} ${hits.length === 1 ? 'match' : 'matches'} (${Math.round((scanned / (pageCount || 1)) * 100)}%)`
                : hits.length
                  ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`
                  : 'No matches.'}
            {highlightQuery && (
              <button
                className="ml-3 underline underline-offset-2 hover:text-ink-soft"
                onClick={() => {
                  setHighlightQuery('')
                  closeSearch()
                }}
              >
                Clear highlights
              </button>
            )}
          </div>

          <div className="mx-auto w-full max-w-xl flex-1 overflow-auto px-3 pb-8">
            {hits.map((h, i) => (
              <button
                key={`${h.page}-${i}`}
                className="block w-full rounded-lg px-3 py-2.5 text-left hover:bg-night-800"
                onClick={() => openHit(h, query)}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-serif text-[15px] leading-snug text-ink-shelf">
                    <span className="opacity-70">…{h.before}</span>
                    <mark className="bg-accent/30 text-ink-bright">{h.match}</mark>
                    <span className="opacity-70">{h.after}…</span>
                  </span>
                  <span className="flex-none text-xs tabular-nums text-ink-dim">p. {h.page}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {showToc && (
        <div className="anim-fade absolute inset-0 z-20 flex flex-col bg-night-950/95 text-ink-body backdrop-blur-sm">
          <div className="flex items-center justify-between px-5 py-4">
            <span className="font-serif text-lg text-ink-bright">Contents</span>
            <button
              aria-label="Close contents"
              className="h-8 w-8 rounded-lg border border-line bg-inset text-ink-soft transition-colors hover:text-ink-body"
              onClick={() => setShowToc(false)}
            >
              ✕
            </button>
          </div>
          <div className="mx-auto w-full max-w-xl flex-1 overflow-auto px-3 pb-8">
            {bookmarks.length > 0 && (
              <>
                <div className="px-3 pb-2 pt-1 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                  Bookmarks
                </div>
                {bookmarks.map((b) => (
                  <div key={b.id} className="group flex items-center gap-1">
                    {noteFor === b.page ? (
                      <input
                        aria-label={`Note for page ${b.page}`}
                        autoFocus
                        placeholder={`Page ${b.page}`}
                        className="mx-3 my-1 flex-1 rounded-md border border-accent/50 bg-inset px-2 py-1.5 font-serif text-[15px] text-ink-shelf outline-none"
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        onBlur={() => void commitNote()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitNote()
                          else if (e.key === 'Escape') setNoteFor(null)
                        }}
                      />
                    ) : (
                      <button
                        className="flex flex-1 items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-night-800"
                        onClick={() => {
                          setPage(b.page)
                          setShowToc(false)
                        }}
                      >
                        <span className="truncate font-serif text-[15px] text-ink-shelf">
                          <span className="mr-2 text-accent">★</span>
                          {b.note || `Page ${b.page}`}
                        </span>
                        <span className="text-sm tabular-nums text-ink-dim">{b.page}</span>
                      </button>
                    )}
                    <button
                      aria-label={`Note on page ${b.page}`}
                      className="rounded-md px-2 py-1 text-xs text-ink-faint hover:text-ink-body"
                      onClick={() => {
                        setNoteDraft(b.note ?? '')
                        setNoteFor(b.page)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      aria-label={`Remove bookmark on page ${b.page}`}
                      className="rounded-md px-2 py-1 text-xs text-ink-faint hover:text-ink-body"
                      onClick={() => void dropBookmark(b.page)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </>
            )}

            {marks.length > 0 && (
              <>
                <div className="px-3 pb-2 pt-5 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                  Highlights
                </div>
                {marks.map((m) => (
                  <div key={m.id} className="flex items-center gap-1">
                    <button
                      className="flex flex-1 items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-night-800"
                      onClick={() => {
                        setPage(m.page)
                        setShowToc(false)
                      }}
                    >
                      <span className="truncate font-serif text-[15px] italic text-ink-shelf">
                        “{m.text}”
                      </span>
                      <span className="text-sm tabular-nums text-ink-dim">{m.page}</span>
                    </button>
                    <button
                      aria-label={`Remove highlight on page ${m.page}`}
                      className="rounded-md px-2 py-1 text-xs text-ink-faint hover:text-ink-body"
                      onClick={() => void dropHighlight(m.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </>
            )}

            {toc.length > 0 && (bookmarks.length > 0 || marks.length > 0) && (
              <div className="px-3 pb-2 pt-5 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                Chapters
              </div>
            )}
            {toc.map((t, i) => (
              <button
                key={i}
                className="flex w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-night-800"
                style={{ paddingLeft: `${12 + t.depth * 16}px` }}
                onClick={() => {
                  setPage(t.page)
                  setShowToc(false)
                }}
              >
                <span className="truncate font-serif text-[15px] text-ink-shelf">{t.title}</span>
                <span className="text-sm tabular-nums text-ink-dim">{t.page}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Theme anchor tone (0..1 triple) → CSS colour for the reader chrome. */
function rgbCss(c: [number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`
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
