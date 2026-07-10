import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFPageProxy, CropBox } from '../engine/pdf'
import { runBoxes, type PageText, type RunBox, type TextCache } from '../engine/search'

// An invisible, selectable copy of the page's text, laid over the recolored
// canvas — the same trick pdf.js's own viewer uses. Nothing here is painted:
// the glyphs you see are the canvas's. These transparent spans exist so the
// browser's native selection (and long-press on iOS) has something to grab,
// which is what makes copy and passage highlights possible at all.
//
// Each span carries its offset into the page's flattened text, so a DOM
// selection converts back into a [start,end) character range. Ranges — not
// pixel rects — are what we persist: they survive zoom, margin-crop, and a
// different device's screen, because the rects are recomputed from geometry.

export interface TextSelection {
  start: number
  end: number
  text: string
  /** Viewport coords of the selection's end, for placing the popover. */
  x: number
  y: number
}

interface TextLayerProps {
  page: PDFPageProxy
  pageNo: number
  cssScale: number
  crop: CropBox | null
  cache: TextCache
  /** Off by default: while off, taps fall through to the page-turn zones. */
  active: boolean
  onSelect: (sel: TextSelection | null) => void
}

export function TextLayer({
  page,
  pageNo,
  cssScale,
  crop,
  cache,
  active,
  onSelect,
}: TextLayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [boxes, setBoxes] = useState<RunBox[]>([])
  const ptRef = useRef<PageText | null>(null)

  useEffect(() => {
    // The proxy is the authority on which page this is; a mismatch means the
    // caller's state is mid-flight and its geometry can't be trusted yet.
    if (page.pageNumber !== pageNo) return
    let alive = true
    void (async () => {
      try {
        const { pt, boxes } = await runBoxes(page, cache, cssScale, crop)
        if (!alive) return
        ptRef.current = pt
        setBoxes(boxes)
      } catch {
        if (alive) setBoxes([])
      }
    })()
    return () => {
      alive = false
    }
  }, [page, pageNo, cssScale, crop, cache])

  // A span's rendered width won't match the PDF's advance width (different
  // font), so squeeze each one horizontally to fit. Without this, selection
  // highlights drift further right along every line.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const spans = root.querySelectorAll<HTMLSpanElement>('span[data-s]')
    spans.forEach((span, i) => {
      const target = boxes[i]?.width
      if (!target) return
      span.style.transform = ''
      const actual = span.getBoundingClientRect().width
      if (actual > 0) {
        const angle = boxes[i].angle
        const rot = angle ? `rotate(${angle}rad) ` : ''
        span.style.transform = `${rot}scaleX(${target / actual})`
      }
    })
  }, [boxes])

  // Turn whatever the user selected into a character range on this page.
  useEffect(() => {
    if (!active) return
    const root = rootRef.current
    if (!root) return

    const read = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return onSelect(null)
      const range = sel.getRangeAt(0)
      const startSpan = spanOf(range.startContainer)
      const endSpan = spanOf(range.endContainer)
      if (!startSpan || !endSpan || !root.contains(startSpan) || !root.contains(endSpan)) {
        return onSelect(null)
      }
      const start = Number(startSpan.dataset.s) + range.startOffset
      const end = Number(endSpan.dataset.s) + range.endOffset
      const text = ptRef.current?.text.slice(Math.min(start, end), Math.max(start, end)) ?? ''
      if (!text.trim()) return onSelect(null)
      const r = range.getBoundingClientRect()
      onSelect({
        start: Math.min(start, end),
        end: Math.max(start, end),
        text,
        x: r.left + r.width / 2,
        y: r.top,
      })
    }

    // pointerup covers mouse drag and the iOS long-press handles.
    document.addEventListener('pointerup', read)
    document.addEventListener('selectionchange', read)
    return () => {
      document.removeEventListener('pointerup', read)
      document.removeEventListener('selectionchange', read)
    }
  }, [active, onSelect, boxes])

  // Clear a stale selection when select mode turns off or the page changes.
  useEffect(() => {
    if (!active) window.getSelection()?.removeAllRanges()
  }, [active, pageNo])

  return (
    <div
      ref={rootRef}
      aria-hidden={!active}
      data-text-layer
      className="absolute inset-0 z-20 select-text"
      style={{
        pointerEvents: active ? 'auto' : 'none',
        userSelect: active ? 'text' : 'none',
        WebkitUserSelect: active ? 'text' : 'none',
        cursor: active ? 'text' : undefined,
      }}
    >
      {boxes.map((b, i) => (
        <span
          key={i}
          data-s={b.run.start}
          className="absolute whitespace-pre text-transparent"
          style={{
            left: b.left,
            top: b.top,
            fontSize: b.fontHeight,
            fontFamily: 'sans-serif',
            lineHeight: 1,
            transformOrigin: '0% 0%',
          }}
        >
          {b.run.str}
        </span>
      ))}
    </div>
  )
}

function spanOf(node: Node): HTMLSpanElement | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  return el?.closest<HTMLSpanElement>('span[data-s]') ?? null
}
