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

export type TextFont = 'serif' | 'sans'

interface TextReaderProps {
  doc: PDFDocumentProxy
  pageCount: number
  startPage: number
  fg: string
  bg: string
  fontPx: number
  leading: number
  family: TextFont
  textCache: TextCache
  onPage: (page: number) => void
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
  textCache,
  onPage,
  onToggleChrome,
}: TextReaderProps) {
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

  // Start at the page you were on; scanned/no-text pages yield nothing.
  useEffect(() => {
    let alive = true
    void (async () => {
      const first = await reflowPage(startPage)
      if (!alive) return
      if (first.blocks.length === 0) {
        // Nothing on this page — try to find text nearby before giving up.
        let found: Item | null = null
        for (let d = 1; d <= 3 && !found; d++) {
          for (const n of [startPage + d, startPage - d]) {
            if (n < 1 || n > pageCount) continue
            const it = await reflowPage(n)
            if (it.blocks.length) {
              found = it
              break
            }
          }
        }
        if (!alive) return
        if (found) setItems([found])
        else setEmpty(true)
      } else {
        setItems([first])
      }
    })()
    return () => {
      alive = false
    }
  }, [reflowPage, startPage, pageCount])

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

  const fontFamily = family === 'serif' ? 'Lora, Georgia, serif' : 'Inter, system-ui, sans-serif'

  if (empty) {
    return (
      <div ref={scrollerRef} className="relative flex-1 overflow-auto" onClick={onToggleChrome}>
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
      className="relative flex-1 overflow-auto"
      style={{ background: bg, color: fg }}
      onClick={onToggleChrome}
    >
      <div
        className="mx-auto px-6 py-10"
        style={{ maxWidth: 680, fontFamily, fontSize: fontPx, lineHeight: leading }}
      >
        {items.map((it) => (
          <section key={it.page} data-textpage={it.page}>
            {it.blocks.map((b, i) =>
              b.kind === 'h' ? (
                <h2
                  key={i}
                  className="mb-4 mt-8 font-semibold"
                  style={{ fontSize: '1.3em', lineHeight: 1.2, fontFamily }}
                >
                  {b.text}
                </h2>
              ) : (
                <p key={i} className="mb-[0.9em]" style={{ textWrap: 'pretty' }}>
                  {b.text}
                </p>
              ),
            )}
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
