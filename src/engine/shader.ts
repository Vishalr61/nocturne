// The heart of Nocturne's "recolor, don't invert images" promise.
//
// A naive dark-mode filter inverts every pixel, so colour photos become film
// negatives. We don't do that. For each pixel we measure how *saturated* it is:
//   - Low saturation (greys: text, rules, paper) => it is ink-on-paper. Remap it
//     onto the theme by interpolating fg<->bg across its luminance. Because we
//     interpolate (not threshold), anti-aliased glyph edges stay crisp.
//   - High saturation (a colour photo, a chart, an icon) => leave it ALONE.
//
// This is the pixel-level first cut. The structural masking path (leaving
// declared PDF image XObjects untouched by their known bounding boxes) layers on
// top of this later and is even more precise — see src/engine/classify.ts.

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
uniform vec3 uBg;         // theme "paper" target (dark)
uniform vec3 uFg;         // theme "ink" target (light)
uniform float uSatCut;    // saturation above this = treated as a colour image
uniform float uStrength;  // 0 = original, 1 = full recolor

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float saturation(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx <= 0.0001 ? 0.0 : (mx - mn) / mx;
}

void main() {
  vec3 src = texture(uTex, vUv).rgb;

  // Ink<->paper remap: L=0 (ink) -> fg, L=1 (paper) -> bg. Smooth = crisp edges.
  float L = luma(src);
  vec3 recolored = mix(uFg, uBg, L);

  // Fade the recolor out as the pixel gets more colourful, so photos/charts/icons
  // pass through untouched. smoothstep gives a soft handoff, no hard seams.
  float sat = saturation(src);
  float keepColor = smoothstep(uSatCut * 0.6, uSatCut, sat);

  vec3 outc = mix(recolored, src, keepColor);
  outc = mix(src, outc, uStrength);
  fragColor = vec4(outc, 1.0);
}`
