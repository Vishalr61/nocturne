import { useCallback, useEffect, useRef, useState } from 'react'
import { openPdf, type PDFDocumentProxy } from '../engine/pdf'
import { Recolorizer } from '../engine/recolor'
import { THEMES, themeById, DEFAULT_THEME } from '../engine/theme'
import { generateThumbnail, renderDarkPage } from '../engine/pipeline'
import type { PageClassification } from '../engine/classify'
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

  // Pinch commit data: applied (then cleared) by the next draw().
  const pinchCommitRef = useRef<{ factor: number; fx: number; fy: number } | null>(null)

  // --- load the book from local storage -------------------------------------
  useEffect(() => {
    let alive = true
    setBusy(true)
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

      const [profile, progress] = await Promise.all([getProfile(bookId), getProgress(bookId)])
      if (!alive) return
      if (profile) {
        setThemeId(profile.themeId)
        setImageDim(profile.imageDim ?? 0.82)
        setZoom(profile.zoom)
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

  // --- render the current page ----------------------------------------------
  const draw = useCallback(async () => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas) return
    if (!recolorRef.current) recolorRef.current = new Recolorizer(canvas)

    const pdfPage = await doc.getPage(page)

    // Fit-width base scale: zoom=1 fills the container exactly, and the canvas is
    // displayed at its own CSS size (set below) so 1 backing pixel = 1 device
    // pixel — the browser never rescales the render (that rescale = blur).
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const pageWidth = pdfPage.getViewport({ scale: 1 }).width
    const containerWidth = containerRef.current
      ? containerRef.current.clientWidth - 16 // p-2 padding both sides
      : pageWidth
    const cssScale = Math.max(0.1, containerWidth / pageWidth) * zoom

    // The pipeline decides polarity, image masking, and colour-text handling
    // per page, then draws the recolored result into our canvas.
    const { source, cls: classification } = await renderDarkPage(
      pdfPage,
      cssScale,
      dpr,
      recolorRef.current,
      { theme: themeById(themeId), satCut: SAT_CUT, imageDim },
    )
    setCls(classification)
    // Display exactly at render resolution; when zoom > 1 the canvas overflows
    // the container and overflow-auto provides panning.
    canvas.style.width = `${source.width / dpr}px`
    canvas.style.height = `${source.height / dpr}px`
    canvas.style.transform = '' // clear any live pinch preview

    // Keep the pinch focal point where the fingers were.
    const commit = pinchCommitRef.current
    const scroller = containerRef.current
    if (commit && scroller) {
      pinchCommitRef.current = null
      scroller.scrollLeft = (scroller.scrollLeft + commit.fx) * commit.factor - commit.fx
      scroller.scrollTop = (scroller.scrollTop + commit.fy) * commit.factor - commit.fy
    }
  }, [page, zoom, themeId, imageDim, docVersion])

  useEffect(() => {
    void draw()
  }, [draw])

  // Re-render on viewport changes (rotation, window resize) so fit-width holds.
  useEffect(() => {
    const onResize = () => void draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  // --- pinch to zoom ----------------------------------------------------------
  useEffect(() => {
    const scroller = containerRef.current
    const canvas = canvasRef.current
    if (!scroller || !canvas) return

    let startDist = 0
    let startZoom = 1
    let factor = 1
    let fx = 0
    let fy = 0
    let active = false

    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      e.preventDefault() // stop the browser zooming the whole app
      const rect = scroller.getBoundingClientRect()
      startDist = dist(e.touches)
      startZoom = zoom
      factor = 1
      fx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
      fy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
      active = true
    }

    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 2) return
      e.preventDefault()
      factor = dist(e.touches) / startDist
      // Clamp the preview to what the commit will allow.
      factor = Math.min(4, Math.max(1, startZoom * factor)) / startZoom
      // Live preview: cheap CSS scale about the focal point. The commit below
      // re-renders vector-crisp, so this soft preview lasts only the gesture.
      const cRect = canvas.getBoundingClientRect()
      const sRect = scroller.getBoundingClientRect()
      const ox = fx + sRect.left - cRect.left
      const oy = fy + sRect.top - cRect.top
      canvas.style.transformOrigin = `${ox}px ${oy}px`
      canvas.style.transform = `scale(${factor})`
    }

    const onEnd = (e: TouchEvent) => {
      if (!active || e.touches.length >= 2) return
      active = false
      const next = Math.min(4, Math.max(1, startZoom * factor))
      if (Math.abs(next - startZoom) < 0.02) {
        canvas.style.transform = ''
        return
      }
      pinchCommitRef.current = { factor: next / startZoom, fx, fy }
      setZoom(next) // triggers a crisp re-render; draw() clears the preview
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
    void saveProfile({ bookId: id, themeId, satCut: SAT_CUT, strength: 1, zoom, imageDim })
    void saveProgress({
      bookId: id,
      page,
      percent: pageCount ? page / pageCount : 0,
      updatedAt: Date.now(),
    })
  }, [themeId, imageDim, zoom, page, pageCount])

  const turn = (delta: number) =>
    setPage((p) => Math.min(pageCount || 1, Math.max(1, p + delta)))

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
    <div className="flex h-full flex-col bg-night-950 text-neutral-200">
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
            <span className="tabular-nums text-neutral-400">
              {pageCount ? `${page} / ${pageCount}` : '—'}
            </span>
            <button className="rounded bg-night-700 px-2 py-1" onClick={() => turn(1)}>
              ›
            </button>
          </div>

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
    </div>
  )
}
