# Refinement roadmap — from "works" to "top-tier"

Written 2026-07-13, after a full day of real reading (Dungeon Crawler Carl,
mostly scroll mode, Paper theme). This is the plan for polishing the features
that already exist, benchmarked against the apps that set the bar: Apple
Books, Kindle, KOReader, Moon+ Reader, Readwise Reader, and (for read aloud)
Speechify / ElevenLabs Reader.

The honest summary: the rendering core (recolor, polarity, image masking) is
already competitive — nothing mainstream does saturation-aware dark mode this
well. What separates Nocturne from a top-tier app now is **trust and finish**:
Text Mode isn't trusted yet, read aloud is a demo, and the features around the
reading (stats, TTS, OCR) are a tier below the reading itself.

Legend: ✅ shipped on `feature/reader-refinements` · P0 next · P1 after · P2 later

---

## 1. Export — make "what you save" = "what you see" ✅ (this branch)

What shipped:

- One export model: **Whole book / Page range** scope, then format. "Extract
  pages" became the "Original pages" format.
- **Dark PDF** now carries image brightness and margin crop (it silently
  ignored both before — the file never matched the tuned page).
- **Vector PDF** honours the range and applies crop as a real PDF CropBox.
- **EPUB** embeds the Text Mode font (real WOFF faces, plus the Apple Books
  `specified-fonts` switch) and ships line spacing / justify / paragraph style
  as its stylesheet. Your typography finally travels with the book.

Remaining, to graduate the betas:

- **P0 — EPUB inline images.** `chapterize()` still drops image blocks; DCC's
  chapter icons vanish. Text Mode already crops + recolors inline
  illustrations (`TextReader.renderInlineCrops`) — encode those crops as JPEGs
  into the EPUB.
- **P0 — EPUB TOC from the PDF outline.** Chapters currently come from the
  heading heuristic; when the PDF has a real outline, prefer it.
- **P1 — EPUB metadata**: author, cover page (page 1 render as cover image).
- **P1 — Vector export gaps**: Separation (`sc/scn` 1-component) tints and
  shading dictionaries pass through unmapped. Books that use spot colour still
  come out patchy; this is the graduation blocker for making vector the
  default.

## 2. Text Mode — the trust problem (P0, the big one)

Today's reality: you switched back to scroll mode because DCC looked more
right there. The reflow is a stack of good heuristics (paragraph gaps,
indents, hyphen healing, cross-page stitching, the DCC `[ x ]` bracket-marker
exception) — but heuristics fail silently, and one mangled paragraph costs all
trust. Kindle never has this problem because it renders publisher EPUBs; our
job is harder (reconstruction from layout), so the play is different:

- **Confidence, not bravado.** Score each page's reconstruction (unmatched
  glyphs, suspicious joins, line-width variance). Low-confidence pages render
  as the recolored page image inside the text column — exactly like image
  pages do today — instead of risking mangled prose. Nothing ever looks
  wrong; worst case looks like scroll mode.
- **Spot-check affordance.** Tap-and-hold a paragraph → peek at the source
  page region it came from. Trust is built by letting you verify cheaply.
- **Structure coverage**: scene breaks (`***`, long gaps → `<hr>`-style
  separators), block quotes / letters (indented blocks), simple lists. These
  are the three structures prose books actually contain.
- **Verification corpus.** A headless harness that reflows the test books
  (DCC, Red Rising, Ender's Game, Sybex) and diffs extracted text order
  against pdftotext ground truth — so reflow changes can't regress silently.

## 3. Scroll mode — polish the daily driver (P0)

It won a full day of reading; it deserves the finish work:

- Position memory at sub-page precision (restore the exact scroll offset,
  not the page top).
- Chapter-aware footer: "Ch. 12 — 4 pages left" (Kindle's most-loved detail;
  we have the outline already).
- Snappier zoom: scroll mode re-renders on zoom commit; pinch should feel as
  live as paged mode's.

## 4. Read aloud — professional grade (P1, parked until wanted)

Current state is a ~90-line loop: no voice choice, fixed rate, no pause, no
visual tracking. The bar (Speechify, ElevenLabs Reader, @Voice): pick a
voice, see the sentence being spoken, control from the lock screen. Plan,
in build order:

1. **Player, not a toggle**: mini-player bar with play/pause (not just stop),
   rate (0.8–2.5×), and voice picker — `speechSynthesis.getVoices()` grouped
   by quality; on iOS the premium local voices (Ava, Zoe) are genuinely good.
2. **Follow-along highlight**: sentence-level highlight in all view modes +
   auto-scroll. We already chunk by sentence; the reflow blocks carry enough
   geometry to place them.
3. **Tap to start here**: begin from a tapped paragraph, not the page top.
4. **Lock-screen / background**: MediaSession API for artwork + transport
   controls; keep-alive strategy for iOS Safari's aggressive suspension —
   this is the hard, platform-fighting part and the reason to do it last.
5. **Comforts**: sleep timer, skip-back 15s, per-book voice/rate memory,
   spoken-position persistence.

## 5. Reading stats (P1)

Every top app has this and it's cheap for us: session time, pages/hour,
per-book time, streaks. Local-only (Dexie), a small "your reading" card on
the shelf. Also powers "time left in chapter" (§3).

## 6. OCR for scans (P1 — unlocks three features at once)

Tesseract-WASM path from the original roadmap. One capability, three
payoffs: scans get Text Mode, read aloud, and search. Gate it behind an
explicit per-book "Recognize text" action (it's slow and battery-hungry;
never automatic).

## 7. Sync go-live (P1, blocked on the workers.dev subdomain)

Built and verified end-to-end; flip `DEFAULT_SYNC_URL` when the subdomain
exists. Reading on Mac + iPhone daily makes this the highest-leverage
blocked item — positions and highlights should follow you.

## 8. Small finish work (P2, batched when touching the area)

- **Theme scheduling**: auto-switch theme by time of day (Paper by day,
  Soft Dark at night) — you landed on Paper *in the end*; the app should
  learn the rhythm.
- **Custom theme editor**: bg/fg pickers on the existing THEMES model.
- **Tap-zone preferences**: left-tap-forward option (one-handed reading).
- **Search**: diacritic-insensitive matching, recent searches.
- **Highlights**: a second colour + margin dots in scroll mode.
- **Library**: sort (recent / title / progress), storage usage per book.

## Explicitly not doing

- Uploading books anywhere, accounts, server-side anything (guardrail).
- Volume-button page turn (impossible in web iOS).
- Bionic-reading gimmicks.

## Working agreement for this pass

Feature branch `feature/reader-refinements`, no pushes until reviewed.
Every change verified in the real app via the headless harness before it's
called done; `npm run build` green at every commit.
