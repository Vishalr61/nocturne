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
**pdf.js** for parsing, **Dexie/IndexedDB** for local storage. No backend, no
accounts. Ships static (Vercel).

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
   canvas so 1 backing pixel = 1 device pixel (fit-width × zoom). Text is always
   vector-crisp; pdf.js's text layer keeps it selectable.
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
│   └── pipeline.ts   renderDarkPage: polarity, image masking, colour text —
│                     the per-page decisions; shared by reader AND export
├── storage/db.ts     Dexie: books (bytes+thumb), profiles, progress. Local only.
├── library/          Shelf.tsx (saved books, resume, delete) + import.ts (file->DB)
└── reader/Reader.tsx recolor, tap zones (turn/immersive), pinch zoom; persists per book
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
5. **Text Mode** (reflow) for font/size/spacing on prose.
6. Vector export (rewrite colour operators; selectable text in the export).
7. Scanned-PDF OCR path.

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
- Load a book with `page.set_input_files("input[type=file]", pdf)`; a page has
  finished rendering when the footer text contains `page:` (the classification
  label). Set the React range sliders via the native value setter + an `input`
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
  re-render vectors at the target resolution and recolor that.
- **Local-only & private.** PDFs never leave the device. Keep the `storage/db.ts`
  seam clean so cloud sync can be added later without touching the rest of the app.
- **DRM-free only.** Never add anything that circumvents PDF protection.
- Work in small reviewable increments; run typecheck + build before declaring done.
