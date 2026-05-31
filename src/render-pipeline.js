import {
  buildProgram,
  createFramebuffer,
} from './gl-utils.js';

import quadVert from './shaders/vert/quad.vert';
import colorInFrag from './shaders/pipeline/color-in.frag';
import colorOutFrag from './shaders/pipeline/color-out.frag';
import forwardFrag from './shaders/pipeline/forward.frag';
import forwardYFrag from './shaders/pipeline/forward-y.frag';
import inverseFrag from './shaders/pipeline/inverse.frag';
import inverseYFrag from './shaders/pipeline/inverse-y.frag';
import quantizeFrag from './shaders/pipeline/quantize.frag';
import quantizeYFrag from './shaders/pipeline/quantize-y.frag';
import passthroughFrag from './shaders/pipeline/passthrough.frag';
import blitClampFrag from './shaders/blit/blit-clamp.frag';
import blitRepeatFrag from './shaders/blit/blit-repeat.frag';
import blitMirrorFrag from './shaders/blit/blit-mirror.frag';
import blitMaskFrag from './shaders/blit/blit-mask.frag';

export const DEFAULT_WAVE_BODY = 'return cos(angle);';

// Patch the DCTLIVE_WAVE_BODY define in a glslified inverse shader source.
// Using a #define (rather than replacing the function body directly) means the
// target is a preprocessor directive — glslify never renames these, so the
// pattern is stable across shader refactors.
export function buildInverseSource(templateSrc, waveBody) {
  const pattern = /#define DCTLIVE_WAVE_BODY [^\n]*/;
  if (!pattern.test(templateSrc)) {
    throw new Error('DCTLive: could not locate DCTLIVE_WAVE_BODY define in inverse shader');
  }
  return templateSrc.replace(pattern, `#define DCTLIVE_WAVE_BODY ${waveBody}`);
}

export default class RenderPipeline {
  constructor(gl, width, height, texType) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this._texType = texType;
    this._yOnly = false;
    this._waveBody = DEFAULT_WAVE_BODY;

    // Caches for GPU resource locations — populated lazily, cleared on program deletion.
    this._uniformCache = new Map();
    this._attribCache  = new Map();

    this._passthroughProgram = buildProgram(gl, quadVert, passthroughFrag);

    // Flipped version for passthrough: replace #define DCTLIVE_FLIP_UV 0 with 1
    const passthroughFlipSource = passthroughFrag.replace(
      '#define DCTLIVE_FLIP_UV 0',
      '#define DCTLIVE_FLIP_UV 1'
    );
    this._passthroughFlipYProgram = buildProgram(gl, quadVert, passthroughFlipSource);

    this._blitPrograms = {
      clamp:  buildProgram(gl, quadVert, blitClampFrag),
      repeat: buildProgram(gl, quadVert, blitRepeatFrag),
      mirror: buildProgram(gl, quadVert, blitMirrorFrag),
      mask:   buildProgram(gl, quadVert, blitMaskFrag),
    };

