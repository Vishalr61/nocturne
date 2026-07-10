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
   `engine/recolor.ts` recolors that fresh render on the GPU. Text is always
   vector-crisp; pdf.js's text layer keeps it selectable.
2. **No inverted images.** `engine/shader.ts` measures each pixel's *saturation*:
   low-saturation greys (ink/paper) are remapped onto the theme by interpolating
   `fg`<->`bg` across luminance (interpolation, not thresholding = smooth glyph
   edges); saturated pixels (photos, charts, colour icons) pass through untouched.
   This is the pixel-level first cut. **Structural masking** (leaving declared PDF
   image XObjects untouched by their known bounding boxes) is more precise and
   layers on top — see `imageRects` in `engine/classify.ts` (not yet populated).

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
│   ├── shader.ts     GLSL: saturation-aware ink/paper remap (the recolor rule)
│   ├── recolor.ts    Recolorizer: WebGL2 pass, source canvas -> recolored canvas
│   └── classify.ts   classifyPage -> {kind, strategy, imageRects} (the spine)
├── storage/db.ts     Dexie: books (original bytes), profiles, progress. Local only.
└── reader/Reader.tsx open->recolor->page-turn->theme->zoom; persists profile+progress
```

## Roadmap (build order)

1. ✅ Scaffold + GPU recolor + reader + local persistence.
2. ✅ **Export a dark PDF** (300 DPI, saturation-aware) — the "download → open in
   Books" flow. See `src/export/exportPdf.ts`. Raster for now (sharp but not
   selectable); vector export is a later milestone.
3. Library shelf UI (your saved books) + resume-on-open.
4. **Text Mode** (reflow) for font/size/spacing on prose.
5. Structural image masking (declared XObject rects) + vector export (selectable).
6. Scanned-PDF OCR path.

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
