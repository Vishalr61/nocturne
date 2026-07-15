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

- ✅ **EPUB inline images.** Chapter-divider icons and inline figures (the
  DCC case) are cropped from an original-colour page render and embedded as
  JPEGs at their flow position.
- ✅ **iOS delivery.** iOS never honoured `<a download>` on blob URLs, so no
  export ever reached the phone. Exports there now go to the share sheet
  (Save to Files / AirDrop / open in Books), with a "Ready — Share" row when
  a long export outlives the tap's user activation.
- ✅ **EPUB TOC from the PDF outline.** When the PDF has a real outline its
  destinations cut the chapters (DCC: 'Chapter 1', 'Part I', …); the heading
  heuristic stays as the fallback. Chapter openers survive reflow (display-
  size edge lines are titles, URL watermarks are not), stacked heading lines
  merge ('2 · Peter'), and every EPUB gets a cover — page-1 art or a
  generated title card.

Remaining, to graduate the betas:

- **P1 — EPUB metadata**: author field; watermark body text ('OceanofPDF.com'
  mid-page) needs the repeated-line furniture detector from §2.
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

- ✅ **Confidence, not bravado.** `reconstructPageScored` rates every page:
  two-column starts, table-row gaps, ragged interior joins, dot-leader lines
  (a TOC "reads right" to a text diff but looks like dot soup), dropped text.
  Below 0.5, TextReader shows the recolored page image inside the column —
  exactly like image pages — instead of risking mangled prose. Measured:
  the novels keep every prose page as text (Ender's TOC falls back, as it
  should); Sybex declines ~10% of pages (the tables) rather than mangle them.
- ✅ **Scene breaks.** Glyph dinkuses ("* * *", "···") become centered
  separators, deduped across page stitches. Gap-based detection was built,
  measured on the corpus, and *removed*: big vertical gaps mark set-off
  boxes (DCC's system messages), verse, and section spacing far more often
  than scenes — a paragraph break is the honest rendering.
- ✅ **Verification corpus.** `scripts/verify/reflow-corpus.ts` (npx tsx)
  reflows DCC / Red Rising / Ender's Game / Sybex with the real engine and
  scores word-bigram similarity against PyMuPDF ground truth per page;
  `reflow-baseline.json` is the committed baseline and the run fails on
  regression. Novels: median ≈0.99, zero low pages. No book text touches
  the repo — scores only.
- **Spot-check affordance** (open): tap-and-hold a paragraph → peek at the
  source page region it came from. Trust is built by letting you verify
  cheaply.
- **Structure coverage** (open): block quotes / letters (indented blocks),
  simple lists.

## 3. Scroll mode — polish the daily driver (P0)

It won a full day of reading; it deserves the finish work:

- ✅ Position memory at sub-page precision — reopening restores the exact
  scroll offset (synced, guarded against stale offsets from other modes),
  and zoom/rotate/crop re-anchors keep the fractional spot instead of
  snapping to the page top.
- ✅ Chapter-aware footer: tap the percent readout to cycle to "N left in
  ch." (next outline destination), choice remembered.
- Snappier zoom: scroll mode re-renders on zoom commit; pinch should feel as
  live as paged mode's.

## 3b. EPUB input — worth it, but after Text Mode trust

Today Nocturne opens PDFs only. Should it read EPUBs too? Assessment:

- **Against**: EPUBs don't have the problem Nocturne exists to solve — every
  EPUB reader already reflows with your fonts and themes, and Apple Books
  does it well. The recolor engine adds zero value for EPUBs.
- **For**: one library, one set of typography settings, one sync of
  positions/highlights — the reading-life argument, not a rendering one.
  And the cost is lower than it looks: an EPUB is pre-reflowed perfect
  blocks, which is exactly what TextReader renders. Parse (fflate +
  DOMParser, both already available) → blocks → the same column. No
  classification, no OCR, no trust problem.
- **Sequencing**: the Text Mode trust work IS the EPUB engine — block-based
  reading, structure handling, position model beyond page numbers. Do that
  first, then EPUB input is a parser plus a `format` field in the library
  (progress/highlights need a chapter+offset position model, which touches
  sync). Slot: after §2, before OCR.

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

## 5. Reading stats (P1) ✅

Shipped 2026-07-15: time accrues as capped gaps between page arrivals (a
put-down phone doesn't count the night), pages as capped forward movement (a
TOC jump isn't "50 pages read"); `readingLog` in Dexie, local-only, never
synced. The shelf shows a quiet "Your reading" card — today, this week,
streak. Later: per-book time, pages/hour.

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

- ✅ **Theme scheduling**: "Auto by time" toggle — Paper 07–19, your dark
  theme at night. Manual picks always win until the next day/night boundary.
- **Custom theme editor**: bg/fg pickers on the existing THEMES model.
- ✅ **Tap-zone preferences**: "Left tap turns forward" toggle (one-handed).
- **Search**: diacritic-insensitive matching, recent searches.
- ✅ **Back-to-spot pill**: any jump (TOC, search, scrubber, bookmark, page
  box) offers "↩ Back to page N"; retires when you're back in the
  neighbourhood.
- ✅ **Dictionary lookup**: double-tap (or double-click) a word → definition
  card. Reworked from a popover "Define" button after real-phone testing:
  the word comes from the caret under the tap — no selection ever forms, so
  iOS's Copy/Look Up callout never appears, and the card is a snapshot that
  survives the selection collapsing (the bug that killed the button on
  mobile). Offline WordNet 3.1, sharded under `public/dict/en/` (~9.5MB,
  fetched per letter, cache-first in the SW — never precached),
  lemmatization in `engine/dict.ts`. Toggleable in settings. Long-press
  stays selection: highlight (two colours) + copy. In paged mode double-tap
  needs select mode (taps turn pages).
- ✅ **Highlights**: second colour (sage) next to amber in the popover.
  Margin dots dropped — scroll mode renders the full highlight rects, so
  dots would be redundant.
- ✅ **Library**: sort (recent / title / progress), per-book size on the
  tile, install-app button (real prompt on Chromium, steps on iOS).
- ✅ **Design "Reading Room"** (picked from three mockup directions,
  lightened per feedback): the current book's blurred cover lights the
  home behind a centered hero; reader chrome floats as theme-derived glass
  pills (back / actions / scrubber capsule), so toggling chrome never
  reflows the page. Floating chrome sits at z-24 — above the text layers,
  still under the night dimmer.

## Explicitly not doing

- Uploading books anywhere, accounts, server-side anything (guardrail).
- Volume-button page turn (impossible in web iOS).
- Bionic-reading gimmicks.

## Working agreement for this pass

Feature branch `feature/reader-refinements`, no pushes until reviewed.
Every change verified in the real app via the headless harness before it's
called done; `npm run build` green at every commit.
