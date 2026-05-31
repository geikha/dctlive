import { buildProgram } from './gl-utils.js';
import RenderPipeline, { DEFAULT_WAVE_BODY, buildInverseSource } from './render-pipeline.js';

import quadVert from './shaders/quad.vert';

// 8-bit precision pipeline using RGBM (color) and YM (Y-only) encoding.
//
// DCT coefficients range beyond 0-1. This pipeline stores them in 8-bit RGBA
// textures using two complementary techniques:
//
// COMPANDING (sqrt): more precision near zero, less near the extremes.
//   Encode: c = sign(x) * sqrt(|x|)    Decode: x = c * |c|
//
// RGBM (color mode): scale factor in alpha channel. All three channels
// normalized to their max value, so 0-255 is used regardless of magnitude.
//
// YM (Y-only mode): same idea, scalar. R = companded value, G = scale factor.
//
// RGBM_MAX = 4.0 is the assumed coefficient ceiling — values above it clamp.
// The DCT normalization factor (2/blockSize) keeps coefficients in range
// independent of block size, so RGBM_MAX is stable.
//
// Unlike the float pipeline, color-in and color-out differ between color/Y-only
// modes (different codec), so setYOnly() swaps all four active programs.

import fwdColor      from './shaders/8bit/forward-color.frag';
import fwdY          from './shaders/8bit/forward-y.frag';
import invColor      from './shaders/8bit/inverse-color.frag';
import invY          from './shaders/8bit/inverse-y.frag';
import quantColor    from './shaders/8bit/quantize-color.frag';
import quantY        from './shaders/8bit/quantize-y.frag';
import colorInColor  from './shaders/8bit/color-in-color.frag';
import colorInY      from './shaders/8bit/color-in-y.frag';
import colorOutColor from './shaders/8bit/color-out-color.frag';
import colorOutY     from './shaders/8bit/color-out-y.frag';

export default class RenderPipeline8bit extends RenderPipeline {
  _buildPrograms() {
    const gl = this.gl;

    // Color-in and color-out differ per mode — stored separately, swapped by setYOnly()
    this._colorInColorProgram  = buildProgram(gl, quadVert, colorInColor);
    this._colorInYProgram      = buildProgram(gl, quadVert, colorInY);
    this._colorOutColorProgram = buildProgram(gl, quadVert, colorOutColor);
    this._colorOutYProgram     = buildProgram(gl, quadVert, colorOutY);

    // Active color-in/out start in color mode (matches base class default)
    this._colorInProgram  = this._colorInColorProgram;
    this._colorOutProgram = this._colorOutColorProgram;

    this._forwardColorProgram = buildProgram(gl, quadVert, fwdColor);
    this._forwardYOnlyProgram = buildProgram(gl, quadVert, fwdY);

    // Store templates so setWaveFunction() can patch and recompile inverse shaders
    this._inverseFragTemplate  = invColor;
    this._inverseYFragTemplate = invY;

    this._inverseColorProgram = buildProgram(gl, quadVert, buildInverseSource(invColor, DEFAULT_WAVE_BODY));
    this._inverseYOnlyProgram = buildProgram(gl, quadVert, buildInverseSource(invY, DEFAULT_WAVE_BODY));

    this._quantizeColorProgram = buildProgram(gl, quadVert, quantColor);
    this._quantizeYOnlyProgram = buildProgram(gl, quadVert, quantY);

    // H and V share one program — isVert uniform drives direction (same as float pipeline)
    this._activeFwd = this._forwardColorProgram;
    this._activeInv = this._inverseColorProgram;
  }

  setWaveFunction(glslBody) {
    // Normalize to single line: collapse whitespace and newlines to prevent multiline define syntax.
    const normalized = glslBody.trim().replace(/\s+/g, ' ');
    this._deletePrograms(this._inverseColorProgram, this._inverseYOnlyProgram);

    this._inverseColorProgram = buildProgram(this.gl, quadVert, buildInverseSource(this._inverseFragTemplate, normalized));
    this._inverseYOnlyProgram = buildProgram(this.gl, quadVert, buildInverseSource(this._inverseYFragTemplate, normalized));

    this._activeInv = this._yOnly ? this._inverseYOnlyProgram : this._inverseColorProgram;
    this._waveBody = normalized;
  }

  setYOnly(enabled) {
    this._yOnly = enabled;

    // Swap color-in/out to match codec (RGBM ↔ YM)
    this._colorInProgram  = enabled ? this._colorInYProgram      : this._colorInColorProgram;
    this._colorOutProgram = enabled ? this._colorOutYProgram     : this._colorOutColorProgram;

    this._activeFwd = enabled ? this._forwardYOnlyProgram : this._forwardColorProgram;
    this._activeInv = enabled ? this._inverseYOnlyProgram : this._inverseColorProgram;
  }

  destroy() {
    this._deletePrograms(
      this._colorInColorProgram, this._colorInYProgram,
      this._colorOutColorProgram, this._colorOutYProgram,
      this._forwardColorProgram, this._forwardYOnlyProgram,
      this._inverseColorProgram, this._inverseYOnlyProgram,
      this._quantizeColorProgram, this._quantizeYOnlyProgram,
      this._passthroughProgram,
    );
    for (const prog of Object.values(this._blitPrograms)) this._deletePrograms(prog);
    this.gl.deleteBuffer(this._quadBuffer);

    for (const fb of [this._fbInput, this._fbColorIn, this._fbTempA, this._fbDCT, this._fbQuantized, this._fbTempB]) {
      this.gl.deleteFramebuffer(fb.framebuffer);
      this.gl.deleteTexture(fb.texture);
    }
  }
}
