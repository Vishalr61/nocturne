# CLAUDE.md — Nocturne

Guidance for working in this repo. **Read the source before changing it; source is
ground truth, not this file.** If anything here disagrees with the code, the code
wins — fix this file.

Nocturne is a phone-first, offline PWA for reading **DRM-free PDFs you own** in a
comfortable dark theme. It exists to serve one real habit: download a book PDF,
read it on your phone (today: in Apple Books). The product makes clunky
white-background PDFs pleasant to read — without blurring the text or wrecking the
images, the two things existing "PDF dark mode" tools get wrong.

Plain **Vite + React + TypeScript + Tailwind**, **Canvas/WebGL2** for rendering,
**pdf.js** for parsing, **Dexie/IndexedDB** for local storage. Ships static
(Vercel). The app is **local-first**: it must work fully offline with no server,
and PDF bytes never leave the device. An **opt-in, state-only** sync (roadmap 6)
may add a tiny backend for positions/themes/bookmarks — never for book content,
never a content account. See the guardrail below.

## Commands

```bash
npm run dev        # vite dev server
npm run build      # tsc --noEmit && vite build   ← must stay green
npm run typecheck  # tsc --noEmit
```

## The core decision: recolor, NOT reflow (for v1)

A PDF's glyphs are baked vector shapes. You can either:

- **Recolor in place** — keep the exact page (layout, images, icons), just change
  colours. Text stays crisp & selectable. **You cannot change the font.** ← v1.
- **Reflow** — extract the text and re-lay it out, giving full font/size/spacing
  control, but images/icons/stat-blocks have nowhere to land and get mangled.

These are mutually exclusive on the same rendering. v1 is **recolor-only
("Faithful mode")**. The next milestone is an optional, instantly-switchable
**Text Mode** (reflow) for prose, so the font dream is available where it works
(prose) without breaking the images (flip back to Faithful for those pages).

## How the recolor avoids the two classic failures

1. **No blur.** We never bake a low-res bitmap. `engine/pdf.ts` re-renders the
   page with pdf.js at `cssScale * devicePixelRatio` every time zoom changes, and
   `engine/recolor.ts` recolors that fresh render on the GPU. The reader sizes the
   canvas so 1 backing pixel = 1 device pixel (fit-page × zoom). Text is always
   vector-crisp. `reader/TextLayer.tsx` overlays transparent, selectable spans
   (pdf.js `getTextContent()`), so text can be selected, copied and highlighted;
   it is `pointer-events: none` unless select mode is on, so it never eats the
   taps that turn pages.
   **Invariant:** anything drawn over the canvas (text layer, search matches,
   highlights) must derive from the *same* `{pdfPage, pageNo, cssScale, crop}`
   object the canvas was rendered with — `Reader`'s `view` state. Splitting
   those apart once let the page number run ahead of the page proxy and cached
   the wrong page's text under the new number. Cache text by `page.pageNumber`.