    this._quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this._buildPrograms();
    this._createFramebuffers();
  }

  _buildPrograms() {
    const gl = this.gl;

    this._colorInProgram  = buildProgram(gl, quadVert, colorInFrag);
    this._colorOutProgram = buildProgram(gl, quadVert, colorOutFrag);

    // Flipped version: replace #define DCTLIVE_FLIP_UV 0 with 1
    const colorOutFlipSource = colorOutFrag.replace(
      '#define DCTLIVE_FLIP_UV 0',
      '#define DCTLIVE_FLIP_UV 1'
    );
    this._colorOutFlipYProgram = buildProgram(gl, quadVert, colorOutFlipSource);

    this._forwardColorProgram = buildProgram(gl, quadVert, forwardFrag);
    this._forwardYOnlyProgram = buildProgram(gl, quadVert, forwardYFrag);

    this._inverseFragTemplate  = inverseFrag;
    this._inverseYFragTemplate = inverseYFrag;

    this._inverseColorProgram = buildProgram(gl, quadVert, buildInverseSource(inverseFrag, DEFAULT_WAVE_BODY));
    this._inverseYOnlyProgram = buildProgram(gl, quadVert, buildInverseSource(inverseYFrag, DEFAULT_WAVE_BODY));

    this._quantizeColorProgram = buildProgram(gl, quadVert, quantizeFrag);
    this._quantizeYOnlyProgram = buildProgram(gl, quadVert, quantizeYFrag);

    // H and V passes share one program — direction is controlled by the isVert uniform.
    this._activeFwd = this._forwardColorProgram;
    this._activeInv = this._inverseColorProgram;
  }

  // Cached getUniformLocation — avoids a driver call every frame.
  _u(program, name) {
    let map = this._uniformCache.get(program);
    if (!map) { map = new Map(); this._uniformCache.set(program, map); }
    if (!map.has(name)) map.set(name, this.gl.getUniformLocation(program, name));
    return map.get(name);
  }

  // Cached getAttribLocation.
  _a(program, name) {
    let map = this._attribCache.get(program);
    if (!map) { map = new Map(); this._attribCache.set(program, map); }
    if (!map.has(name)) map.set(name, this.gl.getAttribLocation(program, name));
    return map.get(name);
  }

  // Delete programs and clear their cache entries.
  _deletePrograms(...progs) {
    for (const prog of progs) {
      this.gl.deleteProgram(prog);
      this._uniformCache.delete(prog);
      this._attribCache.delete(prog);
    }
  }

  // Common fullscreen-quad draw: bind program + framebuffer, clear, set position
  // attrib, call setupFn() for uniforms and textures, then draw.
  _draw(program, target, setupFn) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.width, this.height);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const posLoc = this._a(program, 'position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    setupFn();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  setWaveFunction(glslBody) {
    // Normalize to single line: collapse whitespace and newlines to prevent multiline define syntax.
    const normalized = glslBody.trim().replace(/\s+/g, ' ');
    const colorSource = buildInverseSource(this._inverseFragTemplate, normalized);
    const yOnlySource = buildInverseSource(this._inverseYFragTemplate, normalized);

    this._deletePrograms(this._inverseColorProgram, this._inverseYOnlyProgram);

    this._inverseColorProgram = buildProgram(this.gl, quadVert, colorSource);
    this._inverseYOnlyProgram = buildProgram(this.gl, quadVert, yOnlySource);

    this._activeInv = this._yOnly ? this._inverseYOnlyProgram : this._inverseColorProgram;
    this._waveBody = normalized;
  }

  resetWaveFunction() {
    this.setWaveFunction(DEFAULT_WAVE_BODY);
  }

  setYOnly(enabled) {
    this._yOnly = enabled;
    this._activeFwd = enabled ? this._forwardYOnlyProgram : this._forwardColorProgram;
    this._activeInv = enabled ? this._inverseYOnlyProgram : this._inverseColorProgram;
  }

  setResolution(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this._resizeFramebuffers();
  }

  render(config) {
    const {
      inputTexture,
      uvScale,
      uvOffset,
      wrap,
      dctHorizontal,
      dctVertical,
      idctHorizontal,
      idctVertical,
      quantizeActive,
      flipY,
      resolveUniform,
    } = config;

    if (!inputTexture) return;

    const anyForwardDCT = dctHorizontal || dctVertical;
    const anyInverseDCT = idctHorizontal || idctVertical;
    const anyDCT = anyForwardDCT || anyInverseDCT;

    // Step 1: Blit input to internal framebuffer (handles fit/fill/stretch and wrap)
    this._runBlit(inputTexture, uvScale, uvOffset, wrap);
    let tex = this._fbInput.texture;

    // Step 2: Convert RGB → YCbCr. Runs whenever any DCT is active, independent
    // of which specific passes are enabled, so conversion is never skipped mid-chain.
    if (anyDCT) {
      this._renderColorIn(tex);
      tex = this._fbColorIn.texture;
    }

    // Step 3: Forward DCT — runs 1D DCT horizontally, then vertically.
    if (dctHorizontal) {
      this._renderPass(this._activeFwd, this._fbTempA.framebuffer, tex, false, false, resolveUniform);
      tex = this._fbTempA.texture;
    }
    if (dctVertical) {
      this._renderPass(this._activeFwd, this._fbDCT.framebuffer, tex, true, false, resolveUniform);
      tex = this._fbDCT.texture;
    }

    // Step 4: Quantization — rounds coefficients to a grid.
    // Skipped entirely when all quantize parameters are zero (no-op pass).
    if (anyInverseDCT && quantizeActive) {
      const prog = this._yOnly ? this._quantizeYOnlyProgram : this._quantizeColorProgram;
      this._renderQuantize(prog, tex, resolveUniform);
      tex = this._fbQuantized.texture;
    }

    // Step 5: Inverse DCT — reconstructs pixel values from (quantized) coefficients.
    if (anyInverseDCT) {
      if (idctHorizontal && idctVertical) {
        this._renderPass(this._activeInv, this._fbTempA.framebuffer, tex, false, true, resolveUniform);
        this._renderPass(this._activeInv, this._fbTempB.framebuffer, this._fbTempA.texture, true, true, resolveUniform);
        tex = this._fbTempB.texture;
      } else if (idctHorizontal) {
        this._renderPass(this._activeInv, this._fbTempA.framebuffer, tex, false, true, resolveUniform);
        tex = this._fbTempA.texture;
      } else {
        this._renderPass(this._activeInv, this._fbTempA.framebuffer, tex, true, true, resolveUniform);
        tex = this._fbTempA.texture;
      }

      // Convert YCbCr → RGB for final display
      this._renderColorOut(tex, resolveUniform, !flipY);
    } else if (anyDCT) {
      // Forward-only mode: display raw DCT coefficients interpreted as YCbCr.
      // This is an artistic/visualisation mode — the output is not "correct" RGB.
      this._renderColorOut(tex, resolveUniform, !flipY);
    } else {
      // No DCT at all: passthrough
      this._renderPassthrough(tex, null, !flipY);
    }
  }

  _createFramebuffers() {
    const gl = this.gl;
    const t = this._texType;
    this._fbInput     = createFramebuffer(gl, this.width, this.height, t);
    this._fbColorIn   = createFramebuffer(gl, this.width, this.height, t);
    this._fbTempA     = createFramebuffer(gl, this.width, this.height, t);
    this._fbDCT       = createFramebuffer(gl, this.width, this.height, t);
    this._fbQuantized = createFramebuffer(gl, this.width, this.height, t);
    this._fbTempB     = createFramebuffer(gl, this.width, this.height, t);
  }

  _resizeFramebuffers() {
    const gl = this.gl;
    for (const fb of [this._fbInput, this._fbColorIn, this._fbTempA, this._fbDCT, this._fbQuantized, this._fbTempB]) {
      if (fb) {
        gl.deleteFramebuffer(fb.framebuffer);
        gl.deleteTexture(fb.texture);
      }
    }
    this._createFramebuffers();
  }

  _runBlit(rawTex, uvScale, uvOffset, wrap) {
    const gl = this.gl;
    const prog = this._blitPrograms[wrap] || this._blitPrograms.mask;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbInput.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const posLoc = this._a(prog, 'position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this._u(prog, 'resolution'), this.width, this.height);
    gl.uniform2fv(this._u(prog, 'uvScale'), uvScale);
    gl.uniform2fv(this._u(prog, 'uvOffset'), uvOffset);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rawTex);
    gl.uniform1i(this._u(prog, 'inputTexture'), 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _renderPass(program, target, inputTexture, isVert, isInverse, resolveUniform) {
    const gl = this.gl;
    this._draw(program, target, () => {
      gl.uniform2f(this._u(program, 'resolution'), this.width, this.height);
      gl.uniform1i(this._u(program, 'isVert'), isVert ? 1 : 0);
      gl.uniform1i(this._u(program, 'blockSize'), resolveUniform('blockSize'));
      gl.uniform1f(this._u(program, 'lpf'), resolveUniform('lpf'));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      gl.uniform1i(this._u(program, 'inputTexture'), 0);
      if (isInverse) {
        gl.uniform1f(this._u(program, 'time'), performance.now() / 1000.0);
        gl.uniform1f(this._u(program, 'wi'), resolveUniform('waveInput'));
      }
    });
  }

  _renderQuantize(program, inputTexture, resolveUniform) {
    const gl = this.gl;
    this._draw(program, this._fbQuantized.framebuffer, () => {
      gl.uniform2f(this._u(program, 'resolution'), this.width, this.height);
      gl.uniform1i(this._u(program, 'blockSize'), resolveUniform('blockSize'));
      gl.uniform1f(this._u(program, 'highFreqMultiplier'), resolveUniform('highFreqMultiplier'));
      gl.uniform1f(this._u(program, 'quantizeY'),  resolveUniform('quantizeY'));
      gl.uniform1f(this._u(program, 'quantizeYf'), resolveUniform('quantizeYf'));
      gl.uniform1f(this._u(program, 'quantizeC'),  resolveUniform('quantizeC'));
      gl.uniform1f(this._u(program, 'quantizeCf'), resolveUniform('quantizeCf'));
      gl.uniform1f(this._u(program, 'quantizeA'),  resolveUniform('quantizeA'));
      gl.uniform1f(this._u(program, 'quantizeAf'), resolveUniform('quantizeAf'));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      gl.uniform1i(this._u(program, 'inputTexture'), 0);
    });
  }

  _renderColorIn(inputTexture) {
    const gl = this.gl;
    const prog = this._colorInProgram;
    this._draw(prog, this._fbColorIn.framebuffer, () => {
      gl.uniform2f(this._u(prog, 'resolution'), this.width, this.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      gl.uniform1i(this._u(prog, 'inputTexture'), 0);
    });
  }

  _renderColorOut(inputTexture, resolveUniform, flipViewport = false) {
    const gl = this.gl;
    const prog = flipViewport ? this._colorOutFlipYProgram : this._colorOutProgram;
    this._draw(prog, null, () => {
      gl.uniform2f(this._u(prog, 'resolution'), this.width, this.height);
      gl.uniform1i(this._u(prog, 'yOnlyMode'), this._yOnly ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      gl.uniform1i(this._u(prog, 'inputTexture'), 0);
    });
  }

  _renderPassthrough(inputTexture, target, flipViewport = false) {
    const gl = this.gl;
    const prog = flipViewport ? this._passthroughFlipYProgram : this._passthroughProgram;
    this._draw(prog, target, () => {
      gl.uniform2f(this._u(prog, 'resolution'), this.width, this.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      gl.uniform1i(this._u(prog, 'inputTexture'), 0);
    });
  }

  destroy() {
    const gl = this.gl;

    this._deletePrograms(
      this._colorInProgram, this._colorOutProgram, this._colorOutFlipYProgram,
      this._forwardColorProgram, this._forwardYOnlyProgram,
      this._inverseColorProgram, this._inverseYOnlyProgram,
      this._quantizeColorProgram, this._quantizeYOnlyProgram,
      this._passthroughProgram, this._passthroughFlipYProgram,
    );
    for (const prog of Object.values(this._blitPrograms)) this._deletePrograms(prog);
    gl.deleteBuffer(this._quadBuffer);

    for (const fb of [this._fbInput, this._fbColorIn, this._fbTempA, this._fbDCT, this._fbQuantized, this._fbTempB]) {
      gl.deleteFramebuffer(fb.framebuffer);
      gl.deleteTexture(fb.texture);
    }
  }
}
