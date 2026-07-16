// Themes are the user-facing recolor targets. Each maps the two anchor tones of
// a page — "paper" (bright background) and "ink" (dark text) — to a comfortable
// night palette. The recolor shader interpolates between fg (ink) and bg (paper)
// across a pixel's luminance, so anti-aliased glyph edges stay smooth (no
// thresholding = no blur). Colours are linear-ish 0..1 RGB triples for GLSL.

export interface Theme {
  id: string
  name: string
  bg: [number, number, number] // where bright "paper" pixels land
  fg: [number, number, number] // where dark "ink" pixels land
}

export const THEMES: Theme[] = [
  { id: 'true-black', name: 'True Black', bg: [0.0, 0.0, 0.0], fg: [0.85, 0.86, 0.88] },
  { id: 'soft-dark', name: 'Soft Dark', bg: [0.09, 0.1, 0.12], fg: [0.82, 0.84, 0.88] },
  { id: 'warm-sepia', name: 'Warm Sepia', bg: [0.11, 0.09, 0.06], fg: [0.9, 0.82, 0.68] },
  { id: 'dim-grey', name: 'Dim Grey', bg: [0.12, 0.12, 0.13], fg: [0.78, 0.79, 0.82] },
  { id: 'midnight', name: 'Midnight', bg: [0.05, 0.07, 0.12], fg: [0.79, 0.84, 0.93] },
  { id: 'forest', name: 'Forest', bg: [0.06, 0.1, 0.08], fg: [0.82, 0.88, 0.8] },
  { id: 'high-contrast', name: 'High Contrast', bg: [0.0, 0.0, 0.0], fg: [1.0, 1.0, 1.0] },
  // A warm daytime "paper" — near-identity recolor for reading in bright light.
  { id: 'paper', name: 'Paper', bg: [0.92, 0.89, 0.82], fg: [0.17, 0.14, 0.1] },
  // Clean white: recolored (ink remapped, images preserved) on pure white.
  { id: 'white', name: 'White', bg: [1.0, 1.0, 1.0], fg: [0.14, 0.14, 0.16] },
  // The PDF exactly as published — the pipeline passes every pixel through
  // (engine/pipeline.ts checks this id). bg/fg here only colour the chrome.
  { id: 'original', name: 'Original', bg: [0.98, 0.97, 0.95], fg: [0.15, 0.13, 0.1] },
]

export const DEFAULT_THEME = THEMES[1] // Soft Dark — less halation than pure black

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT_THEME
}
