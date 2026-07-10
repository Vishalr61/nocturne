# Nocturne

A phone-first, offline night-reading environment for the PDFs **you own**. Open a
clunky white-background book PDF, get a crisp, comfortable dark page that keeps
its images intact — then read it in-app or export a dark PDF to open in Apple
Books.

Built for one real habit: *download a book PDF → read it on your phone*. Nocturne
makes that pleasant instead of eye-searing.

## Why it's different

Most "PDF dark mode" tools rasterize the page to a low-res bitmap and invert
every pixel. Two problems fall out of that, and Nocturne fixes both:

1. **Blurry text.** Inverting a baked bitmap and then letting your viewer scale it
   turns crisp vector glyphs into mush. Nocturne re-renders the page fresh at your
   current zoom and recolors it **on the GPU**, so text stays sharp at any zoom.
2. **Ruined images.** Naive inversion turns colour photos into film negatives.
   Nocturne recolors only the *ink* (low-saturation greys) and **leaves colour
   images untouched** — first via a saturation-aware shader, and (soon) via the
   PDF's own declared image regions, so it's precise, not a guess.

## Handling every kind of PDF — never "impossible with this file"

Each page is classified and routed to the right strategy, with a guaranteed floor
that always produces a readable dark page:

| Page kind | Strategy |
| --- | --- |
| Digital text (real text layer) | recolor ink, mask images, keep text crisp & selectable |
| Vector / diagram | luminance recolor of strokes & fills, preserve colour |
| Scanned (page = one image) | adaptive tone-map now; optional OCR → text layer later |
| Anything else | luminance tone-map floor (dark bg, light ink), colour preserved |

## Status — v1 (in progress)

- [x] Project scaffold (Vite + React + TS + Tailwind, installable PWA)
- [x] GPU recolor engine (WebGL2 saturation-aware shader)
- [x] PDF.js render pipeline + per-page classifier
- [x] Local storage (Dexie/IndexedDB): library, per-book profile, resume position
- [x] Minimal reader: open, recolor, theme, page-turn, zoom
- [x] Export a dark PDF (300 DPI, saturation-aware) — the "open in Books" flow
- [ ] Library shelf UI + resume-on-open
- [ ] **Text Mode** (reflow for full font / size / spacing control on prose)
- [ ] Structural image masking via declared XObject rects
- [ ] Vector export upgrade (selectable text in the exported PDF)
- [ ] Scanned-PDF OCR path

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit && vite build
npm run typecheck
```

Deploys as a static PWA (Vercel-ready). No backend, no accounts — everything is
local to your device. Works only on **DRM-free PDFs you own**.