2. **No inverted images.** Decided per page by `engine/pipeline.ts` (shared by
   the live reader and the export, so they can't drift):
   - **Polarity**: a page whose dominant tone is already dark (black cover,
     native dark theme) is already a night page — passes through untouched.
   - **Structural masking**: declared image XObject rects (`imageRects` from
     `engine/classify.ts`, extracted by walking the operator list's transform
     stack) are preserved with original colours, dimmed ~18% against the dark
     ground — when they are embedded (< half the page) and photo-like.
   - **Content detection**: photos hiding inside full-page bitmaps (no useful
     declared rect) are found by tile statistics — photos are mid-tone-rich,
     text-on-paper is bimodal — and preserved by bounding box.
   - **Colour text**: on pages with zero images, saturated pixels keep hue but
     flip lightness (`uColorText`), so hyperlinks stay readable on dark.
   - Everything else: `engine/shader.ts` remaps low-saturation ink/paper onto
     the theme by interpolating `fg`<->`bg` across luminance (interpolation,
     not thresholding = smooth glyph edges); saturated pixels pass through.

## The "never impossible" spine — `engine/classify.ts`

Every page is classified and routed to a strategy, with a guaranteed tone-map
floor so **no PDF is ever rejected**; worst case is "merely good", never "can't".

| kind | detector | strategy |
| --- | --- | --- |
| `digital-text` | text layer present | `ink-mask`: recolor ink, mask images |
| `vector` | draw ops, little text | `luminance`: recolor strokes/fills |
| `scanned` | page ≈ one image, no text | `tonemap` now; OCR (Tesseract) → text layer later |
| `unknown` | fallthrough | `tonemap` floor |

When you add a strategy, add it here and route it — do **not** special-case a
specific PDF elsewhere.

## Architecture

One React surface (`App` → `Reader`) today. The engine is framework-free and
unit-testable in isolation.

```
src/
├── main.tsx / App.tsx          entry + single reader surface
├── engine/
│   ├── pdf.ts        pdf.js wrapper: openPdf, renderPageToCanvas (dpr-sharp source)
│   ├── theme.ts      THEMES (paper->bg, ink->fg anchor tones)
│   ├── shader.ts     GLSL: ink/paper remap + polarity/mask/colour-text uniforms
│   ├── recolor.ts    Recolorizer: WebGL2 pass, source canvas -> recolored canvas
│   ├── classify.ts   classifyPage -> {kind, strategy, imageRects} (the spine)
│   ├── crop.ts       detectContentBox: doc-level margin box for auto-crop
│   ├── search.ts     streaming full-text search + match rects (text layer data)
│   └── pipeline.ts   renderDarkPage (+finishDarkPage for pre-rendered sources):
│                     polarity, image masking, colour text — the per-page
│                     decisions; shared by reader AND export
├── storage/
│   ├── db.ts         Dexie: books (bytes+thumb), profiles, progress, bookmarks,
│   │                 highlights, tombstones, knownBooks (ghosts), syncState.
│   ├── syncCrypto.ts device secret → userKey/recordId (opaque) + AES-GCM E2E
│   ├── syncModel.ts  collect local changes / apply remote (last-write-wins)
│   └── syncClient.ts push+pull loop, cursor, enable/adopt secret
├── sync-worker/      Cloudflare Worker + D1 (schema.sql): opaque LWW sync store
│                     — ciphertext only, never PDF bytes. Own deploy (wrangler).
├── dev/
│   └── suggest.ts    dev-only point-and-suggest overlay (✎ chip): tap an element,
│                     type a change request → POST /__suggest (middleware in
│                     vite.config.ts) → design-notes.jsonl (gitignored) for an
│                     agent to apply. Loaded behind import.meta.env.DEV only.
├── library/          Shelf.tsx (saved books, resume, delete) + import.ts (file->DB)
└── reader/
    ├── Reader.tsx    paged reader: recolor, tap zones, pinch zoom, nav
    │                 (scrubber/TOC), prefetch, crop, search, bookmarks; owns
    │                 book load + persistence for BOTH view modes
    ├── TextLayer.tsx transparent selectable spans → copy + highlights (paged)
    ├── ContinuousReader.tsx  virtualized scroll layout (opt-in "Scroll" mode)
    └── SpreadReader.tsx      two-page open-book layout (landscape, paged)
```

## Roadmap (build order)

1. ✅ Scaffold + GPU recolor + reader + local persistence.
2. ✅ **Export a dark PDF** (300 DPI, saturation-aware) — the "download → open in
   Books" flow. See `src/export/exportPdf.ts`. Raster for now (sharp but not
   selectable); vector export is a later milestone.
3. ✅ Image handling v2 (`engine/pipeline.ts`): page polarity (dark covers pass
   through), structural masking of declared XObject rects, content-derived
   masking for photos inside full-page bitmaps, colour-text lightness flip.
4. ✅ Library shelf (thumbnails, progress, delete, persistent storage) +
   launch-into-last-book + immersive chrome toggle + pinch-to-zoom.
5. ✅ Search (in-book streaming + highlights, library filter), bookmarks,
   rename/derived titles, library backup & restore.
6. 🟡 **Sync reading state** (not bytes) — built + verified, awaiting a
   `workers.dev` subdomain to go live. Positions/themes/titles/bookmarks/
   highlights sync end-to-end encrypted; a "ghost shelf" lists books whose PDF
   isn't on this device; content-hash ids make re-adding from Files resume
   exactly. PDFs never leave the device. Worker + D1 in `sync-worker/` (deployed,
   pending subdomain); client in `storage/sync*.ts`. Set `DEFAULT_SYNC_URL` in
   `storage/syncClient.ts` once the subdomain exists (`syncConfigured()` gates
   the UI until then). Merge is per-record last-write-wins keyed by `updatedAt`;
   deletes propagate as tombstones.
7. ✅ Selectable text layer (`reader/TextLayer.tsx`) → passage highlights,
   copy. Off by default ("T" toggles select mode) so taps still turn pages.
   Highlights persist as character RANGES, never pixel rects, so they survive
   zoom/crop/other screens.
