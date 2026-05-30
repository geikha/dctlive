import { buildProgram, buildProgramWithDefines } from './gl-utils.js';
import RenderPipeline, { DEFAULT_WAVE_BODY, buildInverseSource } from './render-pipeline.js';

import quadVert from './shaders/quad.vert';
import dctForwardBaseFrag from './shaders/dct-forward-base.frag';
import dctInverseBaseFrag from './shaders/dct-inverse-base.frag';
import dctQuantizeFrag from './shaders/dct-quantize.frag';

// 8-bit RGBM encoding.
//
// PROBLEM
// Each color channel gets 256 possible values. The DCT math produces numbers
// outside that range. We need a way to squeeze them into 0-255.
//
// SOLUTION: Two ideas working together
//
// 1. COMPANDING
//    Idea: Don't spread precision evenly. Instead, give more detail to small
//    numbers (where we need it) and less detail to large numbers.
//    Method: Use sqrt() — it naturally squeezes large numbers closer together.
//    During encode: c = sqrt(n)  →  small numbers spread far apart, large cluster
//    During decode: n = c²       →  expand back to original (one multiply)
//
// 2. RGBM (RGB + Multiplier)
//    Each pixel stores its own scale (its biggest RGB value) in alpha.
//    All three RGB values in that pixel scale relative to that value, always
//    using the full 0–255 range regardless of magnitude.
//    RGBM_MAX is the assumed upper bound for any coefficient. Values above
//    it get clamped. Values below it are encoded with full precision.
//    The DCT applies a normalization factor (2/blockSize) to prevent larger
//    blocks from producing larger coefficients. So RGBM_MAX can stay the same
//    regardless of blockSize.
//
// THE PIPELINE
// Four stages, each a separate shader program. Each stage decodes input (if needed),
// does its math, then re-encodes for the next stage:
//   1. fwdH   input → compress to 8-bit
//   2. fwdV   decompress → apply quantization → compress to 8-bit
//   3. invH   decompress → inverse transform → compress to 8-bit
//   4. invV   decompress → inverse transform → output (no compression needed)

// Upper bound assumed for DCT coefficient magnitude. Coefficients above this get
// clamped. Lower values = more precision for small coefficients, less headroom for large ones.
const RGBM_MAX = 4.0;

const RGBM_ENCODE =
  `float mv = max(max(abs(sum.x), abs(sum.y)), abs(sum.z)); ` +
  `mv = clamp(mv, 0.01, ${RGBM_MAX.toFixed(1)}); ` +
  'vec3 nrm = sum.xyz / mv; ' +
  'gl_FragColor.xyz = (sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5; ' +
  `gl_FragColor.w = sqrt(mv / ${RGBM_MAX.toFixed(1)});`;

function rgbmDecode(sampleExpr) {
  return (
    `vec4 texVal = ${sampleExpr}; ` +
    `float mv = texVal.w * texVal.w * ${RGBM_MAX.toFixed(1)}; ` +
    'vec3 cmp = texVal.xyz * 2.0 - 1.0; ' +
    'vec4 val = vec4((cmp * abs(cmp)) * mv, 1.0);'
  );
}

function buildFwdH(src) {
  return src.replace(/gl_FragColor\s*=\s*sum;/, RGBM_ENCODE);
}

function buildFwdV(src) {
  return src
    .replace(/vec4 val = texture2D\(inputTexture, uv\);/, rgbmDecode('texture2D(inputTexture, uv)'))
    .replace(/gl_FragColor\s*=\s*sum;/, RGBM_ENCODE);
}

function buildInvH(src) {
  return src
    .replace(
      /vec4 val = texture2D\(inputTexture, \(blockOrigin \+ bv \* fdelta\) \/ resolution\);/,
      rgbmDecode('texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution)')
    )
    .replace(/gl_FragColor\s*=\s*sum;/, RGBM_ENCODE);
}

function buildInvV(src) {
  return src
    .replace(
      /vec4 val = texture2D\(inputTexture, \(blockOrigin \+ bv \* fdelta\) \/ resolution\);/,
      rgbmDecode('texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution)')
    )
    .replace(/gl_FragColor\s*=\s*sum;/, 'gl_FragColor = clamp(sum, 0.0, 1.0); gl_FragColor.a = 1.0;');
}

function buildQuantize8bit(src) {
  // Quantize pass needs RGBM decode on input and encode on output
  return src
    .replace(/vec4 coeff = texture2D\(inputTexture, gl_FragCoord\.xy \/ resolution\);/,
      rgbmDecode('texture2D(inputTexture, gl_FragCoord.xy / resolution)'))
    .replace(/gl_FragColor = coeff;/, RGBM_ENCODE);
}

