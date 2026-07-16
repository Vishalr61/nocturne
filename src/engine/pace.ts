// Reading-pace intelligence. Pace is measured as active milliseconds per
// PERCENT of the book — the one unit that works identically for PDFs (page
// count) and EPUBs (spine-weighted chars), and survives font/zoom changes.
// Samples accumulate with the same capped-gap rule as the reading stats (a
// put-down phone doesn't count), blend 70/30 with history so one skimming
// session doesn't wreck the estimate, and stay local — stats are a private
// mirror, never synced.
//
// Estimates only surface once a book has ~10 minutes of signal, and they
// round friendly: "14 min", "1.5 h" — never false precision.

export interface Pace {
  /** Active reading milliseconds per 1% of the book. */
  msPerPct: number
  /** Total active ms sampled — the confidence gate. */
  signalMs: number
}

const key = (bookId: string) => `nocturne-pace-${bookId}`
const READY_MS = 10 * 60 * 1000

export function loadPace(bookId: string): Pace | null {
  try {
    const raw = localStorage.getItem(key(bookId))
    if (!raw) return null
    const p = JSON.parse(raw) as Pace
    return Number.isFinite(p.msPerPct) && p.msPerPct > 0 ? p : null
  } catch {
    return null
  }
}

/** Fold one sample (activeMs spent, pctDelta advanced) into the book's pace. */
export function recordPace(bookId: string, activeMs: number, pctDelta: number): void {
  if (activeMs < 20_000 || pctDelta < 0.2) return // too small to mean anything
  const sample = activeMs / pctDelta
  // Skimming/scrubbing guard: implausibly fast reading is navigation, not reading.
  if (sample < 3_000) return
  const cur = loadPace(bookId)
  const msPerPct = cur ? cur.msPerPct * 0.7 + sample * 0.3 : sample
  try {
    localStorage.setItem(
      key(bookId),
      JSON.stringify({ msPerPct, signalMs: (cur?.signalMs ?? 0) + activeMs } satisfies Pace),
    )
  } catch {
    /* private mode */
  }
}

/** Estimates hide until the book has enough signal to be honest. */
export function paceReady(p: Pace | null): p is Pace {
  return !!p && p.signalMs >= READY_MS
}

/** "14 min" · "1.5 h" · null under a minute (nothing worth saying). */
export function fmtLeft(ms: number): string | null {
  const min = Math.round(ms / 60_000)
  if (min < 1) return null
  if (min < 60) return `${min} min`
  const h = ms / 3_600_000
  return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`
}

/** Time left for a remaining percent span, or null if not estimable. */
export function timeLeft(p: Pace | null, pctLeft: number): string | null {
  if (!paceReady(p) || pctLeft <= 0) return null
  return fmtLeft(p.msPerPct * pctLeft)
}
