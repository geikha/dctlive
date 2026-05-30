import {
  buildProgram,
  createFramebuffer,
} from './gl-utils.js';

import quadVert from './shaders/quad.vert';
import dctForwardFrag from './shaders/dct-forward.frag';
import dctForwardYFrag from './shaders/dct-forward-y.frag';
import dctInverseFrag from './shaders/dct-inverse.frag';
import dctInverseYFrag from './shaders/dct-inverse-y.frag';
import passthroughFrag from './shaders/passthrough.frag';
import blitClampFrag from './shaders/blit-clamp.frag';
import blitRepeatFrag from './shaders/blit-repeat.frag';
import blitMirrorFrag from './shaders/blit-mirror.frag';
import blitMaskFrag from './shaders/blit-mask.frag';

export const DEFAULT_WAVE_BODY = 'return cos(angle);';

export function buildInverseSource(templateSrc, waveBody) {
  const pattern = /float\s+wave\s*\(\s*float\s+angle\s*\)\s*\{[^}]*\}/;
  if (!pattern.test(templateSrc)) {
    throw new Error('DCTLive: could not locate wave(float angle) function in inverse shader');
  }
  return templateSrc.replace(pattern, `float wave(float angle) {\n  ${waveBody}\n}`);
}

export default class RenderPipeline {
  constructor(gl, width, height, texType) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this._texType = texType;
    this._yOnly = false;
    this._waveBody = DEFAULT_WAVE_BODY;

    this._passthroughProgram = buildProgram(gl, quadVert, passthroughFrag);

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

    this._forwardColorProgram = buildProgram(gl, quadVert, dctForwardFrag);
    this._forwardYOnlyProgram = buildProgram(gl, quadVert, dctForwardYFrag);

    this._inverseFragTemplate  = dctInverseFrag;
    this._inverseYFragTemplate = dctInverseYFrag;

    this._inverseColorProgram = buildProgram(gl, quadVert, dctInverseFrag);
    this._inverseYOnlyProgram = buildProgram(gl, quadVert, dctInverseYFrag);

