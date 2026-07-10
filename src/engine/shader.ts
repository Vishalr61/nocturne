// The heart of Nocturne's "recolor, don't invert images" promise.
//
// A naive dark-mode filter inverts every pixel, so colour photos become film
// negatives. We don't do that. The fragment shader has three cooperating rules,
// driven by per-page structure computed in engine/pipeline.ts:
//
//   1. Ink remap. Low-saturation pixels (greys: text, rules, paper) are ink on
//      paper. Remap them onto the theme by interpolating fg<->bg across
//      luminance. Interpolation (not thresholding) keeps glyph edges crisp.
//   2. Saturated pixels are either PRESERVED (photos, charts — the default) or,
//      on pages that structurally contain no images (uColorText), kept in hue
//      but shifted to the luminance the ink ramp would give. That is the
//      dark-mode hyperlink treatment: paper-era blue text becomes readable
//      pastel blue instead of drowning against the dark ground.
//   3. Structure wins over statistics. Pixels inside declared image XObject
//      rects (uMask) keep their original colours, dimmed slightly (uImageDim)
//      to cut glare against the dark page. And a page whose dominant tone is
//      already dark (uInkFlip = 0) — a black book cover — is already a night
//      page: it passes through untouched instead of being flipped bright.

export const VERT_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // aPos is a full-screen quad in clip space [-1,1]. Flip V so texture row 0
  // (top of the rendered PDF page) maps to the top of the canvas.
  vUv = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTex;   // the PDF page as rendered by pdf.js
uniform sampler2D uMask;  // R=1 inside declared image rects (preserve those)
uniform vec3 uBg;         // theme "paper" target (dark)
uniform vec3 uFg;         // theme "ink" target (light)
uniform float uSatCut;    // saturation above this = treated as colour content
uniform float uStrength;  // 0 = original, 1 = full recolor
uniform float uInkFlip;   // 0 = page is already dark; pass it through
uniform float uColorText; // 1 = page has no images; luma-shift saturated pixels
uniform float uHasMask;   // 1 = uMask is valid for this page
uniform float uImageDim;  // brightness for preserved images (anti-glare)

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float saturation(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx <= 0.0001 ? 0.0 : (mx - mn) / mx;
}

void main() {
  vec3 src = texture(uTex, vUv).rgb;
  float L = luma(src);

  // Rule 1 — ink<->paper remap: L=0 (ink) -> fg, L=1 (paper) -> bg.
  vec3 achro = mix(uFg, uBg, L);

  // Rule 2 — saturated pixels: preserved, or (colour-text pages) moved to the
  // luminance the ink ramp lands on while keeping their chroma. Adding the
  // luma delta equally to all channels preserves hue cheaply.
  vec3 lumaShifted = clamp(src + vec3(luma(achro) - L), 0.0, 1.0);
  vec3 satPixel = mix(src, lumaShifted, uColorText);

  float sat = saturation(src);
  float keepColor = smoothstep(uSatCut * 0.6, uSatCut, sat);
  vec3 outc = mix(achro, satPixel, keepColor);

  // Rule 3a — structural mask: declared images keep their pixels (dimmed).
  float m = uHasMask * texture(uMask, vUv).r;
  outc = mix(outc, src * uImageDim, m);

  // Rule 3b — page polarity: an already-dark page is already a night page.
  outc = mix(src, outc, uInkFlip);

  outc = mix(src, outc, uStrength);
  fragColor = vec4(outc, 1.0);
}`
