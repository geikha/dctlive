import {
  buildProgram,
  createFramebuffer,
} from './gl-utils.js';

import { DEFAULT_WAVE_BODY } from './shader-providers.js';

// Keep as exported alias for any external callers.
export { DEFAULT_WAVE_BODY };
export function buildInverseSource(src, body) {
  return src.replace(/#define DCTLIVE_WAVE_BODY [^\n]*/, `#define DCTLIVE_WAVE_BODY ${body}`);
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

    this._quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this._buildStaticPrograms();
    this._buildPipelinePrograms();
    this._buildInversePrograms();
    this._createFramebuffers();
  }

  destroy() {
    const gl = this.gl;
    this._deleteStaticPrograms();
    this._deletePipelinePrograms();
    this._deleteInversePrograms();
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
    this._deletePipelinePrograms();
    this._deleteInversePrograms();
    this._buildPipelinePrograms();
    this._buildInversePrograms();
  }

  setWaveFunction(glslBody) {
    const normalized = glslBody.trim().replace(/\s+/g, ' ');
    this._waveBody = normalized;
    this.shaderProvider.waveBody = normalized;
    this._deleteInversePrograms();
    this._buildInversePrograms();
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
      this._renderQuantize(inputTex, uniforms);
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
    const prog = this._staticPrograms.blit[wrap] || this._staticPrograms.blit.mask;
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
      program:  this._pipelinePrograms.colorIn,
      target:   this._fbColor.framebuffer,
      uniforms: { resolution: this._res },
      textures: { inputTexture },
    });
  }

  _renderForwardDCTHorizontal(inputTex, uniforms) {
    this._executePass({
      program:  this._pipelinePrograms.fwdH,
      target:   this._fbTemp.framebuffer,
      uniforms: {
        resolution: this._res,
        lpf:       { type: 'float', value: uniforms.lpf },
        blockSize: { type: 'int',   value: uniforms.blockSize },
      },
      textures: { inputTexture: inputTex },
    });
  }

  _renderForwardDCTVertical(inputTex, uniforms) {
    this._executePass({
      program:  this._pipelinePrograms.fwdV,
      target:   this._fbDCT.framebuffer,
      uniforms: {
        resolution: this._res,
        lpf:       { type: 'float', value: uniforms.lpf },
        blockSize: { type: 'int',   value: uniforms.blockSize },
      },
      textures: { inputTexture: inputTex },
    });
  }

  _renderQuantize(inputTexture, uniforms) {
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
    this._executePass({ program: this._pipelinePrograms.quantize, target: this._fbQuantized.framebuffer, uniforms: passUniforms, textures: { inputTexture } });
  }

  _renderInverseDCTHorizontal(inputTex, uniforms) {
    this._executePass({
      program:  this._inversePrograms.invH,
      target:   this._fbTemp.framebuffer,
      uniforms: {
        resolution: this._res,
        lpf:       { type: 'float', value: uniforms.lpf },
        blockSize: { type: 'int',   value: uniforms.blockSize },
        time:      { type: 'float', value: performance.now() / 1000.0 },
        wi:        { type: 'float', value: uniforms.waveInput },
      },
      textures: { inputTexture: inputTex },
    });
  }

  _renderInverseDCTVertical(inputTex, uniforms) {
    this._executePass({
      program:  this._inversePrograms.invV,
      target:   this._fbFinal.framebuffer,
      uniforms: {
        resolution: this._res,
        lpf:       { type: 'float', value: uniforms.lpf },
        blockSize: { type: 'int',   value: uniforms.blockSize },
        time:      { type: 'float', value: performance.now() / 1000.0 },
        wi:        { type: 'float', value: uniforms.waveInput },
      },
      textures: { inputTexture: inputTex },
    });
  }

  _renderColorOut(inputTexture, flipViewport = false) {
    const prog = flipViewport ? this._pipelinePrograms.colorOutFlipY : this._pipelinePrograms.colorOut;
    this._executePass({
      program:  prog,
      target:   null,
      uniforms: { resolution: this._res },
      textures: { inputTexture },
    });
  }

  _renderPassthrough(inputTexture, target, flipViewport = false) {
    const prog = flipViewport ? this._staticPrograms.passthroughFlipY : this._staticPrograms.passthrough;
    this._executePass({
      program:  prog,
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
      if (!prog) continue;
      this.gl.deleteProgram(prog);
      this._uniformCache.delete(prog);
      this._attribCache.delete(prog);
    }
  }

  _buildStaticPrograms() {
    const sh = this.shaderProvider;
    this._staticPrograms = {
      blit: Object.fromEntries(
        Object.entries(sh.blit).map(([k, v]) => [k, buildProgram(this.gl, sh.vert, v)])
      ),
      passthrough:      buildProgram(this.gl, sh.vert, sh.passthrough),
      passthroughFlipY: buildProgram(this.gl, sh.vert, sh.passthroughFlipY),
    };
  }

  _buildPipelinePrograms() {
    const sh = this.shaderProvider;
    this._pipelinePrograms = {
      colorIn:       buildProgram(this.gl, sh.vert, sh.colorIn),
      colorOut:      buildProgram(this.gl, sh.vert, sh.colorOut),
      colorOutFlipY: buildProgram(this.gl, sh.vert, sh.colorOutFlipY),
      fwdH:          buildProgram(this.gl, sh.vert, sh.forwardH),
      fwdV:          buildProgram(this.gl, sh.vert, sh.forwardV),
      quantize:      buildProgram(this.gl, sh.vert, sh.quantize),
    };
  }

  _buildInversePrograms() {
    const sh = this.shaderProvider;
    this._inversePrograms = {
      invH: buildProgram(this.gl, sh.vert, sh.inverseH),
      invV: buildProgram(this.gl, sh.vert, sh.inverseV),
    };
  }

  _deleteStaticPrograms() {
    if (!this._staticPrograms) return;
    for (const prog of Object.values(this._staticPrograms.blit)) this._deletePrograms(prog);
    this._deletePrograms(this._staticPrograms.passthrough, this._staticPrograms.passthroughFlipY);
    this._staticPrograms = null;
  }

  _deletePipelinePrograms() {
    if (!this._pipelinePrograms) return;
    this._deletePrograms(...Object.values(this._pipelinePrograms));
    this._pipelinePrograms = null;
  }

  _deleteInversePrograms() {
    if (!this._inversePrograms) return;
    this._deletePrograms(this._inversePrograms.invH, this._inversePrograms.invV);
    this._inversePrograms = null;
  }

  _createFramebuffers() {
    const gl = this.gl;
    const t = this._texType;
    this._fbBlit      = createFramebuffer(gl, this.width, this.height, t);
    this._fbColor     = createFramebuffer(gl, this.width, this.height, t);
    this._fbTemp      = createFramebuffer(gl, this.width, this.height, t);
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
