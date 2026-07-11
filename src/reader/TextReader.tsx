import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from '../engine/pdf'
import { getPageText, type TextCache } from '../engine/search'
import { reconstructPage, stitch, type Block } from '../engine/reflow'

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

interface Item {
  page: number
  blocks: Block[]
}

export function TextReader({
  doc,
  pageCount,
  startPage,
  fg,
  bg,
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

  const reflowPage = useCallback(
    async (pageNo: number): Promise<Item> => {
      const pt = await getPageText(await doc.getPage(pageNo), textCache)
      return { page: pageNo, blocks: reconstructPage(pt) }
    },
    [doc, textCache],
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
      if (first.blocks.length === 0) {
        // Nothing on this page — try to find text nearby before giving up.
        let found: Item | null = null
        for (let d = 1; d <= 3 && !found; d++) {
          for (const n of [initialPageRef.current + d, initialPageRef.current - d]) {
            if (n < 1 || n > pageCount) continue
            const it = await reflowPage(n)
            if (it.blocks.length) {
              found = it
              break
            }
          }
        }
        if (!alive) return
        if (found) {
          setItems([found])
          reportedRef.current = found.page
        } else setEmpty(true)
      } else {
        setItems([first])
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
      setEmpty(it.blocks.length === 0)
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
            const merged = [...cur, it]
            stitch(cur[cur.length - 1].blocks, it.blocks)
            return merged
          }
          anchorRef.current = scroller.scrollHeight // preserve position on prepend
          stitch(it.blocks, cur[0].blocks)
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
            {it.blocks.map((b, i) => {
              if (b.kind === 'h') {
                return (
                  <h2
                    key={i}
                    className="mb-4 mt-9 font-semibold"
                    style={{ fontSize: '1.3em', lineHeight: 1.2, fontFamily, textAlign: 'left' }}
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
            })}
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
