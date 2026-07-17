import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EpubDoc } from '../engine/epub'

// The EPUB reading surface: a scrolling column of sanitized chapter HTML in
// YOUR typography — the publisher's structure, Nocturne's dress. Chapters
// stream in as you scroll (append forward, prepend backward with scroll
// anchoring), exactly like TextReader streams pages. Position is
// chapter + fraction-of-chapter, reported up for progress/sync; the parent
// maps chapters onto its existing page plumbing (page N = chapter N).

interface EpubReaderProps {
  epub: EpubDoc
  /** Current chapter, 0-based (controlled; parent's `page` minus one). */
  chapter: number
  onChapter: (chapter: number) => void
  /** Fraction within the chapter to restore on first layout; consumed once. */
  initialFrac?: number | null
  /** Reports the in-chapter fraction as the user scrolls (throttled). */
  onFrac?: (frac: number) => void
  /** An internal link was tapped — the parent records it as a jump. */
  onJump?: (chapter: number) => void
  fg: string
  bg: string
  fontPx: number
  leading: number
  family: string
  maxWidth: number
  justify: boolean
  paraStyle: 'indent' | 'spaced'
  onToggleChrome: () => void
}

export function EpubReader({
  epub,
  chapter,
  onChapter,
  initialFrac,
  onFrac,
  onJump,
  fg,
  bg,
  fontPx,
  leading,
  family,
  maxWidth,
  justify,
  paraStyle,
  onToggleChrome,
}: EpubReaderProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [items, setItems] = useState<number[]>([]) // loaded chapter indexes, contiguous
  const anchorRef = useRef<number | null>(null)
  const reportedRef = useRef(chapter)
  const initialFracRef = useRef<number | null>(initialFrac ?? null)
  const onFracRef = useRef(onFrac)
  onFracRef.current = onFrac
  const fracTimer = useRef<number | undefined>(undefined)
  /** A tapped footnote, shown in place instead of jumping away. */
  const [note, setNote] = useState<{ x: number; y: number; text: string } | null>(null)
  const pendingFrag = useRef<string | null>(null)

  // Scroll to a fragment target once its chapter has rendered.
  useLayoutEffect(() => {
    const frag = pendingFrag.current
    if (!frag) return
    pendingFrag.current = null
    const scroller = scrollerRef.current
    const el = scroller?.querySelector(`#${CSS.escape(frag)}`)
    if (scroller && el instanceof HTMLElement) {
      scroller.scrollTop = Math.max(0, el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 80)
    }
  }, [items])

  // The footnote card dismisses on the next tap anywhere outside it.
  useEffect(() => {
    if (!note) return
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-epubnote]')) return
      setNote(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [note])

  /** Internal links: footnotes pop up in place; everything else jumps. */
  const onLinkTap = useCallback(
    (e: React.MouseEvent) => {
      const link = (e.target as Element).closest?.('[data-el]')
      if (!(link instanceof HTMLElement)) return false
      e.stopPropagation()
      const raw = link.dataset.el
      const target = raw === 'same' ? reportedRef.current : Number(raw)
      const frag = link.dataset.ef ?? null
      if (link.dataset.note && frag) {
        const text = epub.noteText(Number.isFinite(target) ? target : reportedRef.current, frag)
        if (text) {
          const r = link.getBoundingClientRect()
          setNote({ x: r.left + r.width / 2, y: r.bottom, text })
          return true
        }
      }
      if (!Number.isFinite(target) || target < 0 || target >= epub.chapterCount) return true
      pendingFrag.current = frag
      if (items.includes(target)) {
        const scroller = scrollerRef.current
        const sec = scroller?.querySelector<HTMLElement>(`[data-epubchapter="${target}"]`)
        if (scroller && sec) {
          const el = frag ? sec.querySelector(`#${CSS.escape(frag)}`) : null
          scroller.scrollTop =
            el instanceof HTMLElement
              ? Math.max(0, el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 80)
              : sec.offsetTop
          pendingFrag.current = null
        }
      } else {
        reportedRef.current = target
        setItems([target])
        requestAnimationFrame(() => {
          if (!pendingFrag.current && scrollerRef.current) scrollerRef.current.scrollTop = 0
        })
      }
      onJump?.(target)
      return true
    },
    [epub, items, onJump],
  )

  // Load once per book, at the chapter you were on.
  useEffect(() => {
    setItems([Math.max(0, Math.min(epub.chapterCount - 1, reportedRef.current))])
  }, [epub])

  // Restore the exact in-chapter spot once the first chapter has laid out.
  useLayoutEffect(() => {
    const frac = initialFracRef.current
    if (frac == null || !items.length) return
    initialFracRef.current = null
    const scroller = scrollerRef.current
    const sec = scroller?.querySelector<HTMLElement>(`[data-epubchapter="${items[0]}"]`)
    if (scroller && sec) scroller.scrollTop = sec.offsetTop + sec.offsetHeight * frac
  }, [items])

  // External jump (Contents, scrubber, back-pill): a chapter we didn't report.
  useEffect(() => {
    if (chapter === reportedRef.current) return
    reportedRef.current = chapter
    const scroller = scrollerRef.current
    const sec = scroller?.querySelector<HTMLElement>(`[data-epubchapter="${chapter}"]`)
    if (scroller && sec) {
      scroller.scrollTop = sec.offsetTop
      return
    }
    setItems([Math.max(0, Math.min(epub.chapterCount - 1, chapter))])
    requestAnimationFrame(() => {
      if (scrollerRef.current) scrollerRef.current.scrollTop = 0
    })
  }, [chapter, epub])

  const extend = useCallback(
    (dir: 1 | -1) => {
      setItems((cur) => {
        if (!cur.length) return cur
        const next = dir === 1 ? cur[cur.length - 1] + 1 : cur[0] - 1
        if (next < 0 || next >= epub.chapterCount || cur.includes(next)) return cur
        if (dir === -1 && scrollerRef.current) anchorRef.current = scrollerRef.current.scrollHeight
        return dir === 1 ? [...cur, next] : [next, ...cur]
      })
    },
    [epub],
  )

  // Keep the view still when a chapter is prepended above.
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
    if (scrollTop < 600) extend(-1)
    if (scrollTop + clientHeight > scrollHeight - 900) extend(1)

    // Which chapter owns the top of the viewport, and how far into it are we?
    const secs = scroller.querySelectorAll<HTMLElement>('[data-epubchapter]')
    let current: HTMLElement | null = null
    for (const s of secs) {
      if (s.offsetTop <= scrollTop + 1) current = s
      else break
    }
    if (!current && secs.length) current = secs[0]
    if (!current) return
    const idx = Number(current.dataset.epubchapter)
    const frac =
      current.offsetHeight > 0
        ? Math.max(0, Math.min(1, (scrollTop - current.offsetTop) / current.offsetHeight))
        : 0
    if (idx !== reportedRef.current) {
      reportedRef.current = idx
      onChapter(idx)
    }
    if (fracTimer.current === undefined) {
      fracTimer.current = window.setTimeout(() => {
        fracTimer.current = undefined
        onFracRef.current?.(frac)
      }, 400)
    }
  }, [extend, onChapter])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [onScroll])

  return (
    <div
      ref={scrollerRef}
      data-textreader
      className="nocturne-epub relative flex-1 overflow-y-auto overflow-x-hidden"
      style={{ background: bg, color: fg }}
      onClick={(e) => {
        if (onLinkTap(e)) return
        const s = window.getSelection()
        if (s && !s.isCollapsed) return
        onToggleChrome()
      }}
    >
      <div
        lang="en"
        className="mx-auto px-6 py-10"
        style={{
          maxWidth,
          fontFamily: family,
          fontSize: fontPx,
          lineHeight: leading,
          textAlign: justify ? 'justify' : 'left',
          hyphens: justify ? 'auto' : 'manual',
          WebkitHyphens: justify ? 'auto' : 'manual',
        }}
      >
        {items.map((i) => (
          <section
            key={i}
            data-epubchapter={i}
            className={paraStyle === 'indent' ? 'epub-indent' : 'epub-spaced'}
            // Sanitized by engine/epub.ts: allowlisted tags, no attributes
            // except our own blob: image srcs. Nothing from the wire runs.
            dangerouslySetInnerHTML={{ __html: epub.chapterHtml(i) }}
          />
        ))}
        <div className="py-10 text-center text-xs opacity-40">
          {items.length && items[items.length - 1] >= epub.chapterCount - 1 ? 'End' : '···'}
        </div>
      </div>
      {note && (
        <div
          data-epubnote
          className="anim-fade fixed z-40 -translate-x-1/2"
          style={{
            left: Math.min(Math.max(note.x, 160), window.innerWidth - 160),
            top: Math.min(note.y + 10, window.innerHeight - 220),
          }}
        >
          <div
            className="max-h-[38vh] w-[300px] max-w-[86vw] overflow-y-auto rounded-2xl border p-4 text-left text-[13px] leading-relaxed shadow-2xl backdrop-blur-xl"
            style={{
              background: `color-mix(in srgb, ${bg} 92%, ${fg} 5%)`,
              color: fg,
              borderColor: 'color-mix(in srgb, currentColor 18%, transparent)',
            }}
          >
            {note.text}
          </div>
        </div>
      )}
    </div>
  )
}