8. ✅ Continuous scroll (`reader/ContinuousReader.tsx`) + landscape two-page
   spread (`reader/SpreadReader.tsx`). Both are opt-in layouts that reuse the
   paged pipeline via a shared GL context blitted per page; single-page paged
   mode stays the default and is untouched. Spread auto-activates in landscape
   (toggle in settings).
9. ✅ **Text Mode** (reflow) — `engine/reflow.ts` reconstructs paragraphs from
   the text layer; `reader/TextReader.tsx` streams them as a scrolling column
   in your font/size/spacing. Digital PDFs only; scans need OCR (below).
10. 🟡 Vector export (`src/export/vectorPdf.ts`, beta button in the drawer):
    rewrites content-stream colour operators onto the theme ramp; selectable
    text, ~60× smaller files. Raster export stays default until it graduates.
    Also shipped alongside: notes export (`export/exportNotes.ts`), page-range
    extract (`export/extractPages.ts`), read aloud (`reader/readAloud.ts`).
11. Scanned-PDF OCR path.

## Deployment

Production: **https://nocturne-ten-weld.vercel.app** — Vercel project `nocturne`
connected to GitHub `Vishalr61/nocturne`. **Pushing to `main` auto-deploys.**
Nothing to configure locally; verify after a push by curling the site.

## How to verify changes (no test suite — verify visually)

Rendering work is validated by driving the real app in headless Chromium and
reading screenshots. The setup that works on this machine:

- Python Playwright (`/opt/homebrew/opt/python@3.12/bin/python3.12`); pass
  `executable_path=~/Library/Caches/ms-playwright/chromium_headless_shell-1228/…/chrome-headless-shell`
  to `chromium.launch()` (the default browser download is absent). WebGL2 works.
- Emulate a phone: viewport 390×844, `device_scale_factor=3`; add
  `has_touch=True` for gesture tests (pinch via CDP `Input.dispatchTouchEvent`).
- Load a book with `page.locator("input[type=file]").first.set_input_files(pdf)`
  (there are two file inputs — import + restore backup); the book is loaded
  once `button[aria-label='Reading settings']` appears. The classification
  label (`page: …`) sits at the BOTTOM of the settings drawer, not the footer.
  Set the React range sliders via the native value setter + an `input`
  event, not `fill()`.
- Ground-truth page renders and test-PDF assembly: PyMuPDF in
  `~/patchpdf/backend/.venv/bin/python`.
- Good test books: `~/Documents/Hobby/Books/Red Rising/red-rising.pdf` (dark
  cover, blue TOC links, greyscale map), `~/Documents/CompTIA/SybexCompTIA.pdf`
  (colour cover, greyscale photos, full-page bitmaps + text layer),
  `~/Documents/Hobby/Books/enders_game_-_full_novel.pdf` (pure prose — must
  never regress).

## Guardrails for agents

- **Read the source first.** It is ground truth. Verify claims against the code.
- **Keep `tsc --noEmit` and `vite build` green at every step.**
- **Never invert images.** The whole point is recolouring ink while preserving
  colour content. Any new recolor path must respect this.
- **No blur.** Never persist/scale a rasterized page as the display source;
  re-render vectors at the target resolution and recolor that. One deliberate
  cap: `clampRenderDpr` (engine/pdf.ts) keeps any canvas ≤ ~16.7M px / 8192 px
  per side — iOS's hard limits — so extreme zoom renders slightly soft instead
  of blank pages or a memory-killed tab. Still a fresh vector render each time.
- **Local-first & private.** This is the rule, stated precisely so it doesn't
  get read as "never write a backend" and doesn't get read as "a server is fine":
  - **PDF bytes never leave the device.** No uploading book content, ever, and
    no server-side rendering, OCR, or thumbnailing of a user's book.
  - **The app must work fully offline with zero server.** Sync is additive and
    opt-in; if the backend is down or never configured, nothing degrades.
  - **No content accounts, no PII.** Identity for sync is a locally generated
    device secret the user copies between devices — not an email/password login.
  - Roadmap 6 (state-only sync: positions, themes, titles, bookmarks) is
    explicitly *allowed* by this rule. Uploading a book is *not*. Keep the
    `storage/db.ts` seam clean so sync stays swappable.
- **DRM-free only.** Never add anything that circumvents PDF protection.
- Work in small reviewable increments; run typecheck + build before declaring done.
