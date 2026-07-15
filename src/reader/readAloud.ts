import type { PDFDocumentProxy } from 'pdfjs-dist'
import { getPageText, type TextCache } from '../engine/search'
import { reconstructPage, spansText } from '../engine/reflow'

// Read the book aloud with the browser's speech synthesis — on-device voices,
// works offline, nothing leaves the device. The reflow reconstruction supplies
// clean paragraphs (no running headers or page numbers, hyphens healed), so
// the voice reads prose, not layout. Utterances are chunked to sentence-sized
// pieces because long utterances stall or get cut on several platforms
// (notably Chrome's ~15s cap).

export interface ReadAloud {
  stop(): void
}

/** Sentence-ish chunks ≤ ~160 chars; tiny fragments merge into a neighbour. */
function sentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]*/g) ?? [text]
  const out: string[] = []
  for (const p of parts) {
    const t = p.trim()
    if (!t) continue
    const last = out[out.length - 1]
    if (last && (t.length < 24 || last.length + t.length < 160)) {
      out[out.length - 1] = `${last} ${t}`
    } else {
      out.push(t)
    }
  }
  return out
}

export function startReadAloud(opts: {
  doc: PDFDocumentProxy
  textCache: TextCache
  startPage: number
  rate?: number
  /** Fired as reading enters each page, so the reader can follow along. */
  onPage?: (page: number) => void
  /** Fired when the book ends (not when stop() is called). */
  onEnd?: () => void
}): ReadAloud {
  let cancelled = false
  const synth = window.speechSynthesis
  synth.cancel() // clear anything stale from a previous run

  const speak = (text: string) =>
    new Promise<void>((resolve) => {
      if (cancelled) return resolve()
      const u = new SpeechSynthesisUtterance(text)
      u.rate = opts.rate ?? 1
      u.onend = () => resolve()
      u.onerror = () => resolve()
      synth.speak(u)
    })

  void (async () => {
    try {
      for (let p = opts.startPage; p <= opts.doc.numPages && !cancelled; p++) {
        const pdfPage = await opts.doc.getPage(p)
        const pt = await getPageText(pdfPage, opts.textCache, true)
        const blocks = reconstructPage(pt)
        if (cancelled) return
        opts.onPage?.(p)
        for (const b of blocks) {
          if (cancelled) return
          if (b.kind === 'img' || b.kind === 'sep') continue // nothing to say
          const text = spansText(b.spans).trim()
          if (!text) continue
          for (const s of sentences(text)) {
            if (cancelled) return
            await speak(s)
          }
        }
      }
    } finally {
      if (!cancelled) opts.onEnd?.()
    }
  })()

  return {
    stop() {
      cancelled = true
      synth.cancel()
    },
  }
}
