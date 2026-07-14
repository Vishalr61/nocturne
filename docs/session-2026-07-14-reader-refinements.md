# Session record — reader refinements (2026-07-13 → 07-14)

Everything that happened on `feature/reader-refinements`, written down so it
can be revisited without the chat. The forward-looking plan lives in
[refinement-roadmap.md](refinement-roadmap.md); this file is the record of
what shipped, what was found, and what's still open.

## Why this branch exists

After a full day reading Dungeon Crawler Carl: export was convoluted and
ignored configured settings; Text Mode wasn't trusted (scroll mode won);
haptics was a mystery; read aloud too basic; Paper theme ended up the pick.
Then two live bug reports: iPhone downloads dead, Paper theme showing dark
images.

## What shipped (in commit order)

1. **Exports follow the reading setup** — page ranges for every export,
   dark PDF carries image brightness + margin crop (it silently ignored
   both), vector PDF gets ranges + crop as real PDF CropBox, EPUB embeds
   the Text Mode font (WOFF ×4 faces + Apple Books `specified-fonts`
   switch) with line spacing / justify / paragraph style as its stylesheet.
2. **Export menu redesign** — one model: Whole book / Page range scope,
   then format rows (Dark PDF / vector / EPUB / Original pages). Ranged
   filenames tagged `p{from}-{to}`. Haptics toggle hidden where the
   Vibration API doesn't exist (iOS).
3. **EPUB inline images** — chapter icons/figures cropped from an
   original-colour render, embedded as JPEGs at their flow position;
   adaptive render scale so small icons stay sharp.
4. **iOS export delivery** — iOS never honours `<a download>` on blob URLs,
   so no export ever reached the phone. All saves go to the share sheet
   there (Files / AirDrop / Books); long exports park in a "Ready — Share"
   row because the sheet needs a fresh tap. **STILL UNTESTED ON REAL
   IPHONE** — this is the open verification.
5. **(other session)** Chapter headings survive reflow (display-size edge
   lines are titles), stacked headings merge ("2 · Peter"), EPUB covers
   (page-1 art or generated title card). Reviewed here: sound, except it
   made "OceanofPDF.com" a chapter — fixed below.
6. **Outline-cut EPUB chapters** — when the PDF has an outline, its
   destinations cut the chapters (DCC: Copyright/Dedication/Chapter 1/
   Part I/…); heuristic stays as fallback (Ender's: "2 · Peter"). URL
   watermarks excluded from titles/headings everywhere in reflow.
7. **Paper theme fixes** — (a) Text Mode cached image pages + inline crops
   and never repainted them on theme change → stale dark icons on a Paper
   page; now repaints in place, scroll position held. (b) Preserved images
   were always dimmed 0.82 "against the dark ground"; on light themes that
   greyed the picture — dimming now only applies on dark grounds. Both
   pre-dated this branch (came with Text Mode inline images).
8. **Scroll polish** — exact-line resume (`Progress.offset`, synced,
   guarded against stale offsets ±1 page), fractional re-anchor (zoom/
   rotate/async-crop no longer snap to page top), tappable footer stat
   (percent ⇄ "N left in ch."), profile/progress persistence split.

## How it was verified

Headless Chromium driving the real app (`scripts/verify/*.py` — copied from
the session scratchpad; paths assume this machine). PyMuPDF for PDF
ground truth. Books: DCC (icons, outline, bracket chapters), Ender's Game
(no outline, prose), both under `~/Documents/Hobby/Books/`.
Highlights: EPUB unzipped and inspected (fonts, CSS, images, nav titles);
ranged PDFs page-counted and luma-measured; crop compared across raster
(baked) and vector (CropBox); scroll restore measured at 0 px drift;
Paper-theme repro screenshotted before/after.

## Open items

- **iPhone share sheet** — needs a real-device test (export → sheet →
  Files/Books). The one unverified change.
- "OceanofPDF.com" still appears ~3× as body text in DCC (genuinely printed
  mid-page); the fix is repeated-line furniture detection (roadmap §2).
- Ender's heuristic TOC has a cosmetic "CONTENTS · ***" entry.
- Vector export: Separation tints / shading dicts unmapped (beta blocker).
- Playwright cache moved to build 1223 (a session updated it); scripts and
  CLAUDE.md now glob instead of pinning.

## Next, as agreed

Text Mode trust arc (repeated-line furniture detection → scene breaks /
block quotes → confidence scoring with page-image fallback → tap-to-peek
source), then EPUB **input** (assessment in roadmap §3b: worth it, after
trust work — TextReader is already the engine). Read aloud stays parked
until wanted, then built to professional grade (roadmap §4).
