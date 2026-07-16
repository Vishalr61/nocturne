# PRD — EPUB input · Reading-pace intelligence · Vocabulary notebook

2026-07-16. Approved scope for the next build arc. Read aloud (professional
pass) and OCR for scans are explicitly the patch after this one.

## Why these three together

EPUB input makes Nocturne "the reader" instead of "the PDF reader" — the
Text Mode engine already renders exactly what an EPUB contains. Pace
intelligence and the vocabulary notebook are the two daily-delight features
that compound with every reading session, and both build on plumbing that
already exists (the reading log; the dictionary card).

---

## 1 · EPUB input

### What an EPUB is (for this codebase)

A ZIP (we already ship fflate) containing XHTML chapter files, CSS, images,
a manifest (`content.opf`) with the spine (reading order), and a nav/NCX
table of contents. No pages exist in the file; layout happens at read time.
This is the structure `engine/reflow.ts` tries to RECONSTRUCT from PDFs —
an EPUB provides it losslessly, so none of the PDF pipeline (classify,
recolor, reflow, trust scoring) applies. Text renders as text; themes are
CSS; the trust problem does not exist.

### Import

- The shelf's Add button accepts `.epub` alongside `.pdf` (accept attr +
  magic-byte sniff: `PK` zip signature + `mimetype` entry `application/epub+zip`).
- Parse: fflate unzip → `META-INF/container.xml` → OPF path → spine ids,
  manifest hrefs, metadata (title, author) → nav doc (EPUB3) or NCX (EPUB2)
  for the TOC. DOMParser for all XML/XHTML (already a dependency of the
  EPUB *export* path — reuse its helpers where they fit).
- Store the original bytes in Dexie exactly like PDFs (same `books` table,
  new `format: 'pdf' | 'epub'` field, default 'pdf' for existing rows).
  Content-hash identity unchanged — re-adding resumes, ghosts work.
- Cover: the OPF cover-image item, rasterized to the existing thumbnail
  size for the shelf; fall back to the generated title card.

### Rendering

- A new `reader/EpubReader.tsx` in the TextReader mold: a scrolling column
  using the SAME typography settings (font, size via popover stepper,
  leading, width, justify, paragraph style) and theme fg/bg.
- Chapters lazy-load: parse + sanitize the current spine item ± 1. Sanitize
  hard: strip scripts, external URLs, and absolute positioning; keep
  semantic tags (p, h1–h6, em, strong, blockquote, ul/ol, img, hr, table);
  publisher CSS is DROPPED except our allowlist can grow later — our
  typography is the point (Books does the same by default).
- Images resolve from the zip to blob URLs, revoked on chapter unload.
- Big-chapter safety: chapters render block-virtualized once a chapter
  exceeds ~500 blocks (same virtualization idea as ContinuousReader slots).

### Position, progress, sync

- New position model for EPUBs on the existing `progress` record
  (additive, LWW-safe): `{ chapter: number, block: number, frac: number,
  percent: number }` where percent is whole-book (spine-weighted by
  chapter character counts, computed at import and cached).
- The bottom bar adapts: the page pill shows `ch 4 · 62%` (tap → chapter
  list = Contents); the scrubber scrubs whole-book percent and lands on
  the matching chapter+offset. Back-to-spot pill works on positions.
- Layout switch hides for EPUBs (there is only text); Spread/Crop/Zoom
  tiles hide; the Customise popover keeps Type controls + vocabulary/
  export-irrelevant bits hidden. Export chips hide entirely (it IS an
  EPUB; "Original file" share can come later).

### What carries over unchanged

- Dictionary double-tap (DOM text — works as in Text Mode today).
- Highlights: chapter + character-range model (mirrors the PDF page+range
  design); rendered as spans, synced like PDF highlights.
- Search: per-chapter text scan, streaming results with chapter labels.
- Reading stats: position ticks feed the same readingLog.

### Verification

- Corpus: the real EPUBs on disk (The Martian, angels-and-demons,
  Code-Breakers-Alpha, MHA pair) — import, TOC count, chapter render,
  resume-at-position, highlight round-trip, dictionary tap. Headless
  suite `verify_epub.py` in the house style; no book text committed.

### Non-goals (this arc)

- Fixed-layout EPUBs (comics/children's books) — detect and refuse politely.
- DRM of any kind — never.
- Publisher-CSS fidelity — our typography wins, by design.

---

## 2 · Reading-pace intelligence

### Model

- Pace = chars read per minute for EPUBs/Text Mode, pages per minute for
  paged/scroll PDFs, computed from the existing readingLog ticks plus a
  per-book rolling window (last ~45 min of active reading, capped-gap
  rule as today). Per-book pace preferred; global median fallback.
- Cold start: show nothing until ≥10 minutes of signal for that book.
  Estimates round friendly (12 min, 1.5 h) — never false precision.

### Surfaces

1. **Contents header**: "~14 min left in this chapter · ~3.2 h in the book"
   (restores the chapter-left feature the navbar redesign dropped, with
   more value).
2. **Aa popover**: one whisper line at the bottom, same numbers.
3. **Shelf hero**: "~5 h left" beside the progress meta.

---

## 3 · Vocabulary notebook

### Capture

- The definition card gains one affordance: **＋ Save** (top-right of the
  card). Saves: word (lemma), first sense (pos + def), source bookId +
  title, the sentence around the tap (from the caret's text node, sentence
  boundaries), savedAt. Duplicate saves update the existing entry's
  context + date instead of duplicating.

### Store

- Dexie v7: `vocab { id (word), word, pos, def, note?, bookId?, bookTitle?,
  context?, savedAt, updatedAt }`. Syncs as a new record kind through the
  existing E2E-encrypted pipeline (additive; LWW; deletes via tombstones).

### Home page

- A **Vocabulary** stat tile joins the stats row (count), and a card below
  the shelf lists the 3 most recent words.
- Tapping either opens the notebook view (full-screen panel like Contents):
  - List, newest first; each row: word, pos chip, definition, source book
    whisper, context sentence (collapsed to one line, tap to expand).
  - Search box (filters as you type).
  - **Edit**: tap a row → inline note field (personal definition/mnemonic)
    + editable definition text. **Delete**: swipe-reveal or ✕ per row,
    with undo toast.
  - Empty state teaches the gesture: "Double-tap any word while reading,
    then ＋ Save."

---

## Sequencing

1. EPUB core: import + parse + render + position + Contents (the spine of
   the arc; everything else hangs off it).
2. EPUB integrations: highlights, dictionary, search, sync field, shelf.
3. Vocabulary notebook (capture → store → home surfaces → editor).
4. Pace intelligence (model → three surfaces).
5. Verification suites per piece; docs + roadmap updates; PR per piece.

## Risks / open questions

- **Sync compat**: older clients receiving epub-position or vocab records
  must ignore unknown kinds gracefully (verify against the deployed
  worker — records are opaque; the client-side apply is what matters).
- **Chapter hugeness**: some EPUBs put the whole book in one XHTML file —
  the virtualization threshold is the guard; test with the corpus.
- **Percent model**: spine-weighted percent must be stable across devices
  (compute once at import, store with the book, sync via knownBooks meta).
- **Scrubber granularity** on 5-chapter books: intra-chapter fraction keeps
  it smooth.
