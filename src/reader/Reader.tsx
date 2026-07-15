import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { lookupWord, type DictResult } from '../engine/dict'
import { ContinuousReader } from './ContinuousReader'
import { SpreadReader } from './SpreadReader'
import { TextReader, TEXT_FONTS, fontStack, type ParaStyle } from './TextReader'
import { exportDarkPdf, downloadBlob } from '../export/exportPdf'
import { notesMarkdown } from '../export/exportNotes'
import { extractPages } from '../export/extractPages'
import { startReadAloud, type ReadAloud } from './readAloud'
import { exportVectorPdf } from '../export/vectorPdf'
import { exportEpub } from '../export/exportEpub'
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
  logReading,
  saveThumb,
  tintOf,
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

const POS_LABEL = { n: 'noun', v: 'verb', a: 'adj.', r: 'adv.' } as const

/** The word under a screen point, from the caret position — no selection made. */
function wordAtPoint(x: number, y: number): { word: string; rect: DOMRect } | null {
  type CaretDoc = Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  const doc = document as CaretDoc
  let node: Node | null = null
  let offset = 0
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y)
    if (r) {
      node = r.startContainer
      offset = r.startOffset
    }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y)
    if (p) {
      node = p.offsetNode
      offset = p.offset
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null
  const text = node.textContent ?? ''
  const isWordChar = (c: string) => /[\p{L}\p{N}'’-]/u.test(c)
  let a = offset
  let b = offset
  while (a > 0 && isWordChar(text[a - 1])) a--
  while (b < text.length && isWordChar(text[b])) b++
  if (b <= a) return null
  const word = text.slice(a, b)
  if (!/\p{L}/u.test(word) || word.length > 40) return null
  const range = document.createRange()
  range.setStart(node, a)
  range.setEnd(node, b)
  return { word, rect: range.getBoundingClientRect() }
}

/** A recolored page rendered to a 2D canvas, with its on-screen display size. */
interface PageBitmap {
  canvas: HTMLCanvasElement
  w: number
  h: number
}
/** Exactly how the current page was rendered, so neighbours can match it. */
interface RenderParams {
  cssScale: number
  dpr: number
  crop: CropBox | null
  displayW: number
  displayH: number
}
/** The three-page filmstrip shown during a drag-to-turn. */
interface DragFilm {
  w: number
  prev: PageBitmap | null
  cur: PageBitmap
  next: PageBitmap | null
}

/** Mounts a cached page bitmap (an offscreen canvas) into one filmstrip cell. */
function BitmapCell({ bmp, cellW }: { bmp: PageBitmap | null; cellW: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    host.replaceChildren()
    if (bmp) {
      bmp.canvas.style.width = `${bmp.w}px`
      bmp.canvas.style.height = `${bmp.h}px`
      bmp.canvas.className = 'block rounded shadow-2xl'
      host.appendChild(bmp.canvas)
    }
    return () => {
      if (host) host.replaceChildren()
    }
  }, [bmp])
  return (
    <div
      className="flex h-full flex-none items-center justify-center p-2"
      style={{ width: cellW }}
    >
      <div ref={ref} />
    </div>
  )
}