    // H and V use the same program for float/16-bit — no per-pass encoding needed
    this._activeFwdH = this._forwardColorProgram;
    this._activeFwdV = this._forwardColorProgram;
    this._activeInvH = this._inverseColorProgram;
    this._activeInvV = this._inverseColorProgram;
  }

  setWaveFunction(glslBody) {
    const gl = this.gl;

    const colorSource = buildInverseSource(this._inverseFragTemplate, glslBody);
    const yOnlySource = buildInverseSource(this._inverseYFragTemplate, glslBody);

    gl.deleteProgram(this._inverseColorProgram);
    gl.deleteProgram(this._inverseYOnlyProgram);

    this._inverseColorProgram = buildProgram(gl, quadVert, colorSource);
    this._inverseYOnlyProgram = buildProgram(gl, quadVert, yOnlySource);

    this._activeInvH = this._yOnly ? this._inverseYOnlyProgram : this._inverseColorProgram;
    this._activeInvV = this._activeInvH;

    this._waveBody = glslBody;
  }

  resetWaveFunction() {
    this.setWaveFunction(DEFAULT_WAVE_BODY);
  }

  setYOnly(enabled) {
    this._yOnly = enabled;
    const fwd = enabled ? this._forwardYOnlyProgram : this._forwardColorProgram;
    const inv = enabled ? this._inverseYOnlyProgram : this._inverseColorProgram;
    this._activeFwdH = fwd;
    this._activeFwdV = fwd;
    this._activeInvH = inv;
    this._activeInvV = inv;
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
      rdctHorizontal,
      rdctVertical,
      resolveUniform,
    } = config;

    if (!inputTexture) return;

    const gl = this.gl;

    this._runBlit(inputTexture, uvScale, uvOffset, wrap);
    let currentTexture = this._fbInput.texture;
    const anyDCTEnabled  = dctHorizontal || dctVertical;
    const anyRDCTEnabled = rdctHorizontal || rdctVertical;

    if (anyDCTEnabled) {
      if (dctHorizontal) {
        this._renderPass(this._activeFwdH, {
          target: this._fbTempA.framebuffer,
          inputTexture: currentTexture,
          isVert: false,
          isForward: true,
        }, resolveUniform);
        currentTexture = this._fbTempA.texture;
      }

      if (dctVertical) {
        this._renderPass(this._activeFwdV, {
          target: this._fbDCT.framebuffer,
          inputTexture: currentTexture,
          isVert: true,
          isForward: true,
        }, resolveUniform);
        currentTexture = this._fbDCT.texture;
      }
    }

    if (anyRDCTEnabled) {
      if (rdctHorizontal) {
        this._renderPass(this._activeInvH, {
          target: this._fbTempB.framebuffer,
          inputTexture: currentTexture,
          isVert: false,
          isForward: false,
        }, resolveUniform);
        currentTexture = this._fbTempB.texture;
      }

      if (rdctVertical) {
        this._renderPass(this._activeInvV, {
          target: null,
          inputTexture: currentTexture,
          isVert: true,
          isForward: false,
        }, resolveUniform);
      } else {
        this._renderPass(this._activeInvV, {
          target: null,
          inputTexture: currentTexture,
          isVert: false,
          isForward: false,
        }, resolveUniform);
      }
    } else {
      this._renderPassthrough(currentTexture, null);
    }
  }

  _createFramebuffers() {
    const gl = this.gl;
    const t = this._texType;
    this._fbInput = createFramebuffer(gl, this.width, this.height, t);
    this._fbTempA = createFramebuffer(gl, this.width, this.height, t);
    this._fbDCT   = createFramebuffer(gl, this.width, this.height, t);
    this._fbTempB = createFramebuffer(gl, this.width, this.height, t);
  }

  _resizeFramebuffers() {
    const gl = this.gl;
    for (const fb of [this._fbInput, this._fbTempA, this._fbDCT, this._fbTempB]) {
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

    const posLoc = gl.getAttribLocation(prog, 'position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(gl.getUniformLocation(prog, 'resolution'), this.width, this.height);
    gl.uniform2fv(gl.getUniformLocation(prog, 'uvScale'), uvScale);
    gl.uniform2fv(gl.getUniformLocation(prog, 'uvOffset'), uvOffset);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rawTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'inputTexture'), 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _renderPass(program, { target, inputTexture, isVert, isForward }, resolveUniform) {
    const gl = this.gl;

    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const posLoc = gl.getAttribLocation(program, 'position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(gl.getUniformLocation(program, 'resolution'), this.width, this.height);
    gl.uniform1i(gl.getUniformLocation(program, 'isVert'), isVert ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'blockSize'), resolveUniform('blockSize'));
    gl.uniform1f(gl.getUniformLocation(program, 'lpf'), resolveUniform('lpf'));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'inputTexture'), 0);

    if (isForward) {
      gl.uniform1f(gl.getUniformLocation(program, 'highFreqMultiplier'), resolveUniform('highFreqMultiplier'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeY'),  resolveUniform('quantizeY'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeYf'), resolveUniform('quantizeYf'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeC'),  resolveUniform('quantizeC'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeCf'), resolveUniform('quantizeCf'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeA'),  resolveUniform('quantizeA'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeAf'), resolveUniform('quantizeAf'));
    } else {
      gl.uniform1f(gl.getUniformLocation(program, 'time'), performance.now());
      gl.uniform1f(gl.getUniformLocation(program, 'wi'), resolveUniform('waveInput'));
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _renderPassthrough(inputTexture, target) {
    const gl = this.gl;

    gl.useProgram(this._passthroughProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const posLoc = gl.getAttribLocation(this._passthroughProgram, 'position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(gl.getUniformLocation(this._passthroughProgram, 'resolution'), this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform1i(gl.getUniformLocation(this._passthroughProgram, 'inputTexture'), 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy() {
    const gl = this.gl;

    gl.deleteProgram(this._forwardColorProgram);
    gl.deleteProgram(this._forwardYOnlyProgram);
    gl.deleteProgram(this._inverseColorProgram);
    gl.deleteProgram(this._inverseYOnlyProgram);
    gl.deleteProgram(this._passthroughProgram);

    for (const prog of Object.values(this._blitPrograms)) gl.deleteProgram(prog);
    gl.deleteBuffer(this._quadBuffer);

    for (const fb of [this._fbInput, this._fbTempA, this._fbDCT, this._fbTempB]) {
      gl.deleteFramebuffer(fb.framebuffer);
      gl.deleteTexture(fb.texture);
    }
  }
}