export default class RenderPipeline8bit extends RenderPipeline {
  _buildPrograms() {
    const gl = this.gl;

    // Precompute injected forward sources (static — no wave replacement needed)
    // Use buildProgramWithDefines to inject COLOR_ENABLED, then apply RGBM encoding
    const fwdColorBase_H = buildFwdH('#define COLOR_ENABLED 1\n' + dctForwardBaseFrag);
    const fwdColorBase_V = buildFwdV('#define COLOR_ENABLED 1\n' + dctForwardBaseFrag);
    const fwdYBase_H     = buildFwdH('#define COLOR_ENABLED 0\n' + dctForwardBaseFrag);
    const fwdYBase_V     = buildFwdV('#define COLOR_ENABLED 0\n' + dctForwardBaseFrag);

    // Precompute injected inverse templates (wave replacement operates on these)
    const invColorBase_H = buildInvH('#define COLOR_ENABLED 1\n' + dctInverseBaseFrag);
    const invColorBase_V = buildInvV('#define COLOR_ENABLED 1\n' + dctInverseBaseFrag);
    const invYBase_H     = buildInvH('#define COLOR_ENABLED 0\n' + dctInverseBaseFrag);
    const invYBase_V     = buildInvV('#define COLOR_ENABLED 0\n' + dctInverseBaseFrag);

    this._invColorH_tpl = invColorBase_H;
    this._invColorV_tpl = invColorBase_V;
    this._invYH_tpl     = invYBase_H;
    this._invYV_tpl     = invYBase_V;

    // Quantization pass with RGBM encoding
    const quantizeColorBase = buildQuantize8bit('#define isColorMode 1\n' + dctQuantizeFrag);
    const quantizeYBase     = buildQuantize8bit('#define isColorMode 0\n' + dctQuantizeFrag);
    this._quantizeColorProgram = buildProgram(gl, quadVert, quantizeColorBase);
    this._quantizeYOnlyProgram = buildProgram(gl, quadVert, quantizeYBase);

    // Build forward programs
    this._fwdColorH = buildProgram(gl, quadVert, fwdColorBase_H);
    this._fwdColorV = buildProgram(gl, quadVert, fwdColorBase_V);
    this._fwdYH     = buildProgram(gl, quadVert, fwdYBase_H);
    this._fwdYV     = buildProgram(gl, quadVert, fwdYBase_V);

    // Build inverse programs
    this._invColorH = buildProgram(gl, quadVert, buildInverseSource(this._invColorH_tpl, DEFAULT_WAVE_BODY));
    this._invColorV = buildProgram(gl, quadVert, buildInverseSource(this._invColorV_tpl, DEFAULT_WAVE_BODY));
    this._invYH     = buildProgram(gl, quadVert, buildInverseSource(this._invYH_tpl, DEFAULT_WAVE_BODY));
    this._invYV     = buildProgram(gl, quadVert, buildInverseSource(this._invYV_tpl, DEFAULT_WAVE_BODY));

    this._activeFwdH = this._fwdColorH;
    this._activeFwdV = this._fwdColorV;
    this._activeInvH = this._invColorH;
    this._activeInvV = this._invColorV;
  }

  setWaveFunction(glslBody) {
    const gl = this.gl;

    gl.deleteProgram(this._invColorH);
    gl.deleteProgram(this._invColorV);
    gl.deleteProgram(this._invYH);
    gl.deleteProgram(this._invYV);

    this._invColorH = buildProgram(gl, quadVert, buildInverseSource(this._invColorH_tpl, glslBody));
    this._invColorV = buildProgram(gl, quadVert, buildInverseSource(this._invColorV_tpl, glslBody));
    this._invYH     = buildProgram(gl, quadVert, buildInverseSource(this._invYH_tpl, glslBody));
    this._invYV     = buildProgram(gl, quadVert, buildInverseSource(this._invYV_tpl, glslBody));

    this._activeInvH = this._yOnly ? this._invYH : this._invColorH;
    this._activeInvV = this._yOnly ? this._invYV : this._invColorV;

    this._waveBody = glslBody;
  }

  setYOnly(enabled) {
    this._yOnly = enabled;
    this._activeFwdH = enabled ? this._fwdYH : this._fwdColorH;
    this._activeFwdV = enabled ? this._fwdYV : this._fwdColorV;
    this._activeInvH = enabled ? this._invYH : this._invColorH;
    this._activeInvV = enabled ? this._invYV : this._invColorV;
  }

  destroy() {
    const gl = this.gl;

    for (const prog of [
      this._fwdColorH, this._fwdColorV, this._fwdYH, this._fwdYV,
      this._invColorH, this._invColorV, this._invYH, this._invYV,
      this._quantizeColorProgram, this._quantizeYOnlyProgram,
    ]) gl.deleteProgram(prog);

    gl.deleteProgram(this._passthroughProgram);
    for (const prog of Object.values(this._blitPrograms)) gl.deleteProgram(prog);
    gl.deleteBuffer(this._quadBuffer);

    for (const fb of [this._fbInput, this._fbTempA, this._fbDCT, this._fbQuantized, this._fbTempB]) {
      gl.deleteFramebuffer(fb.framebuffer);
      gl.deleteTexture(fb.texture);
    }
  }
}
