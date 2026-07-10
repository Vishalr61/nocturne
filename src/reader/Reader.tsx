import { useCallback, useEffect, useRef, useState } from 'react'
import { openPdf, renderPageToCanvas, type PDFDocumentProxy } from '../engine/pdf'
import { Recolorizer } from '../engine/recolor'
import { THEMES, themeById, DEFAULT_THEME } from '../engine/theme'
import { classifyPage, type PageClassification } from '../engine/classify'
import { exportDarkPdf, downloadBlob } from '../export/exportPdf'
import {
  addBook,
  getProfile,
  getProgress,
  hashBytes,
  saveProfile,
  saveProgress,
} from '../storage/db'

// The v1 reader: open a PDF, see it recolored crisply on a canvas, flip pages,
// switch themes, tune the "keep colour images" threshold. Position + look are
// persisted per book so reopening resumes exactly where you left off.

export function Reader() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const recolorRef = useRef<Recolorizer | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const bookIdRef = useRef<string | null>(null)

  // Bumped when a new document is opened. draw() reads the doc from a ref, so it
  // needs a state dep to fire for a fresh book whose page/zoom/theme match the
  // current values — otherwise the first page never renders.
  const [docVersion, setDocVersion] = useState(0)
  const [title, setTitle] = useState('')
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [themeId, setThemeId] = useState(DEFAULT_THEME.id)
  const [satCut, setSatCut] = useState(0.25)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState(false)
  const [cls, setCls] = useState<PageClassification | null>(null)
  const [exporting, setExporting] = useState<number | null>(null) // 0..1 progress

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

    const [source, classification] = await Promise.all([
      renderPageToCanvas(pdfPage, cssScale, dpr),
      classifyPage(pdfPage),
    ])
    setCls(classification)
    recolorRef.current.render(source, source.width, source.height, {
      theme: themeById(themeId),
      satCut,
    })
    // Display exactly at render resolution; when zoom > 1 the canvas overflows
    // the container and overflow-auto provides panning.
    canvas.style.width = `${source.width / dpr}px`
    canvas.style.height = `${source.height / dpr}px`
  }, [page, zoom, themeId, satCut, docVersion])

  // Re-render on viewport changes (rotation, window resize) so fit-width holds.
  useEffect(() => {
    const onResize = () => void draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  useEffect(() => {
    void draw()
  }, [draw])

  // Persist look + position (debounced-ish via effect deps).
  useEffect(() => {
    const id = bookIdRef.current
    if (!id) return
    void saveProfile({ bookId: id, themeId, satCut, strength: 1, zoom })
    void saveProgress({
      bookId: id,
      page,
      percent: pageCount ? page / pageCount : 0,
      updatedAt: Date.now(),
    })
  }, [themeId, satCut, zoom, page, pageCount])

  const onFile = useCallback(async (file: File) => {
    setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const id = await hashBytes(buf)
      const doc = await openPdf(buf)
      docRef.current = doc
      bookIdRef.current = id
      setDocVersion((v) => v + 1)
      setTitle(file.name.replace(/\.pdf$/i, ''))
      setPageCount(doc.numPages)

      await addBook({
        id,
        title: file.name.replace(/\.pdf$/i, ''),
        addedAt: Date.now(),
        pageCount: doc.numPages,
        size: buf.byteLength,
        data: buf,
      })

      const [profile, progress] = await Promise.all([getProfile(id), getProgress(id)])
      if (profile) {
        setThemeId(profile.themeId)
        setSatCut(profile.satCut)
        setZoom(profile.zoom)
      }
      setPage(progress?.page ?? 1)
    } finally {
      setBusy(false)
    }
  }, [])

  const turn = (delta: number) =>
    setPage((p) => Math.min(pageCount || 1, Math.max(1, p + delta)))

  const onExport = useCallback(async () => {
    const doc = docRef.current
    if (!doc) return
    setExporting(0)
    try {
      const blob = await exportDarkPdf(doc, {
        theme: themeById(themeId),
        satCut,
        onProgress: (done, total) => setExporting(done / total),
      })
      downloadBlob(blob, `${title || 'nocturne'} (dark).pdf`)
    } finally {
      setExporting(null)
    }
  }, [themeId, satCut, title])

  return (
    <div className="flex h-full flex-col bg-night-950 text-neutral-200">
      <header className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className="font-semibold tracking-tight">Nocturne</span>
        <span className="truncate text-neutral-500">{title || 'Open a PDF to begin'}</span>
        <label className="ml-auto cursor-pointer rounded-md bg-night-700 px-3 py-1.5 text-neutral-200 hover:bg-night-800">
          Open PDF
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
      </header>

      <div ref={containerRef} className="relative flex-1 overflow-auto">
        {/* Tap zones for page turns (phone-first). */}
        <button
          aria-label="Previous page"
          className="absolute inset-y-0 left-0 z-10 w-1/3"
          onClick={() => turn(-1)}
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
          Keep colour
          <input
            type="range"
            min={0.1}
            max={0.6}
            step={0.01}
            value={satCut}
            onChange={(e) => setSatCut(Number(e.target.value))}
          />
        </label>

        <label className="flex items-center gap-2 text-neutral-400">
          Zoom
          <input
            type="range"
            min={0.5}
            max={3}
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
    </div>
  )
}
