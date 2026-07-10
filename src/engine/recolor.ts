import { FRAG_SRC, VERT_SRC } from './shader'
import type { Theme } from './theme'

// A tiny reusable WebGL2 pass: upload a source canvas (a pdf.js-rendered page) as
// a texture and draw it recolored onto a target canvas. Runs on the GPU, so it is
// effectively free even on a phone, and — crucially — we re-run it every time the
// page is re-rendered at a new zoom, so text is never a scaled bitmap => no blur.

export interface RecolorOptions {
  theme: Theme
  satCut?: number // saturation threshold for "this is colour content"
  strength?: number // 0..1 blend of the effect
  /** false = the page is already dark; pass it through untouched. */
  inkFlip?: boolean
  /** true = page has no images; luma-shift saturated pixels (readable links). */
  colorText?: boolean
  /** Low-res mask canvas: white inside declared image rects to preserve. */
  mask?: HTMLCanvasElement | null
  /** Brightness applied to preserved (masked) images to cut glare. */
  imageDim?: number
}

export class Recolorizer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private tex: WebGLTexture
  private maskTex: WebGLTexture
  private u: Record<string, WebGLUniformLocation | null>

  // `preserveDrawingBuffer` must be true for the offscreen export path, where we
  // read pixels back (toBlob) after drawing. The live reader leaves it false.
  constructor(private canvas: HTMLCanvasElement, preserveDrawingBuffer = false) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer })
    if (!gl) throw new Error('webgl2-unavailable')
    this.gl = gl

    this.program = link(gl, VERT_SRC, FRAG_SRC)
    gl.useProgram(this.program)

    // Full-screen quad.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(this.program, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    this.tex = makeTexture(gl)
    this.maskTex = makeTexture(gl)
    // Default 1x1 black mask = "preserve nothing" when no mask is supplied.
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))

    this.u = {
      uTex: gl.getUniformLocation(this.program, 'uTex'),
      uMask: gl.getUniformLocation(this.program, 'uMask'),
      uBg: gl.getUniformLocation(this.program, 'uBg'),
      uFg: gl.getUniformLocation(this.program, 'uFg'),
      uSatCut: gl.getUniformLocation(this.program, 'uSatCut'),
      uStrength: gl.getUniformLocation(this.program, 'uStrength'),
      uInkFlip: gl.getUniformLocation(this.program, 'uInkFlip'),
      uColorText: gl.getUniformLocation(this.program, 'uColorText'),
      uHasMask: gl.getUniformLocation(this.program, 'uHasMask'),
      uImageDim: gl.getUniformLocation(this.program, 'uImageDim'),
    }
  }

  /** Draw `source` recolored into the target canvas, sized to match it. */
  render(source: TexImageSource, w: number, h: number, opts: RecolorOptions) {
    const gl = this.gl
    this.canvas.width = w
    this.canvas.height = h
    gl.viewport(0, 0, w, h)

    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
    if (opts.mask) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, opts.mask)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    }

    gl.uniform1i(this.u.uTex, 0)
    gl.uniform1i(this.u.uMask, 1)
    gl.uniform3fv(this.u.uBg, opts.theme.bg)
    gl.uniform3fv(this.u.uFg, opts.theme.fg)
    gl.uniform1f(this.u.uSatCut, opts.satCut ?? 0.25)
    gl.uniform1f(this.u.uStrength, opts.strength ?? 1)
    gl.uniform1f(this.u.uInkFlip, (opts.inkFlip ?? true) ? 1 : 0)
    gl.uniform1f(this.u.uColorText, opts.colorText ? 1 : 0)
    gl.uniform1f(this.u.uHasMask, opts.mask ? 1 : 0)
    gl.uniform1f(this.u.uImageDim, opts.imageDim ?? 1)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose() {
    const gl = this.gl
    gl.deleteTexture(this.tex)
    gl.deleteTexture(this.maskTex)
    gl.deleteProgram(this.program)
  }
}

function makeTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  return t
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('shader-link-failed: ' + gl.getProgramInfoLog(p))
  }
  return p
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader-compile-failed: ' + gl.getShaderInfoLog(s))
  }
  return s
}