function comfortNum(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && localStorage.getItem(key) !== null ? v : fallback
  } catch {
    return fallback
  }
}
function comfortBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
function comfortStr(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

/** iPadOS reports itself as MacIntel; the touch-points check catches it. */
const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

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
  // Drag-to-turn: recolored 2D bitmaps of the current page and its neighbours,
  // so a swipe can slide them under your finger. Rendered by a dedicated
  // offscreen GL context (so it never touches the live canvas), cached per page.
  const filmGlRef = useRef<HTMLCanvasElement | null>(null)
  const filmRecolorRef = useRef<Recolorizer | null>(null)
  const filmSrcRef = useRef<HTMLCanvasElement | null>(null)
  const filmChainRef = useRef<Promise<void>>(Promise.resolve())
  const bmpCacheRef = useRef<Map<number, PageBitmap>>(new Map())
  const renderParamsRef = useRef<RenderParams | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  // Commit hand-off: the overlay is dropped only once the settle animation has
  // ended AND the live canvas has re-rendered the committed page, so the two
  // line up and there's no snap.
  const commitTargetRef = useRef<number | null>(null)
  const slideDoneRef = useRef(false)
  const renderedPageRef = useRef(0)
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
  const pageRef = useRef(1)
  pageRef.current = page
  const [pageCount, setPageCount] = useState(0)
  /** Scroll mode's exact strip position (page units) — persisted so reopening
   *  lands on the very line you left, not the page top. */
  const [scrollOff, setScrollOff] = useState<number | null>(null)
  /** Footer stat readout: percent through the book, or pages left in chapter. */
  const [footerStat, setFooterStat] = useState<'percent' | 'chapter'>(() =>
    comfortStr('nocturne-footerstat', 'percent') === 'chapter' ? 'chapter' : 'percent',
  )
  const [themeId, setThemeId] = useState(DEFAULT_THEME.id)
  const [imageDim, setImageDim] = useState(0.82)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState(true)
  const [chrome, setChrome] = useState(true)
  // Comfort settings are device/environment preferences, not per-book, so they
  // live in localStorage (and don't sync).
  const [dim, setDim] = useState(() => comfortNum('nocturne-dim', 0))
  const [autoHide, setAutoHide] = useState(() => comfortBool('nocturne-autohide', true))
  const [haptics, setHaptics] = useState(() => comfortBool('nocturne-haptics', true))
  const [cls, setCls] = useState<PageClassification | null>(null)
  const [exporting, setExporting] = useState<number | null>(null) // 0..1 progress
  /** A finished export parked for a fresh tap to open the iOS share sheet. */
  const [pendingSave, setPendingSave] = useState<{ blob: Blob; name: string } | null>(null)
  const pendingSaveRef = useRef<{ blob: Blob; name: string } | null>(null)
  pendingSaveRef.current = pendingSave
  /** Export scope: false = whole book, true = the from/to page range below. */
  const [exportRange, setExportRange] = useState(false)
  const [extractFrom, setExtractFrom] = useState(1)
  const [extractTo, setExtractTo] = useState(1)
  const [extracting, setExtracting] = useState(false)
  const [extractErr, setExtractErr] = useState(false)
  const [reading, setReading] = useState(false)
  const readAloudRef = useRef<ReadAloud | null>(null)
  const [vexporting, setVexporting] = useState<number | null>(null)
  const [epubbing, setEpubbing] = useState<number | null>(null)
  const [epubErr, setEpubErr] = useState(false)
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
  /** The live drag-to-turn filmstrip: three page bitmaps that follow the finger. */
  const [drag, setDrag] = useState<DragFilm | null>(null)
  /** Page whose bookmark note is being edited in the Contents list, and the draft. */
  const [noteFor, setNoteFor] = useState<number | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [marks, setMarks] = useState<Highlight[]>([]) // saved highlights, this book
  const [markRects, setMarkRects] = useState<
    { id: string; color?: 'amber' | 'sage'; rects: HighlightRect[] }[]
  >([])
  /** Select mode: while on, the text layer takes taps so you can select/copy.
   *  Paged mode only — its taps turn pages. Scroll and Text Mode have no tap
   *  zones, so selection there is always live, no mode. */
  const [selectMode, setSelectMode] = useState(false)
  const [selection, setSelection] = useState<TextSelection | null>(null)
  /** A selection made in scroll mode (page-keyed, offsets valid) or Text Mode
   *  (offsets -1: reflowed text has no page character range to highlight). */
  const [flowSel, setFlowSel] = useState<{ page: number; sel: TextSelection } | null>(null)
  /** Definition card pinned to a double-tapped word. A SNAPSHOT, deliberately
   *  independent of the live selection: iOS collapses the selection on the
   *  very tap that asks for the definition, so anything anchored to it dies
   *  before it can be read (the original mobile Define bug). */
  const [defCard, setDefCard] = useState<{
    word: string
    x: number
    y: number
    res: 'loading' | 'none' | DictResult
  } | null>(null)
  const [dblTapDefine, setDblTapDefine] = useState(() => comfortBool('nocturne-dbltap-define', true))
  /** One-handed reading: the left tap zone turns forward instead of back. */
  const [leftTapForward, setLeftTapForward] = useState(() =>
    comfortBool('nocturne-lefttap-fwd', false),
  )
  /** Auto theme: Paper during the day, your dark theme at night. */
  const [autoTheme, setAutoTheme] = useState(() => comfortBool('nocturne-autotheme', false))
  /** Where a TOC/search/scrubber jump left from — the "↩ back" pill's target.
   *  Chained jumps keep the ORIGINAL origin; that's the place you left. */
  const [backSpot, setBackSpot] = useState<number | null>(null)
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
  const [viewMode, setViewMode] = useState<'paged' | 'scroll' | 'text'>('paged')
  // Text Mode reading prefs are personal comfort settings (device-global).
  const [textSize, setTextSize] = useState(() => comfortNum('nocturne-textsize', 19))
  const [textLeading, setTextLeading] = useState(() => comfortNum('nocturne-textleading', 1.6))
  const [textFontId, setTextFontId] = useState(() => comfortStr('nocturne-textfont', 'lora'))
  const [textWidth, setTextWidth] = useState(() => comfortNum('nocturne-textwidth', 660))
  const [textJustify, setTextJustify] = useState(() => comfortBool('nocturne-textjustify', false))
  const [textPara, setTextPara] = useState<ParaStyle>(() =>
    comfortStr('nocturne-textpara', 'indent') === 'spaced' ? 'spaced' : 'indent',
  )
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
      setScrollOff(progress?.offset ?? null)
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
    // Scroll, spread and text each own their rendering; the single-page canvas
    // stays hidden and must not re-render underneath them.
    if (viewMode === 'scroll' || viewMode === 'text' || spreadActive) return
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
    const displayW = result.source.width / result.dpr
    const displayH = result.source.height / result.dpr
    canvas.style.width = `${displayW}px`
    canvas.style.height = `${displayH}px`
    canvas.style.transform = '' // clear any live pinch preview
    // Remember exactly how this page was rendered, so the drag-to-turn preview
    // can render its neighbours identically.
    renderParamsRef.current = { cssScale, dpr, crop, displayW, displayH }

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

  // Render a page to a recolored 2D bitmap for the drag-to-turn filmstrip, using
  // a dedicated offscreen GL context so the live canvas is never disturbed.
  // Neighbours borrow the current page's render params (uniform books), so the
  // preview lines up; the real page re-renders crisply on commit.
  const renderBitmap = useCallback(
    async (pageNo: number) => {
      const doc = docRef.current
      const rp = renderParamsRef.current
      if (!doc || !rp || pageNo < 1 || pageNo > doc.numPages) return
      if (bmpCacheRef.current.has(pageNo)) return
      const pdfPage = await doc.getPage(pageNo)
      const cls = await classifyCached(pdfPage, pageNo)
      if (!filmRecolorRef.current) {
        const c = document.createElement('canvas')
        try {
          filmRecolorRef.current = new Recolorizer(c, /* preserveDrawingBuffer */ true)
        } catch {
          return
        }
        filmGlRef.current = c
        filmSrcRef.current = document.createElement('canvas')
      }
      const res = await renderDarkPage(pdfPage, rp.cssScale, rp.dpr, filmRecolorRef.current, {
        theme: themeById(themeId),
        satCut: SAT_CUT,
        imageDim,
        crop: rp.crop,
        cls,
        sourceCanvas: filmSrcRef.current ?? undefined,
      })
      const gl = filmGlRef.current!
      const out = document.createElement('canvas')
      out.width = gl.width
      out.height = gl.height
      out.getContext('2d')!.drawImage(gl, 0, 0)
      bmpCacheRef.current.set(pageNo, {
        canvas: out,
        w: res.source.width / res.dpr,
        h: res.source.height / res.dpr,
      })
    },
    [themeId, imageDim, classifyCached],
  )

  // Keep bitmaps for the current page and its two neighbours ready; drop the
  // rest. Serialized on its own chain (shared offscreen canvases).
  const ensureNeighbors = useCallback(() => {
    const p = page
    filmChainRef.current = filmChainRef.current
      .then(async () => {
        for (const k of [...bmpCacheRef.current.keys()]) {
          if (k < p - 1 || k > p + 1) bmpCacheRef.current.delete(k)
        }
        for (const n of [p, p - 1, p + 1]) await renderBitmap(n)
      })
      .catch(() => undefined)
  }, [page, renderBitmap])

  // A look change invalidates every cached bitmap (they were recolored/sized
  // for the old settings).
  useEffect(() => {
    bmpCacheRef.current.clear()
  }, [themeId, imageDim, zoom, cropMargins, cropBox, docVersion])

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

  // The overlay stays until BOTH the settle animation ends and the live canvas
  // shows the committed page — otherwise a fast re-render yanks the half-slid
  // filmstrip away and it snaps.
  const tryFinishDrag = useCallback(() => {
    if (
      commitTargetRef.current !== null &&
      slideDoneRef.current &&
      renderedPageRef.current === commitTargetRef.current
    ) {
      commitTargetRef.current = null
      slideDoneRef.current = false
      setDrag(null)
    }
  }, [])

  // When a page finishes rendering: record it, complete a pending drag-commit if
  // its slide is done, and refresh the neighbour bitmaps for the next drag.
  useEffect(() => {
    if (!view) return
    renderedPageRef.current = view.pageNo
    tryFinishDrag()
    ensureNeighbors()
  }, [view, ensureNeighbors, tryFinishDrag])

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
  // Split: position changes on every scroll tick, look only on settings taps —
  // one combined effect would rewrite the profile row per scroll.
  useEffect(() => {
    const id = loadedIdRef.current
    if (!id) return
    void saveProfile({ bookId: id, themeId, satCut: SAT_CUT, strength: 1, zoom, imageDim, cropMargins, viewMode, spread })
  }, [themeId, imageDim, zoom, cropMargins, viewMode, spread])
  useEffect(() => {
    const id = loadedIdRef.current
    if (!id) return
    void saveProgress({
      bookId: id,
      page,
      percent: pageCount ? page / pageCount : 0,
      // Only scroll mode has a sub-page position; elsewhere clear it so a
      // stale offset can't tug a later scroll-mode open away from `page`.
      offset: viewMode === 'scroll' && scrollOff != null ? scrollOff : undefined,
      updatedAt: Date.now(),
    })
  }, [page, pageCount, scrollOff, viewMode])

  // A faint tick on page turn. iOS Safari doesn't expose the Vibration API, so
  // this is silent on iPhone and fires on Android/desktop Chrome.
  const tick = useCallback(() => {
    if (haptics && typeof navigator.vibrate === 'function') navigator.vibrate(8)
  }, [haptics])

  const turn = useCallback(
    (delta: number) => {
      setPage((p) => {
        const next = Math.min(pageCount || 1, Math.max(1, p + delta))
        if (next !== p) tick()
        return next
      })
    },
    [pageCount, tick],
  )

  // Persist comfort prefs.
  useEffect(() => {
    try {
      localStorage.setItem('nocturne-dim', String(dim))
      localStorage.setItem('nocturne-autohide', autoHide ? '1' : '0')
      localStorage.setItem('nocturne-haptics', haptics ? '1' : '0')
      localStorage.setItem('nocturne-textsize', String(textSize))
      localStorage.setItem('nocturne-textleading', String(textLeading))
      localStorage.setItem('nocturne-textfont', textFontId)
      localStorage.setItem('nocturne-textwidth', String(textWidth))
      localStorage.setItem('nocturne-textjustify', textJustify ? '1' : '0')
      localStorage.setItem('nocturne-textpara', textPara)
      localStorage.setItem('nocturne-footerstat', footerStat)
      localStorage.setItem('nocturne-dbltap-define', dblTapDefine ? '1' : '0')
      localStorage.setItem('nocturne-lefttap-fwd', leftTapForward ? '1' : '0')
      localStorage.setItem('nocturne-autotheme', autoTheme ? '1' : '0')
    } catch {
      /* private mode; non-fatal */
    }
  }, [dim, autoHide, haptics, textSize, textLeading, textFontId, textWidth, textJustify, textPara, footerStat, dblTapDefine, leftTapForward, autoTheme])

  // Reading stats: time is the gap between page arrivals (capped, so a
  // put-down phone doesn't count the night), pages are forward movement
  // (capped, so a TOC jump isn't "50 pages read"). Flushed to Dexie on a slow
  // timer and when the tab hides — never per turn.
  const statRef = useRef({ last: 0, prevPage: 0, ms: 0, pages: 0 })
  useEffect(() => {
    const now = Date.now()
    const s = statRef.current
    if (s.last > 0) {
      const gap = now - s.last
      if (gap > 0 && gap < 120_000) s.ms += gap
    }
    if (s.prevPage > 0 && page > s.prevPage) s.pages += Math.min(page - s.prevPage, 2)
    s.prevPage = page
    s.last = now
  }, [page])
  useEffect(() => {
    const flush = () => {
      const s = statRef.current
      if (s.ms > 0 || s.pages > 0) {
        void logReading(s.ms, s.pages)
        s.ms = 0
        s.pages = 0
      }
    }
    const iv = window.setInterval(flush, 30_000)
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(iv)
      document.removeEventListener('visibilitychange', onVis)
      flush()
    }
  }, [])

  // A deliberate jump (TOC, search, bookmark, scrubber, page box) records where
  // you left, so one tap brings you back — losing your spot to a curious TOC
  // tap is the classic reader-app paper cut.
  const jumpTo = useCallback((p: number) => {
    const cur = pageRef.current
    if (Math.abs(p - cur) > 2) setBackSpot((b) => (b == null ? cur : b))
    setPage(p)
  }, [])

  // The pill retires once you're back in the neighbourhood — by tap or by
  // paging there yourself — and never survives into another book.
  useEffect(() => {
    if (backSpot != null && Math.abs(page - backSpot) <= 1) setBackSpot(null)
  }, [page, backSpot])
  useEffect(() => {
    setBackSpot(null)
  }, [docVersion])

  // Auto theme: Paper during the day (07–19), your dark theme at night. Only
  // acts when the day/night bucket CHANGES (or a book opens), so picking a
  // theme by hand always wins until the next boundary — the app must never
  // fight the reader over the palette.
  const themeBucket = useRef<'day' | 'night' | null>(null)
  useEffect(() => {
    if (!autoTheme) {
      themeBucket.current = null
      return
    }
    const apply = (force: boolean) => {
      const hour = new Date().getHours()
      const bucket: 'day' | 'night' = hour >= 7 && hour < 19 ? 'day' : 'night'
      if (!force && themeBucket.current === bucket) return
      themeBucket.current = bucket
      setThemeId((cur) =>
        bucket === 'day' ? 'paper' : cur === 'paper' ? DEFAULT_THEME.id : cur,
      )
    }
    apply(true)
    const iv = window.setInterval(() => apply(false), 5 * 60 * 1000)
    return () => window.clearInterval(iv)
  }, [autoTheme, docVersion])

  // Keep the screen awake while reading — you shouldn't have to poke the phone
  // mid-page. Re-acquired when the tab returns to the foreground (iOS drops it).
  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    let released = false
    const acquire = async () => {
      try {
        lock = (await navigator.wakeLock?.request('screen')) ?? null
      } catch {
        /* denied / unsupported — harmless */
      }
    }
    void acquire()
    const onVis = () => {
      if (document.visibilityState === 'visible' && !released) void acquire()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVis)
      void lock?.release().catch(() => undefined)
    }
  }, [])

  // Auto-hide the chrome for immersive reading: after a few idle seconds it
  // fades, and any tap brings it back. Suppressed while an overlay is open (you
  // are interacting with the chrome) and while select mode is on.
  const hideTimer = useRef<number | undefined>(undefined)
  const bumpChrome = useCallback(() => {
    window.clearTimeout(hideTimer.current)
    if (!autoHide || !chrome || showSettings || showSearch || showToc || selectMode) return
    hideTimer.current = window.setTimeout(() => setChrome(false), 4000)
  }, [autoHide, chrome, showSettings, showSearch, showToc, selectMode])

  useEffect(() => {
    bumpChrome()
    return () => window.clearTimeout(hideTimer.current)
    // page in deps: turning a page restarts the idle countdown.
  }, [bumpChrome, page])

  // Drag to turn: a single-finger horizontal drag slides the current page out
  // and the neighbour in, following your finger, and settles on release. Only
  // at zoom 1 (a zoomed page pans instead), not while selecting; two fingers
  // are the pinch handler's. Falls back to an instant turn if the neighbour
  // bitmap isn't ready. Spread has its own swipe; scroll owns vertical movement.
  useEffect(() => {
    const scroller = containerRef.current
    if (!scroller || viewMode !== 'paged' || spreadActive) return
    let x0 = 0
    let y0 = 0
    let mode: 'idle' | 'maybe' | 'follow' | 'fallback' = 'idle'
    let w = 0
    let dir = 0
    let lastX = 0
    let lastT = 0
    let vx = 0 // px/ms, smoothed — for flick detection and settle speed

    const clampD = (d: number) => {
      if (page <= 1 && d > 0) return 0 // no page before the first
      if (page >= pageCount && d < 0) return 0 // none after the last
      return d
    }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || zoom !== 1 || selectMode) {
        mode = 'idle'
        return
      }
      x0 = lastX = e.touches[0].clientX
      y0 = e.touches[0].clientY
      lastT = e.timeStamp
      vx = 0
      w = scroller.clientWidth
      mode = 'maybe'
    }

    const onMove = (e: TouchEvent) => {
      if (mode === 'idle' || e.touches.length !== 1) return
      const nx = e.touches[0].clientX
      const dx = nx - x0
      const dy = e.touches[0].clientY - y0
      if (mode === 'maybe') {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
        if (Math.abs(dx) <= Math.abs(dy)) {
          mode = 'idle' // vertical — not our gesture
          return
        }
        dir = dx < 0 ? 1 : -1
        const target = page + dir
        const cur = bmpCacheRef.current.get(page)
        const nb = target >= 1 && target <= pageCount ? bmpCacheRef.current.get(target) : null
        // Follow only if we can actually show the neighbour; else instant-turn.
        mode = cur && nb ? 'follow' : 'fallback'
        if (mode === 'follow') {
          setDrag({
            w,
            prev: bmpCacheRef.current.get(page - 1) ?? null,
            cur: cur!,
            next: bmpCacheRef.current.get(page + 1) ?? null,
          })
        }
      }
      if (mode === 'follow' || mode === 'fallback') e.preventDefault()
      // Smoothed instantaneous velocity for the release.
      if (e.timeStamp > lastT) {
        vx = 0.75 * ((nx - lastX) / (e.timeStamp - lastT)) + 0.25 * vx
        lastX = nx
        lastT = e.timeStamp
      }
      if (mode === 'follow' && trackRef.current) {
        trackRef.current.style.transition = 'none'
        trackRef.current.style.transform = `translateX(${-w + clampD(dx)}px)`
      }
    }

    const onEnd = (e: TouchEvent) => {
      const m = mode
      mode = 'idle'
      const t = e.changedTouches[0]
      const dx = t.clientX - x0
      const dy = t.clientY - y0
      // Commit on either a far-enough drag or a quick flick in that direction.
      const far = Math.abs(dx) > w * 0.2 && Math.abs(dx) > Math.abs(dy) * 1.2
      const flick = Math.abs(vx) > 0.45 && Math.sign(vx) === -dir
      if (m === 'fallback') {
        if (far || flick) turn(dx < 0 ? 1 : -1)
        return
      }
      if (m !== 'follow') return
      const track = trackRef.current
      const wantCommit = (far || flick) && ((dir > 0 && page < pageCount) || (dir < 0 && page > 1))
      if (!track) {
        if (wantCommit) turn(dir)
        setDrag(null)
        return
      }
      const curX = -w + clampD(dx)
      const targetX = wantCommit ? -w - dir * w : -w
      const remaining = Math.abs(targetX - curX)
      // Settle at a speed that matches how fast you let go (a flick finishes
      // quickly; a slow release eases), clamped to a pleasant range.
      const speed = Math.max(Math.abs(vx), 1.5)
      const dur = Math.max(150, Math.min(360, remaining / speed))

      const finishSnap = () => setDrag(null)
      const onTransitionEnd = () => {
        track.removeEventListener('transitionend', onTransitionEnd)
        if (wantCommit) {
          slideDoneRef.current = true
          tryFinishDrag()
        } else {
          finishSnap()
        }
      }

      if (remaining < 0.5) {
        // Already there (released at rest against a boundary): no animation.
        track.style.transform = `translateX(${targetX}px)`
        if (wantCommit) {
          commitTargetRef.current = page + dir
          slideDoneRef.current = true
          turn(dir)
          tryFinishDrag()
        } else {
          finishSnap()
        }
        return
      }

      track.style.transition = `transform ${Math.round(dur)}ms cubic-bezier(.2,.68,.25,1)`
      track.addEventListener('transitionend', onTransitionEnd)
      // Safety net if transitionend doesn't fire (interrupted/hidden tab).
      window.setTimeout(onTransitionEnd, Math.round(dur) + 220)
      // Kick the transition on the next frame so the browser registers the
      // starting position first (a same-frame set can jump straight to target).
      requestAnimationFrame(() => {
        track.style.transform = `translateX(${targetX}px)`
      })
      if (wantCommit) {
        commitTargetRef.current = page + dir
        slideDoneRef.current = false
        turn(dir) // re-render underneath; tryFinishDrag drops the overlay when both are ready
      }
    }

    scroller.addEventListener('touchstart', onStart, { passive: true })
    scroller.addEventListener('touchmove', onMove, { passive: false })
    scroller.addEventListener('touchend', onEnd)
    scroller.addEventListener('touchcancel', onEnd)
    return () => {
      scroller.removeEventListener('touchstart', onStart)
      scroller.removeEventListener('touchmove', onMove)
      scroller.removeEventListener('touchend', onEnd)
      scroller.removeEventListener('touchcancel', onEnd)
    }
  }, [turn, zoom, selectMode, viewMode, spreadActive, page, pageCount, tryFinishDrag])

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
      // Escape closes overlays even from a focused field (a slider/search box);
      // the arrow keys are the ones that must not hijack typing.
      if (e.key === 'Escape') {
        if (showSearch) setShowSearch(false)
        else if (showSettings) setShowSettings(false)
        else if (showToc) setShowToc(false)
        else if (selectMode) {
          setSelectMode(false)
          setSelection(null)
        } else if (highlightQuery) setHighlightQuery('')
        else onShelf()
        return
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowLeft') turn(-1)
      else if (e.key === 'ArrowRight') turn(1)
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
    if (Number.isInteger(n) && n >= 1 && n <= (pageCount || 1)) jumpTo(n)
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
            color: m.color,
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

  // The one selection the popover acts on, wherever it was made. `canMark`
  // is false when the text has no page character range (Text Mode reflow) —
  // highlights persist as ranges, so there's nothing valid to store.
  const activeSel = useMemo(() => {
    if (selectMode && selection && view)
      return { page: view.pageNo, sel: selection, canMark: true }
    if (flowSel) return { page: flowSel.page, sel: flowSel.sel, canMark: flowSel.sel.start >= 0 }
    return null
  }, [selectMode, selection, view, flowSel])

  const clearSelection = useCallback(() => {
    setSelection(null)
    setFlowSel(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  // Scroll mode reports per-page: a null from page N only clears page N's
  // selection — other slots' nulls (every layer fires on selectionchange)
  // must not clobber the live one.
  const onFlowSelect = useCallback((pg: number, sel: TextSelection | null) => {
    setFlowSel((cur) => {
      if (sel) return { page: pg, sel }
      return cur && cur.page === pg ? null : cur
    })
  }, [])

  // Selections (and paged select mode) don't survive leaving the view they
  // were made in; nor does a definition card (its position is viewport-pinned).
  useEffect(() => {
    setFlowSel(null)
    setSelection(null)
    setSelectMode(false)
    setDefCard(null)
  }, [viewMode])

  // If the selected page's slot unmounts (scrolled far away), the DOM selection
  // vanishes without that layer reporting null — its listener died with it.
  useEffect(() => {
    if (!flowSel) return
    const check = () => {
      const s = window.getSelection()
      if (!s || s.isCollapsed) setFlowSel(null)
    }
    document.addEventListener('selectionchange', check)
    return () => document.removeEventListener('selectionchange', check)
  }, [flowSel])

  // Text Mode: the column is real text — read the browser selection directly.
  // No offsets (reflowed text has no stable page range), so define/copy only.
  useEffect(() => {
    if (viewMode !== 'text') return
    const read = () => {
      const s = window.getSelection()
      if (!s || s.isCollapsed || s.rangeCount === 0) return
      const range = s.getRangeAt(0)
      const node = range.commonAncestorContainer
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
      if (!el?.closest('[data-textreader]')) return
      const text = s.toString()
      if (!text.trim()) return
      const r = range.getBoundingClientRect()
      setFlowSel({
        page: pageRef.current,
        sel: { start: -1, end: -1, text, x: r.left + r.width / 2, y: r.top },
      })
    }
    document.addEventListener('pointerup', read)
    document.addEventListener('selectionchange', read)
    return () => {
      document.removeEventListener('pointerup', read)
      document.removeEventListener('selectionchange', read)
    }
  }, [viewMode])

  const saveHighlight = useCallback(
    async (color: 'amber' | 'sage' = 'amber') => {
      const id = loadedIdRef.current
      // Record against the page the selection was actually made on, not the page
      // state, which could have moved on.
      if (!id || !activeSel || !activeSel.canMark) return
      await addHighlight({
        bookId: id,
        page: activeSel.page,
        start: activeSel.sel.start,
        end: activeSel.sel.end,
        text: activeSel.sel.text.slice(0, 400),
        color,
      })
      setMarks(await listHighlights(id))
      clearSelection()
    },
    [activeSel, clearSelection],
  )

  // Double-tap (touch) / double-click (mouse) on a word → definition card.
  // The word comes from the caret position under the tap, not from a selection,
  // so no native selection ever forms and iOS's edit callout never appears.
  const defineAt = useCallback((x: number, y: number): boolean => {
    const hit = wordAtPoint(x, y)
    if (!hit) return false
    setDefCard({
      word: hit.word,
      x: hit.rect.left + hit.rect.width / 2,
      y: hit.rect.top,
      res: 'loading',
    })
    void lookupWord(hit.word).then((res) => {
      setDefCard((cur) => (cur && cur.word === hit.word ? { ...cur, res: res ?? 'none' } : cur))
    })
    return true
  }, [])

  useEffect(() => {
    if (!dblTapDefine) return
    const isReaderText = (t: EventTarget | null) =>
      t instanceof Element &&
      !!t.closest('[data-text-layer] span[data-s], [data-textreader] p, [data-textreader] h2')
    // Mouse: the browser's own double-click. It also selects the word natively;
    // clear that so the selection popover doesn't pile on top of the card.
    const onDblClick = (e: MouseEvent) => {
      if (!isReaderText(e.target)) return
      if (defineAt(e.clientX, e.clientY)) {
        window.getSelection()?.removeAllRanges()
      }
    }
    // Touch: a hand-rolled double-tap, so the second tap can be cancelled
    // BEFORE WebKit turns it into a word selection (which would summon the
    // system Copy/Look Up/Translate callout right over our card).
    let last = { t: 0, x: 0, y: 0 }
    const onTouchEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0]
      if (!touch || e.touches.length > 0) return
      const now = Date.now()
      const isDouble =
        now - last.t < 350 && Math.hypot(touch.clientX - last.x, touch.clientY - last.y) < 32
      last = { t: now, x: touch.clientX, y: touch.clientY }
      if (!isDouble || !isReaderText(e.target)) return
      if (defineAt(touch.clientX, touch.clientY)) {
        e.preventDefault()
        last.t = 0
      }
    }
    document.addEventListener('dblclick', onDblClick)
    document.addEventListener('touchend', onTouchEnd, { passive: false })
    return () => {
      document.removeEventListener('dblclick', onDblClick)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [dblTapDefine, defineAt])

  // The card dismisses on the next tap anywhere outside it.
  useEffect(() => {
    if (!defCard) return
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-defcard]')) return
      setDefCard(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [defCard])

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
    jumpTo(hit.page)
    setShowSearch(false)
  }, [jumpTo])

  const closeSearch = useCallback(() => {
    setShowSearch(false)
    setSearching(false)
  }, [])

  // iOS ignores <a download> on blob URLs — completely, and doubly so when
  // installed to the home screen — so exports there go to the share sheet
  // (Save to Files, AirDrop, open in Books) instead. The sheet demands a
  // user gesture; a long export outlives the Save tap's activation, so on
  // rejection the file parks in `pendingSave` behind an explicit Share button.
  const deliver = useCallback(async (blob: Blob, name: string) => {
    const file = new File([blob], name, { type: blob.type })
    const shareable =
      isIOS() && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
    if (!shareable) {
      downloadBlob(blob, name)
      return
    }
    try {
      await navigator.share({ files: [file], title: name })
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return // sheet dismissed by the user
      setPendingSave({ blob, name })
    }
  }, [])

  const sharePending = useCallback(async () => {
    const p = pendingSaveRef.current
    if (!p) return
    const file = new File([p.blob], p.name, { type: p.blob.type })
    try {
      await navigator.share({ files: [file], title: p.name })
      setPendingSave(null)
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return // keep it ready for another go
      downloadBlob(p.blob, p.name) // last resort
      setPendingSave(null)
    }
  }, [])

  // The from/to span every export honours (null = whole book), plus the
  // filename tag so ranged files say what they are.
  const exportSpan = useCallback((): { from: number; to: number } | null => {
    if (!exportRange) return null
    return {
      from: Math.max(1, Math.min(extractFrom, extractTo)),
      to: Math.min(pageCount || 1, Math.max(extractFrom, extractTo)),
    }
  }, [exportRange, extractFrom, extractTo, pageCount])
  const spanTag = (span: { from: number; to: number } | null) =>
    span ? ` p${span.from}-${span.to}` : ''

  const onExport = useCallback(async () => {
    const doc = docRef.current
    if (!doc) return
    setExporting(0)
    const span = exportSpan()
    try {
      const blob = await exportDarkPdf(doc, {
        theme: themeById(themeId),
        satCut: SAT_CUT,
        imageDim,
        crop: cropMargins ? cropBox : null,
        from: span?.from,
        to: span?.to,
        onProgress: (done, total) => setExporting(done / total),
      })
      await deliver(blob, `${title || 'nocturne'} (dark)${spanTag(span)}.pdf`)
    } finally {
      setExporting(null)
    }
  }, [themeId, title, imageDim, cropMargins, cropBox, exportSpan, deliver])

  const onVectorExport = useCallback(async () => {
    const doc = docRef.current
    if (!doc) return
    setVexporting(0)
    const span = exportSpan()
    try {
      const book = await getBook(bookId)
      if (!book) return
      const blob = await exportVectorPdf(doc, book.data, {
        theme: themeById(themeId),
        satCut: SAT_CUT,
        crop: cropMargins ? cropBox : null,
        from: span?.from,
        to: span?.to,
        highlights: marks,
        textCache: textCacheRef.current,
        onProgress: (done, total) => setVexporting(done / total),
      })
      await deliver(blob, `${title || 'nocturne'} (dark, vector)${spanTag(span)}.pdf`)
    } finally {
      setVexporting(null)
    }
  }, [bookId, themeId, title, marks, cropMargins, cropBox, exportSpan, deliver])

  const onEpubExport = useCallback(async () => {
    const doc = docRef.current
    if (!doc) return
    setEpubbing(0)
    const span = exportSpan()
    try {
      const blob = await exportEpub(doc, {
        title,
        textCache: textCacheRef.current,
        from: span?.from,
        to: span?.to,
        // The Text Mode setup travels with the book: embedded face + spacing.
        style: {
          fontId: textFontId,
          fontName: (TEXT_FONTS.find((f) => f.id === textFontId) ?? TEXT_FONTS[0]).name,
          stack: fontStack(textFontId),
          leading: textLeading,
          justify: textJustify,
          para: textPara,
        },
        // The author's own TOC, when the PDF has one, beats heading guesses.
        outline: toc,
        onProgress: (done, total) => setEpubbing(done / total),
      })
      await deliver(blob, `${title || 'nocturne'}${spanTag(span)}.epub`)
    } catch {
      setEpubErr(true)
      setTimeout(() => setEpubErr(false), 3000)
    } finally {
      setEpubbing(null)
    }
  }, [title, textFontId, textLeading, textJustify, textPara, toc, exportSpan, deliver])

  const onExtract = useCallback(async () => {
    const from = Math.max(1, Math.min(extractFrom, extractTo))
    const to = Math.min(pageCount || 1, Math.max(extractFrom, extractTo))
    setExtracting(true)
    try {
      const book = await getBook(bookId)
      if (!book) return
      const blob = await extractPages(book.data, from, to)
      await deliver(blob, `${title || 'nocturne'} p${from}-${to}.pdf`)
    } catch {
      setExtractErr(true)
      setTimeout(() => setExtractErr(false), 2500)
    } finally {
      setExtracting(false)
    }
  }, [extractFrom, extractTo, pageCount, bookId, title, deliver])

  // Seed the extract range with wherever you are when the drawer opens.
  useEffect(() => {
    if (showSettings) {
      setExtractFrom(page)
      setExtractTo(page)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- page read at open time only
  }, [showSettings])

  const toggleReadAloud = useCallback(() => {
    if (readAloudRef.current) {
      readAloudRef.current.stop()
      readAloudRef.current = null
      setReading(false)
      return
    }
    const doc = docRef.current
    if (!doc) return
    readAloudRef.current = startReadAloud({
      doc,
      textCache: textCacheRef.current,
      startPage: page,
      onPage: (p) => setPage(p),
      onEnd: () => {
        readAloudRef.current = null
        setReading(false)
      },
    })
    setReading(true)
  }, [page])

  // Never leave a voice running after the reader unmounts.
  useEffect(() => () => readAloudRef.current?.stop(), [])

  // The reader's chrome follows the reading theme, so the page and its frame
  // are one calm surface instead of a dark app around a differently-dark page.
  const theme = themeById(themeId)
  const chromeBg = rgbCss(theme.bg)
  const hairline = 'color-mix(in srgb, currentColor 14%, transparent)'
  const pagePct = pageCount > 1 ? ((page - 1) / (pageCount - 1)) * 100 : 0

  // Pages left in the current chapter: distance to the next outline
  // destination (any depth). Null when the book has no outline.
  const chapterLeft = useMemo(() => {
    if (!toc.length || !pageCount) return null
    let next: number | null = null
    for (const t of toc) {
      if (t.page > page && (next === null || t.page < next)) next = t.page
    }
    return (next ?? pageCount + 1) - page
  }, [toc, page, pageCount])

  return (
    <div
      className="anim-fade relative flex h-full flex-col font-sans"
      style={{ background: chromeBg, color: rgbCss(theme.fg) }}
      onPointerDown={bumpChrome}
    >
      {/* Night dimmer: darkens everything below the OS minimum for dark rooms.
          Sits above the page/chrome but below the drawers (z-40+), so the
          settings slider you're dragging stays at full brightness. */}
      {dim > 0 && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[25] bg-black"
          style={{ opacity: dim }}
        />
      )}
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
          onZoom={setZoom}
          page={page}
          onPage={setPage}
          initialOffset={scrollOff}
          onOffset={setScrollOff}
          onToggleChrome={() => setChrome((c) => !c)}
          textCache={textCacheRef.current}
          highlights={marks}
          onSelect={onFlowSelect}
          renderKey={`${docVersion}:${themeId}:${imageDim}:${cropMargins}:${cropBox ? 'c' : 'n'}`}
        />
      )}

      {viewMode === 'text' && docVersion > 0 && docRef.current && (
        <TextReader
          doc={docRef.current}
          pageCount={pageCount}
          startPage={page}
          fg={rgbCss(theme.fg)}
          bg={chromeBg}
          theme={theme}
          imageDim={imageDim}
          fontPx={textSize}
          leading={textLeading}
          family={fontStack(textFontId)}
          maxWidth={textWidth}
          justify={textJustify}
          paraStyle={textPara}
          textCache={textCacheRef.current}
          onPage={setPage}
          onFontSize={setTextSize}
          onToggleChrome={() => setChrome((c) => !c)}
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
          display:
            (viewMode === 'scroll' || viewMode === 'text' || spreadActive) && docVersion > 0
              ? 'none'
              : undefined,
        }}
      >
        {/* Tap zones: left/right thirds turn pages, the middle toggles chrome.
            Inert in select mode, where a drag means "select", not "turn".
            One-handed option: the left zone turns FORWARD too (back is still
            a swipe or arrow key), so the thumb never has to travel. */}
        <button
          aria-label={leftTapForward ? 'Next page' : 'Previous page'}
          className="absolute inset-y-0 left-0 z-10 w-1/3 disabled:pointer-events-none"
          disabled={selectMode}
          onClick={() => turn(leftTapForward ? 1 : -1)}
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
            {markRects.flatMap(({ id, color, rects }) =>
              rects.map((r, i) => (
                <div
                  key={`${id}-${i}`}
                  className="pointer-events-none absolute rounded-[2px]"
                  style={{
                    left: r.left,
                    top: r.top,
                    width: r.width,
                    height: r.height,
                    background: tintOf(color),
                  }}
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

        {/* Drag-to-turn filmstrip: prev | current | next, centred on current,
            slid by the gesture handler. Display-only (touches go to the
            scroller); covers the live canvas so the turn reads as one motion. */}
        {drag && (
          <div
            data-dragfilm
            className="pointer-events-none absolute inset-0 z-[12] overflow-hidden"
            style={{ background: chromeBg }}
          >
            <div
              ref={trackRef}
              data-dragtrack
              className="flex h-full"
              style={{ width: drag.w * 3, transform: `translateX(${-drag.w}px)` }}
            >
              <BitmapCell bmp={drag.prev} cellW={drag.w} />
              <BitmapCell bmp={drag.cur} cellW={drag.w} />
              <BitmapCell bmp={drag.next} cellW={drag.w} />
            </div>
          </div>
        )}

        {busy && (
          <div className="absolute inset-0 grid place-items-center font-serif italic opacity-60">
            Loading…
          </div>
        )}
      </div>

      {/* Selection popover: highlight and copy, in every view. Definitions
          live on double-tap (the card below), not here — a button inside a
          selection dies with it on iOS. */}
      {activeSel && (
        <div
          className="anim-fade fixed z-40 -translate-x-1/2 -translate-y-full"
          style={{ left: activeSel.sel.x, top: Math.max(48, activeSel.sel.y - 10) }}
        >
          <div className="flex items-stretch overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
            {activeSel.canMark && (
              <>
                <button
                  aria-label="Highlight (amber)"
                  className="flex items-center px-3.5 py-2.5 hover:bg-night-800"
                  onClick={() => void saveHighlight('amber')}
                >
                  <span className="h-4 w-4 rounded-full" style={{ background: '#c9a56a' }} />
                </button>
                <button
                  aria-label="Highlight (sage)"
                  className="flex items-center border-l border-line px-3.5 py-2.5 hover:bg-night-800"
                  onClick={() => void saveHighlight('sage')}
                >
                  <span className="h-4 w-4 rounded-full" style={{ background: '#8fae8b' }} />
                </button>
              </>
            )}
            <button
              className="border-l border-line px-4 py-2.5 text-[13px] text-ink-mid first:border-l-0 hover:bg-night-800"
              onClick={() => {
                void navigator.clipboard?.writeText(activeSel.sel.text)
                clearSelection()
              }}
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Definition card: pinned to the double-tapped word, dismissed by the
          next tap anywhere else. */}
      {defCard && (
        <div
          data-defcard
          className="anim-fade fixed z-40 -translate-x-1/2 -translate-y-full"
          style={{
            left: Math.min(Math.max(defCard.x, 156), window.innerWidth - 156),
            top: Math.max(48, defCard.y - 10),
          }}
        >
          <div className="w-72 max-w-[82vw] rounded-xl border border-line bg-panel p-4 text-left shadow-2xl">
            {defCard.res === 'loading' ? (
              <p className="text-[13px] text-ink-mid">Looking up “{defCard.word}”…</p>
            ) : defCard.res === 'none' ? (
              <p className="text-[13px] text-ink-mid">No definition for “{defCard.word}”.</p>
            ) : (
              <>
                <p className="font-serif text-[15px] font-semibold">{defCard.res.word}</p>
                <ol className="mt-2 space-y-1.5">
                  {defCard.res.senses.slice(0, 4).map((s, i) => (
                    <li key={i} className="text-[13px] leading-snug text-ink-mid">
                      <span className="mr-1.5 italic opacity-60">{POS_LABEL[s.pos]}</span>
                      {s.def}
                    </li>
                  ))}
                </ol>
              </>
            )}
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
              onChange={(e) => jumpTo(Number(e.target.value))}
              className="cozy-range min-w-[100px] flex-1"
              style={{ '--fill': `${pagePct}%` } as React.CSSProperties}
            />
          )}

          <button
            className="whitespace-nowrap text-xs tabular-nums opacity-50 transition-opacity hover:opacity-90"
            aria-label="Switch between percent and pages left in chapter"
            onClick={() =>
              chapterLeft != null && setFooterStat((s) => (s === 'percent' ? 'chapter' : 'percent'))
            }
          >
            {footerStat === 'chapter' && chapterLeft != null
              ? `${chapterLeft} left in ch.`
              : pageCount
                ? `${Math.round((page / pageCount) * 100)}%`
                : ''}
          </button>

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

      {/* After a jump: one tap back to where you were reading. */}
      {backSpot != null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-30 flex justify-center">
          <div className="pointer-events-auto flex items-center overflow-hidden rounded-full border border-line bg-panel/95 shadow-lg">
            <button
              className="px-4 py-1.5 text-xs font-semibold text-accent"
              onClick={() => {
                const spot = backSpot
                setBackSpot(null)
                if (spot != null) setPage(spot)
              }}
            >
              ↩ Back to page {backSpot}
            </button>
            <button
              aria-label="Dismiss"
              className="border-l border-line px-2.5 py-1.5 text-xs text-ink-faint hover:text-ink-mid"
              onClick={() => setBackSpot(null)}
            >
              ✕
            </button>
          </div>
        </div>
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
          <div className="anim-panel fixed inset-y-0 right-0 z-40 w-[min(400px,100%)] overflow-y-auto border-l border-line/70 bg-panel/90 p-5 pb-10 font-sans text-ink-body shadow-[-12px_0_48px_rgba(0,0,0,0.4)] backdrop-blur-2xl">
            <div className="mb-6 flex items-center justify-between">
              <div className="font-serif text-xl text-ink-bright">Reading settings</div>
              <button
                aria-label="Close settings"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-inset text-ink-soft transition-colors hover:text-ink-body"
                onClick={() => setShowSettings(false)}
              >
                ✕
              </button>
            </div>

            <div className="mb-3.5 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
              Theme
            </div>
            <div className="mb-8 grid grid-cols-2 gap-2.5">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`flex h-12 items-center gap-2.5 rounded-xl border-2 px-3.5 text-left transition-transform active:scale-[0.97] ${
                    t.id === themeId ? 'border-accent' : 'border-night-700'
                  }`}
                  style={{ background: rgbCss(t.bg) }}
                  onClick={() => setThemeId(t.id)}
                >
                  <span className="font-serif text-lg leading-none" style={{ color: rgbCss(t.fg) }}>
                    Aa
                  </span>
                  <span
                    className="truncate text-[11px]"
                    style={{ color: rgbCss(t.fg), opacity: 0.75 }}
                  >
                    {t.name}
                  </span>
                </button>
              ))}
            </div>
            <div className="mb-5 flex items-center justify-between rounded-xl bg-inset px-4 py-3">
              <span className="text-[13px] text-ink-body">
                Auto by time <span className="text-ink-faint">(Paper by day, dark at night)</span>
              </span>
              <IosToggle checked={autoTheme} onChange={setAutoTheme} label="Auto theme by time" />
            </div>

            <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
              Layout
            </div>
            <div className="flex rounded-xl bg-inset p-1">
              {(['paged', 'scroll', 'text'] as const).map((m) => (
                <button
                  key={m}
                  className={`flex-1 rounded-[9px] py-2.5 text-[13px] font-semibold capitalize transition-colors ${
                    viewMode === m ? 'bg-accent text-accent-on' : 'text-ink-mid'
                  }`}
                  onClick={() => setViewMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <p className="mb-5 mt-2.5 px-1 text-xs leading-relaxed text-ink-faint">
              {viewMode === 'paged'
                ? 'The exact page. Tap the sides to turn; pinch to zoom; select text to copy or highlight.'
                : viewMode === 'scroll'
                  ? 'The exact pages, flowing as you scroll.'
                  : 'Reflowed into your font and spacing — for prose. Flip to Paged for figure or scanned pages.'}
            </p>

            {viewMode === 'paged' && (
              <div className="mb-7 flex items-center justify-between rounded-2xl bg-night-800/50 px-4 py-3">
                <span className="text-[13px] text-ink-body">
                  Two-page spread <span className="text-ink-faint">(landscape)</span>
                </span>
                <IosToggle checked={spread} onChange={setSpread} label="Two-page spread" />
              </div>
            )}

            {/* Text Mode: font, size, spacing, measure, justification — reflow. */}
            {viewMode === 'text' && (
              <>
                <div className="mb-4 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                  Font
                </div>
                <div className="mb-6 grid grid-cols-2 gap-2">
                  {TEXT_FONTS.map((f) => (
                    <button
                      key={f.id}
                      className={`rounded-xl border px-3 py-2.5 text-left leading-tight transition-colors ${
                        textFontId === f.id
                          ? 'border-accent bg-accent/10 text-ink-bright'
                          : 'border-line text-ink-mid'
                      }`}
                      style={{ fontFamily: f.stack }}
                      onClick={() => setTextFontId(f.id)}
                    >
                      <span className="text-[15px]">{f.name}</span>
                    </button>
                  ))}
                </div>

                <div className="mb-6 divide-y divide-line/60 rounded-2xl bg-night-800/50">
                  <div className="px-4 py-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[13px] text-ink-body">Text size</span>
                      <span className="text-xs tabular-nums text-ink-soft">{textSize}px</span>
                    </div>
                    <div className="flex items-center gap-3.5">
                      <span className="font-serif text-[13px] text-ink-soft">A</span>
                      <input
                        aria-label="Text size"
                        type="range"
                        min={14}
                        max={30}
                        step={1}
                        value={textSize}
                        onChange={(e) => setTextSize(Number(e.target.value))}
                        className="cozy-range flex-1"
                        style={{ '--fill': `${((textSize - 14) / 16) * 100}%` } as React.CSSProperties}
                      />
                      <span className="font-serif text-2xl text-ink-soft">A</span>
                    </div>
                  </div>
                  <div className="px-4 py-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[13px] text-ink-body">Line spacing</span>
                      <span className="text-xs tabular-nums text-ink-soft">
                        {textLeading.toFixed(2)}
                      </span>
                    </div>
                    <input
                      aria-label="Line spacing"
                      type="range"
                      min={1.3}
                      max={2.2}
                      step={0.05}
                      value={textLeading}
                      onChange={(e) => setTextLeading(Number(e.target.value))}
                      className="cozy-range w-full"
                      style={{ '--fill': `${((textLeading - 1.3) / 0.9) * 100}%` } as React.CSSProperties}
                    />
                  </div>
                </div>

                <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                  Reading width
                </div>
                <div className="mb-6 flex rounded-xl bg-inset p-1">
                  {(
                    [
                      ['Narrow', 520],
                      ['Medium', 660],
                      ['Wide', 820],
                    ] as const
                  ).map(([label, w]) => (
                    <button
                      key={w}
                      className={`flex-1 rounded-[9px] py-2 text-[13px] font-medium transition-colors ${
                        textWidth === w ? 'bg-accent text-accent-on' : 'text-ink-mid'
                      }`}
                      onClick={() => setTextWidth(w)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                  Paragraphs
                </div>
                <div className="mb-4 flex rounded-xl bg-inset p-1">
                  <button
                    className={`flex-1 rounded-[9px] py-2 text-[13px] font-medium transition-colors ${
                      textPara === 'indent' ? 'bg-accent text-accent-on' : 'text-ink-mid'
                    }`}
                    onClick={() => setTextPara('indent')}
                  >
                    Indented
                  </button>
                  <button
                    className={`flex-1 rounded-[9px] py-2 text-[13px] font-medium transition-colors ${
                      textPara === 'spaced' ? 'bg-accent text-accent-on' : 'text-ink-mid'
                    }`}
                    onClick={() => setTextPara('spaced')}
                  >
                    Spaced
                  </button>
                </div>
                <div className="mb-8 flex items-center justify-between rounded-2xl bg-night-800/50 px-4 py-3">
                  <span className="text-[13px] text-ink-body">
                    Justify <span className="text-ink-faint">(+ hyphenate)</span>
                  </span>
                  <IosToggle
                    checked={textJustify}
                    onChange={setTextJustify}
                    label="Justify text"
                  />
                </div>
              </>
            )}

            {/* Page image: zoom (paged/scroll, not spread), brightness, crop —
                grouped as one card; none of it applies to reflow. */}
            {viewMode !== 'text' && (
              <div className="mb-7 divide-y divide-line/60 rounded-2xl bg-night-800/50">
                {!spreadActive && (
                  <div className="px-4 py-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[13px] text-ink-body">Zoom</span>
                      <span className="text-xs tabular-nums text-ink-soft">{zoom.toFixed(1)}×</span>
                    </div>
                    <div className="flex items-center gap-3.5">
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
                      <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                        At 1× the whole page fits the screen; slide up to fill the width.
                      </p>
                    )}
                  </div>
                )}
                <div className="px-4 py-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[13px] text-ink-body">Image brightness</span>
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
                    className="cozy-range w-full"
                    style={{ '--fill': `${((imageDim - 0.4) / 0.6) * 100}%` } as React.CSSProperties}
                  />
                </div>
                {cropBox && (
                  <div className="flex items-center justify-between px-4 py-3">
                    <span className="text-[13px] text-ink-body">Crop margins</span>
                    <IosToggle
                      checked={cropMargins}
                      onChange={setCropMargins}
                      label="Crop margins"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Screen: device/environment comfort, not per-book. */}
            <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">Screen</div>
            <div className="divide-y divide-line/60 rounded-2xl bg-night-800/50">
              <div className="px-4 py-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[13px] text-ink-body">Night dimmer</span>
                  <span className="text-xs tabular-nums text-ink-soft">{Math.round(dim * 100)}%</span>
                </div>
                <input
                  aria-label="Night dimmer"
                  type="range"
                  min={0}
                  max={0.75}
                  step={0.05}
                  value={dim}
                  onChange={(e) => setDim(Number(e.target.value))}
                  className="cozy-range w-full"
                  style={{ '--fill': `${(dim / 0.75) * 100}%` } as React.CSSProperties}
                />
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[13px] text-ink-body">Auto-hide controls</span>
                <IosToggle checked={autoHide} onChange={setAutoHide} label="Auto-hide controls" />
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[13px] text-ink-body">
                  Double-tap defines a word <span className="text-ink-faint">(dictionary)</span>
                </span>
                <IosToggle
                  checked={dblTapDefine}
                  onChange={setDblTapDefine}
                  label="Double-tap defines a word"
                />
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[13px] text-ink-body">
                  Left tap turns forward <span className="text-ink-faint">(one-handed)</span>
                </span>
                <IosToggle
                  checked={leftTapForward}
                  onChange={setLeftTapForward}
                  label="Left tap turns forward"
                />
              </div>
              {/* iOS Safari has no Vibration API — a toggle that can't do
                  anything shouldn't exist there. */}
              {'vibrate' in navigator && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px] text-ink-body">
                    Haptic page turns <span className="text-ink-faint">(a tiny buzz)</span>
                  </span>
                  <IosToggle checked={haptics} onChange={setHaptics} label="Haptics" />
                </div>
              )}
            </div>
            <p className="mb-5 mt-2 px-1 text-xs leading-relaxed text-ink-faint">
              Dims below the phone's minimum brightness for reading in the dark.
            </p>

            {'speechSynthesis' in window && (
              <div className="mb-7 flex items-center justify-between rounded-2xl bg-night-800/50 px-4 py-3">
                <span className="text-[13px] text-ink-body">
                  Read aloud <span className="text-ink-faint">(follows along)</span>
                </span>
                <button
                  className={`rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors ${
                    reading
                      ? 'bg-accent text-accent-on'
                      : 'border border-accent/40 text-accent hover:border-accent'
                  }`}
                  onClick={toggleReadAloud}
                >
                  {reading ? '◼ Stop' : '▶ Play'}
                </button>
              </div>
            )}

            {/* One export model: choose the scope (whole book or a page
                range), then a format. Every format follows the current reading
                setup — theme, image brightness, crop, Text Mode type — so what
                you save is what you saw. */}
            <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
              Export
            </div>
            <div className="flex rounded-xl bg-inset p-1">
              {([false, true] as const).map((r) => (
                <button
                  key={String(r)}
                  className={`flex-1 rounded-[9px] py-2.5 text-[13px] font-semibold transition-colors ${
                    exportRange === r ? 'bg-accent text-accent-on' : 'text-ink-mid'
                  }`}
                  onClick={() => setExportRange(r)}
                >
                  {r ? 'Page range' : 'Whole book'}
                </button>
              ))}
            </div>
            {exportRange && (
              <div className="mt-2.5 flex items-center gap-2 px-1">
                <input
                  aria-label="Export from page"
                  type="number"
                  min={1}
                  max={pageCount || 1}
                  value={extractFrom}
                  onChange={(e) => setExtractFrom(Number(e.target.value) || 1)}
                  className="w-16 rounded-xl border border-line bg-inset px-2 py-2 text-center text-sm tabular-nums text-ink-body outline-none focus:border-accent/60"
                />
                <span className="text-xs text-ink-soft">to</span>
                <input
                  aria-label="Export to page"
                  type="number"
                  min={1}
                  max={pageCount || 1}
                  value={extractTo}
                  onChange={(e) => setExtractTo(Number(e.target.value) || 1)}
                  className="w-16 rounded-xl border border-line bg-inset px-2 py-2 text-center text-sm tabular-nums text-ink-body outline-none focus:border-accent/60"
                />
                <span className="text-[11px] text-ink-faint">of {pageCount || '—'}</span>
              </div>
            )}
            {/* A long export outlives its tap's user activation, so the share
                sheet can't open by itself — the finished file waits here. */}
            {pendingSave && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-night-800/50 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-ink-body">{pendingSave.name}</div>
                  <div className="text-[11px] text-ink-faint">Ready — send it to Files or Books</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-semibold text-accent-on transition-colors hover:bg-accent-hi"
                    onClick={() => void sharePending()}
                  >
                    Share…
                  </button>
                  <button
                    aria-label="Discard export"
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-inset text-ink-soft transition-colors hover:text-ink-body"
                    onClick={() => setPendingSave(null)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
            <div className="mt-3 divide-y divide-line/60 rounded-2xl bg-night-800/50">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-[13px] text-ink-body">Dark PDF</div>
                  <div className="text-[11px] text-ink-faint">
                    The exact pages in this theme — keeps the book's own font
                  </div>
                </div>
                <button
                  className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-semibold text-accent-on transition-colors hover:bg-accent-hi disabled:opacity-50"
                  disabled={!pageCount || exporting !== null}
                  onClick={onExport}
                >
                  {exporting !== null ? `${Math.round(exporting * 100)}%` : 'Save'}
                </button>
              </div>

              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-[13px] text-ink-body">
                    Dark PDF, vector <span className="text-ink-faint">(beta)</span>
                  </div>
                  <div className="text-[11px] text-ink-faint">
                    Same pages, selectable text, much smaller file
                  </div>
                </div>
                <button
                  className="rounded-full border border-accent/40 px-4 py-1.5 text-[13px] font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
                  disabled={!pageCount || vexporting !== null}
                  onClick={() => void onVectorExport()}
                >
                  {vexporting !== null ? `${Math.round(vexporting * 100)}%` : 'Save'}
                </button>
              </div>

              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-[13px] text-ink-body">
                    EPUB <span className="text-ink-faint">(beta)</span>
                  </div>
                  <div className="text-[11px] text-ink-faint">
                    {epubErr
                      ? 'Needs a text layer — scans need OCR'
                      : 'The only format that takes your font, spacing and justify'}
                  </div>
                </div>
                <button
                  className="rounded-full border border-accent/40 px-4 py-1.5 text-[13px] font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
                  disabled={!pageCount || epubbing !== null}
                  onClick={() => void onEpubExport()}
                >
                  {epubbing !== null ? `${Math.round(epubbing * 100)}%` : 'Save'}
                </button>
              </div>

              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-[13px] text-ink-body">Original pages</div>
                  <div className="text-[11px] text-ink-faint">
                    {extractErr
                      ? 'Couldn’t extract from this PDF'
                      : exportRange
                        ? 'The untouched pages — share a chapter'
                        : 'Pick a page range above to share a chapter'}
                  </div>
                </div>
                <button
                  className="rounded-full border border-accent/40 px-4 py-1.5 text-[13px] font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
                  disabled={!pageCount || extracting || !exportRange}
                  onClick={() => void onExtract()}
                >
                  {extracting ? '…' : 'Save'}
                </button>
              </div>
            </div>

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
            <div className="flex items-center gap-2">
              {(bookmarks.length > 0 || marks.length > 0) && (
                <button
                  className="rounded-lg border border-line bg-inset px-3 py-1.5 text-xs text-ink-soft transition-colors hover:text-ink-body"
                  onClick={() => {
                    const md = notesMarkdown(title, bookmarks, marks)
                    void deliver(
                      new Blob([md], { type: 'text/markdown' }),
                      `${title || 'nocturne'} — notes.md`,
                    )
                  }}
                >
                  Export notes
                </button>
              )}
              <button
                aria-label="Close contents"
                className="h-8 w-8 rounded-lg border border-line bg-inset text-ink-soft transition-colors hover:text-ink-body"
                onClick={() => setShowToc(false)}
              >
                ✕
              </button>
            </div>
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
                          jumpTo(b.page)
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
                        jumpTo(m.page)
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
                  jumpTo(t.page)
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

// iOS-style switch for the settings drawer. A native <button> keeps the
// keyboard/AT semantics (role="switch", Space/Enter); the knob is warm-white
// so it reads as a physical control on the dark panel.
function IosToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative h-7 w-12 flex-none rounded-full transition-colors duration-200 ${
        checked ? 'bg-accent' : 'bg-night-700'
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute left-0 top-0.5 h-6 w-6 rounded-full bg-ink-bright shadow transition-transform duration-200 ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
