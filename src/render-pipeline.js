import {
  buildProgram,
  createFramebuffer,
} from './gl-utils.js';

import quadVert from './shaders/vert/quad.vert';
import passthroughFrag from './shaders/pipeline/passthrough.frag';
import blitClampFrag from './shaders/blit/blit-clamp.frag';
import blitRepeatFrag from './shaders/blit/blit-repeat.frag';
import blitMirrorFrag from './shaders/blit/blit-mirror.frag';
import blitMaskFrag from './shaders/blit/blit-mask.frag';

export const DEFAULT_WAVE_BODY = 'return cos(angle);';

function flipDefine(fragSrc) {
  return fragSrc.replace('#define DCTLIVE_FLIP_UV 0', '#define DCTLIVE_FLIP_UV 1');
}

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
  // ===== 1. LIFECYCLE =====

  constructor(gl, width, height, texType, shaderProvider) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this._texType = texType;
    this._yOnly = false;
    this._waveBody = DEFAULT_WAVE_BODY;
    this.shaderProvider = shaderProvider;

    // Caches for GPU resource locations — populated lazily, cleared on program deletion.
    this._uniformCache = new Map();
    this._attribCache  = new Map();

    this._passthroughProgram      = buildProgram(gl, quadVert, passthroughFrag);
    this._passthroughFlipYProgram = buildProgram(gl, quadVert, flipDefine(passthroughFrag));

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

    for (const fb of [this._fbBlit, this._fbColor, this._fbTemp, this._fbDCT, this._fbQuantized, this._fbFinal]) {
      gl.deleteFramebuffer(fb.framebuffer);
      gl.deleteTexture(fb.texture);
    }
  }

  // ===== 2. PUBLIC API =====

  setResolution(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this._resizeFramebuffers();
  }

  setYOnly(enabled) {
    this._yOnly = enabled;
    this.shaderProvider.yOnly = enabled;

    // Rebuild programs that may have changed based on yOnly state
    this._deletePrograms(
      this._colorInProgram, this._colorOutProgram, this._colorOutFlipYProgram,
      this._forwardColorProgram, this._forwardYOnlyProgram,
      this._inverseColorProgram, this._inverseYOnlyProgram,
    );
    this._buildPrograms();

    // Restore wave function if non-default
    if (this._waveBody !== DEFAULT_WAVE_BODY) {
      this._deletePrograms(this._inverseColorProgram, this._inverseYOnlyProgram);
      this._inverseColorProgram = buildProgram(this.gl, quadVert, buildInverseSource(this._inverseFragTemplate, this._waveBody));
      this._inverseYOnlyProgram = buildProgram(this.gl, quadVert, buildInverseSource(this._inverseYFragTemplate, this._waveBody));
    }

    this._activeFwd = enabled ? this._forwardYOnlyProgram : this._forwardColorProgram;
    this._activeInv = enabled ? this._inverseYOnlyProgram : this._inverseColorProgram;
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

  // ===== 3. MAIN RENDER LOOP =====

  render(config) {
    const {
      inputTexture, uvScale, uvOffset, wrap,
      dctHorizontal, dctVertical,
      idctHorizontal, idctVertical,
      quantizeActive, flipY, uniforms,
    } = config;

    if (!inputTexture) return;

    const anyDCT = (dctHorizontal || dctVertical) || (idctHorizontal || idctVertical);
    const flipOutput = !flipY;

    // Stage 1: Blit raw input into _fbBlit (applies wrap, fit, UV transforms)
    this._runBlit(inputTexture, uvScale, uvOffset, wrap);
    let inputTex = this._fbBlit.texture;

    // Stage 2: If any DCT processing, convert RGB→YCbCr via _fbColor
    if (anyDCT) {
      this._renderColorIn(inputTex);
      inputTex = this._fbColor.texture;
    }

    // Stage 3: Forward DCT horizontal pass
    if (dctHorizontal) {
      this._renderForwardDCTHorizontal(inputTex, uniforms);
      inputTex = this._fbTemp.texture;
    }

    // Stage 3b: Forward DCT vertical pass
    if (dctVertical) {
      this._renderForwardDCTVertical(inputTex, uniforms);
      inputTex = this._fbDCT.texture;
    }

    // Stage 4: Quantization (if active, writes to _fbQuantized)
    if (anyDCT && quantizeActive) {
      const prog = this._yOnly ? this._quantizeYOnlyProgram : this._quantizeColorProgram;
      this._renderQuantize(prog, inputTex, uniforms);
      inputTex = this._fbQuantized.texture;
    }

    // Stage 5: Inverse DCT horizontal pass
    if (idctHorizontal) {
      this._renderInverseDCTHorizontal(inputTex, uniforms);
      inputTex = this._fbTemp.texture;
    }

    // Stage 5b: Inverse DCT vertical pass
    if (idctVertical) {
      this._renderInverseDCTVertical(inputTex, uniforms);
      inputTex = this._fbFinal.texture;
    }

    // Stage 6: Final output (color convert or passthrough)
    if (anyDCT) {
      this._renderColorOut(inputTex, flipOutput);
    } else {
      this._renderPassthrough(inputTex, null, flipOutput);
    }
  }

  // ===== 4. PIPELINE STAGE METHODS =====

  _runBlit(rawTex, uvScale, uvOffset, wrap) {
    const prog = this._blitPrograms[wrap] || this._blitPrograms.mask;
    this._executePass({
      program:  prog,
      target:   this._fbBlit.framebuffer,
      uniforms: {
        resolution: this._res,
        uvScale:    { type: 'vec2', value: uvScale },
        uvOffset:   { type: 'vec2', value: uvOffset },
      },
      textures:   { inputTexture: rawTex },
      clearAlpha: 1,
    });
  }

  _renderColorIn(inputTexture) {
    this._executePass({
      program:  this._colorInProgram,
      target:   this._fbColor.framebuffer,
      uniforms: { resolution: this._res },
      textures: { inputTexture },
    });
  }

  _renderForwardDCTHorizontal(inputTex, uniforms) {
    this._executePass({
      program: this._activeFwd,
      target: this._fbTemp.framebuffer,
      uniforms: {
        resolution: this._res,
        lpf:       { type: 'float', value: uniforms.lpf },
        blockSize: { type: 'int',   value: uniforms.blockSize },
        isVert:    { type: 'int',   value: 0 },
      },
      textures: { inputTexture: inputTex },
    });
  }

  _renderForwardDCTVertical(inputTex, uniforms) {
    this._executePass({
      program: this._activeFwd,
      target: this._fbDCT.framebuffer,
      uniforms: {
        resolution: this._res,
        lpf:       { type: 'float', value: uniforms.lpf },
        blockSize: { type: 'int',   value: uniforms.blockSize },
        isVert:    { type: 'int',   value: 1 },
      },
      textures: { inputTexture: inputTex },
    });
  }

  _renderQuantize(program, inputTexture, uniforms) {
    const passUniforms = {
      resolution:         this._res,
      blockSize:          { type: 'int',   value: uniforms.blockSize },
      highFreqMultiplier: { type: 'float', value: uniforms.highFreqMultiplier },
      quantizeY:          { type: 'float', value: uniforms.quantizeY },
      quantizeYf:         { type: 'float', value: uniforms.quantizeYf },
    };
    if (!this._yOnly) {
      passUniforms.quantizeC  = { type: 'float', value: uniforms.quantizeC };
      passUniforms.quantizeCf = { type: 'float', value: uniforms.quantizeCf };
      passUniforms.quantizeA  = { type: 'float', value: uniforms.quantizeA };
      passUniforms.quantizeAf = { type: 'float', value: uniforms.quantizeAf };
    }
    this._executePass({ program, target: this._fbQuantized.framebuffer, uniforms: passUniforms, textures: { inputTexture } });
  }

  _renderInverseDCTHorizontal(inputTex, uniforms) {
    this._executePass({
      program: this._activeInv,
      target: this._fbTemp.framebuffer,
      uniforms: {
        resolution: this._res,
        lpf:       { type: 'float', value: uniforms.lpf },
        blockSize: { type: 'int',   value: uniforms.blockSize },
        time:      { type: 'float', value: performance.now() / 1000.0 },
        wi:        { type: 'float', value: uniforms.waveInput },
        isVert:    { type: 'int',   value: 0 },
      },
      textures: { inputTexture: inputTex },
    });
  }

  _renderInverseDCTVertical(inputTex, uniforms) {
    this._executePass({
      program: this._activeInv,
      target: this._fbFinal.framebuffer,
      uniforms: {
        resolution: this._res,
        lpf:       { type: 'float', value: uniforms.lpf },
        blockSize: { type: 'int',   value: uniforms.blockSize },
        time:      { type: 'float', value: performance.now() / 1000.0 },
        wi:        { type: 'float', value: uniforms.waveInput },
        isVert:    { type: 'int',   value: 1 },
      },
      textures: { inputTexture: inputTex },
    });
  }

  _renderColorOut(inputTexture, flipViewport = false) {
    this._executePass({
      program:  flipViewport ? this._colorOutFlipYProgram : this._colorOutProgram,
      target:   null,
      uniforms: {
        resolution: this._res,
        yOnlyMode:  { type: 'int', value: this._yOnly ? 1 : 0 },
      },
      textures: { inputTexture },
    });
  }

  _renderPassthrough(inputTexture, target, flipViewport = false) {
    this._executePass({
      program:  flipViewport ? this._passthroughFlipYProgram : this._passthroughProgram,
      target,
      uniforms: { resolution: this._res },
      textures: { inputTexture },
    });
  }

  // ===== 5. GL INFRASTRUCTURE =====

  _executePass({ program, target, uniforms = {}, textures = {}, clearAlpha = 0 }) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, clearAlpha);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const posLoc = this._attribLoc(program, 'position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    for (const [name, { type, value }] of Object.entries(uniforms)) {
      const loc = this._uniformLoc(program, name);
      if      (type === 'float') gl.uniform1f(loc, value);
      else if (type === 'int')   gl.uniform1i(loc, value);
      else if (type === 'vec2')  gl.uniform2f(loc, value[0], value[1]);
    }

    let slot = 0;
    for (const [name, texture] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(this._uniformLoc(program, name), slot);
      slot++;
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  get _res() { return { type: 'vec2', value: [this.width, this.height] }; }

  _uniformLoc(program, name) {
    let map = this._uniformCache.get(program);
    if (!map) { map = new Map(); this._uniformCache.set(program, map); }
    if (!map.has(name)) map.set(name, this.gl.getUniformLocation(program, name));
    return map.get(name);
  }

  _attribLoc(program, name) {
    let map = this._attribCache.get(program);
    if (!map) { map = new Map(); this._attribCache.set(program, map); }
    if (!map.has(name)) map.set(name, this.gl.getAttribLocation(program, name));
    return map.get(name);
  }

  _deletePrograms(...progs) {
    for (const prog of progs) {
      this.gl.deleteProgram(prog);
      this._uniformCache.delete(prog);
      this._attribCache.delete(prog);
    }
  }

  _buildPrograms() {
    const gl = this.gl;
    const sh = this.shaderProvider;

    this._colorInProgram       = buildProgram(gl, quadVert, sh.colorIn);
    this._colorOutProgram      = buildProgram(gl, quadVert, sh.colorOut);
    this._colorOutFlipYProgram = buildProgram(gl, quadVert, flipDefine(sh.colorOut));

    this._forwardColorProgram  = buildProgram(gl, quadVert, sh.forward);
    this._forwardYOnlyProgram  = buildProgram(gl, quadVert, sh.forwardY);

    this._inverseFragTemplate  = sh.inverse;
    this._inverseYFragTemplate = sh.inverseY;

    this._inverseColorProgram  = buildProgram(gl, quadVert, buildInverseSource(sh.inverse, DEFAULT_WAVE_BODY));
    this._inverseYOnlyProgram  = buildProgram(gl, quadVert, buildInverseSource(sh.inverseY, DEFAULT_WAVE_BODY));

    this._quantizeColorProgram = buildProgram(gl, quadVert, sh.quantize);
    this._quantizeYOnlyProgram = buildProgram(gl, quadVert, sh.quantizeY);

    this._activeFwd = this._forwardColorProgram;
    this._activeInv = this._inverseColorProgram;
  }

  _createFramebuffers() {
    const gl = this.gl;
    const t = this._texType;
    this._fbBlit     = createFramebuffer(gl, this.width, this.height, t);
    this._fbColor   = createFramebuffer(gl, this.width, this.height, t);
    this._fbTemp     = createFramebuffer(gl, this.width, this.height, t);
    this._fbDCT       = createFramebuffer(gl, this.width, this.height, t);
    this._fbQuantized = createFramebuffer(gl, this.width, this.height, t);
    this._fbFinal     = createFramebuffer(gl, this.width, this.height, t);
  }

  _resizeFramebuffers() {
    const gl = this.gl;
    for (const fb of [this._fbBlit, this._fbColor, this._fbTemp, this._fbDCT, this._fbQuantized, this._fbFinal]) {
      gl.deleteFramebuffer(fb.framebuffer);
      gl.deleteTexture(fb.texture);
    }
    this._createFramebuffers();
  }
}
