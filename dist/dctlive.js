var DCTLiveModule = (function (exports) {
  'use strict';

  const FILTER_MAP = {
    linear: 'LINEAR',
    nearest: 'NEAREST',
  };

  const FIT_MODES = ['stretch', 'fill', 'fit'];
  const WRAP_MODES = ['clamp', 'repeat', 'mirror', 'mask'];

  class InputSource {
    constructor(gl, targetWidth, targetHeight) {
      this.gl = gl;
      this.targetWidth = targetWidth;
      this.targetHeight = targetHeight;

      this.texture = null;

      this._minFilter = 'linear';
      this._magFilter = 'linear';
      this._wrap = 'mask';
      this._fit = 'stretch';
      this._flipY = false;  // false: flip texture on load (standard orientation), true: no flip on load

      this._source = null;
      this._isDynamic = false;
      this._sourceWidth = 0;
      this._sourceHeight = 0;

      // Cached UV transform — recomputed only when source/fit/resolution changes
      this._uvScale = [1, 1];
      this._uvOffset = [0, 0];
    }

    setTargetSize(width, height) {
      this.targetWidth = Math.max(1, Math.floor(width));
      this.targetHeight = Math.max(1, Math.floor(height));
      this._updateUVTransform();
    }

    // ---- Setters ----

    set filter(mode) {
      this._minFilter = mode;
      this._magFilter = mode;
      this._applyTexParams();
    }

    set minFilter(mode) {
      this._minFilter = mode;
      this._applyTexParams();
    }
    get minFilter() { return this._minFilter; }

    set magFilter(mode) {
      this._magFilter = mode;
      this._applyTexParams();
    }
    get magFilter() { return this._magFilter; }

    set wrap(mode) {
      if (!WRAP_MODES.includes(mode)) {
        console.warn(`InputSource: unknown wrap mode "${mode}"`);
        return;
      }
      this._wrap = mode;
    }
    get wrap() { return this._wrap; }

    set fit(mode) {
      if (!FIT_MODES.includes(mode)) {
        console.warn(`InputSource: unknown fit mode "${mode}"`);
        return;
      }
      this._fit = mode;
      this._updateUVTransform();
    }
    get fit() { return this._fit; }

    set flipY(val) {
      this._flipY = !!val;
    }
    get flipY() { return this._flipY; }

    // Read-only cached UV transform
    get uvScale() { return this._uvScale; }
    get uvOffset() { return this._uvOffset; }

    // Only 'fit' can produce out-of-bounds UVs; stretch/fill always stay in [0,1]
    get effectiveWrap() { return this._fit === 'fit' ? this._wrap : 'clamp'; }

    setOptions(opts = {}) {
      if (opts.minFilter) this._minFilter = opts.minFilter;
      if (opts.magFilter) this._magFilter = opts.magFilter;
      if (opts.wrap && WRAP_MODES.includes(opts.wrap)) this._wrap = opts.wrap;
      if (opts.fit && FIT_MODES.includes(opts.fit)) {
        this._fit = opts.fit;
      }
      this._applyTexParams();
      if (opts.fit) this._updateUVTransform();
    }

    // ---- Source loaders ----

    loadImage(url, opts = {}) {
      if (opts) this.setOptions(opts);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          this._setSource(img, false);
          resolve();
        };
        img.onerror = () => reject(new Error('Failed to load image: ' + url));
        img.src = url;
      });
    }

    setImage(img, opts = {}) {
      if (opts) this.setOptions(opts);
      this._setSource(img, false);
    }

    setVideo(video, opts = {}) {
      if (opts) this.setOptions(opts);
      this._setSource(video, true);
    }

    setCanvas(canvas, opts = {}) {
      if (opts) this.setOptions(opts);
      this._setSource(canvas, true);
    }

    // ---- Frame update ----

    update() {
      if (!this._source || !this.texture) return;
      if (this._isDynamic) {
        this._uploadTexture();
      }
    }

    // ---- Internal ----

    _setSource(source, isDynamic) {
      this._source = source;
      this._isDynamic = isDynamic;

      const sw = source.videoWidth || source.naturalWidth || source.width;
      const sh = source.videoHeight || source.naturalHeight || source.height;
      this._sourceWidth = sw;
      this._sourceHeight = sh;

      if (!this.texture) {
        this.texture = this.gl.createTexture();
      }

      this._uploadTexture();
      this._applyTexParams();
      this._updateUVTransform();
    }

    _uploadTexture() {
      const gl = this.gl;
      const source = this._source;
      if (!source) return;

      // For video, skip if not ready
      const sw = source.videoWidth || source.naturalWidth || source.width;
      const sh = source.videoHeight || source.naturalHeight || source.height;
      if (!sw || !sh) return;

      // Update stored dimensions in case video size became available
      if (sw !== this._sourceWidth || sh !== this._sourceHeight) {
        this._sourceWidth = sw;
        this._sourceHeight = sh;
        this._updateUVTransform();
      }

      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      // flipY=false (default): flip on load (standard image orientation)
      // flipY=true: don't flip on load (WebGL bottom-left origin)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY ? 1 : 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    _applyTexParams() {
      if (!this.texture) return;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl[FILTER_MAP[this._minFilter]] || gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl[FILTER_MAP[this._magFilter]] || gl.LINEAR);
      // Always clamp — blit shaders handle wrap modes themselves (NPOT-safe)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    _updateUVTransform() {
      const sw = this._sourceWidth;
      const sh = this._sourceHeight;
      const tw = this.targetWidth;
      const th = this.targetHeight;

      if (!sw || !sh) {
        this._uvScale = [1, 1];
        this._uvOffset = [0, 0];
        return;
      }

      const srcAspect = sw / sh;
      const tgtAspect = tw / th;

      if (this._fit === 'stretch') {
        this._uvScale = [1, 1];
        this._uvOffset = [0, 0];
        return;
      }

      let sx, sy;

      if (this._fit === 'fit') {
        if (srcAspect > tgtAspect) {
          // Wider source: letterbox top/bottom
          sy = srcAspect / tgtAspect;
          this._uvScale = [1, sy];
          this._uvOffset = [0, -(sy - 1) / 2];
        } else {
          // Taller source: pillarbox left/right
          sx = tgtAspect / srcAspect;
          this._uvScale = [sx, 1];
          this._uvOffset = [-(sx - 1) / 2, 0];
        }
      } else if (this._fit === 'fill') {
        if (srcAspect > tgtAspect) {
          // Wider source: crop sides
          sx = tgtAspect / srcAspect;
          this._uvScale = [sx, 1];
          this._uvOffset = [(1 - sx) / 2, 0];
        } else {
          // Taller source: crop top/bottom
          sy = srcAspect / tgtAspect;
          this._uvScale = [1, sy];
          this._uvOffset = [0, (1 - sy) / 2];
        }
      }
    }

    destroy() {
      if (this.texture) {
        this.gl.deleteTexture(this.texture);
        this.texture = null;
      }
      this._source = null;
    }
  }

  /**
   * WebGL helper utilities for DCTLive.
   * Handles shader compilation, program linking, framebuffer creation,
   * and uniform/attribute helpers.
   */

  /**
   * Compile a WebGL shader from source.
   * @param {WebGLRenderingContext} gl
   * @param {number} type - gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
   * @param {string} source
   * @returns {WebGLShader}
   */
  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile error:\n' + info);
    }
    return shader;
  }

  /**
   * Link a vertex and fragment shader into a program.
   * @param {WebGLRenderingContext} gl
   * @param {WebGLShader} vert
   * @param {WebGLShader} frag
   * @returns {WebGLProgram}
   */
  function createProgram(gl, vert, frag) {
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('Program link error:\n' + info);
    }
    return program;
  }

  /**
   * Build a complete shader program from source strings.
   * @param {WebGLRenderingContext} gl
   * @param {string} vertSrc
   * @param {string} fragSrc
   * @returns {WebGLProgram}
   */
  function buildProgram(gl, vertSrc, fragSrc) {
    const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    return createProgram(gl, vert, frag);
  }

  /**
   * Build a program with preprocessor defines injected into the fragment shader.
   * @param {WebGLRenderingContext} gl
   * @param {string} vertSrc
   * @param {string} fragSrc
   * @param {Object} defines - e.g. { COLOR_ENABLED: 1, SOME_FLAG: 0 }
   * @returns {WebGLProgram}
   */
  function buildProgramWithDefines(gl, vertSrc, fragSrc, defines) {
    // Inject #define statements at the beginning of fragment shader
    let defineStr = '';
    for (const [key, value] of Object.entries(defines)) {
      defineStr += `#define ${key} ${value}\n`;
    }
    const fragWithDefines = defineStr + fragSrc;

    const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragWithDefines);
    return createProgram(gl, vert, frag);
  }

  /**
   * Create a framebuffer with the given texture type.
   * @param {WebGLRenderingContext} gl
   * @param {number} width
   * @param {number} height
   * @param {number} texType - gl.FLOAT, HALF_FLOAT_OES, or gl.UNSIGNED_BYTE
   * @returns {{ framebuffer: WebGLFramebuffer, texture: WebGLTexture }}
   */
  function createFramebuffer(gl, width, height, texType) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, texType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { framebuffer, texture };
  }

  /**
   * Resolve the best available texture type for the requested precision.
   * Fallback chain: '32bit' → float → half-float → UNSIGNED_BYTE
   *                 '16bit' → half-float → UNSIGNED_BYTE
   *                 '8bit'  → UNSIGNED_BYTE (always)
   * @param {WebGLRenderingContext} gl
   * @param {'32bit'|'16bit'|'8bit'} [requested='16bit']
   * @returns {{ type: number, actual: '32bit'|'16bit'|'8bit' }}
   */
  function resolveTexType(gl, requested = '16bit') {
    if (requested !== '8bit') {
      if (requested === '32bit') {
        const extFloat = gl.getExtension('OES_texture_float');
        if (extFloat) {
          gl.getExtension('OES_texture_float_linear');
          return { type: gl.FLOAT, actual: '32bit' };
        }
      }
      const extHalf = gl.getExtension('OES_texture_half_float');
      if (extHalf) {
        gl.getExtension('OES_texture_half_float_linear');
        return { type: extHalf.HALF_FLOAT_OES, actual: '16bit' };
      }
    }
    if (requested !== '8bit') {
      console.warn('DCTLive: float/half-float textures unavailable, falling back to 8-bit precision');
    }
    return { type: gl.UNSIGNED_BYTE, actual: '8bit' };
  }

  var quadVert = "attribute vec2 position;\r\n\r\nvoid main() {\r\n  gl_Position = vec4(position, 0.0, 1.0);\r\n}\r\n";

  var dctForwardBaseFrag = "/*\n  Forward DCT shader (unified color and Y-only)\n  Computes 1D DCT along one axis (horizontal or vertical).\n  Run twice (horizontal then vertical) for full 2D DCT.\n\n  COLOR_ENABLED define (set at compile time):\n  - 1: color mode (RGB→YCbCr, vec3 accumulation, faster quantization)\n  - 0: Y-only mode (luminance extraction, float accumulation, cheaper inner loop)\n*/\n\n#pragma glslify: rgb2ycbcr = require('./modules/color-conversion.glsl')\n#pragma glslify: extractLuminance = require('./modules/color-extraction.glsl')\n\n#define PI 3.14159265\n\nprecision highp float;\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nuniform float highFreqMultiplier;\n\nvoid main() {\n  // Direction vector: (1,0) for horizontal, (0,1) for vertical\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n\n  // Block dimensions in pixel space along the processing axis\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n\n  // Origin of the current block (pixel coords, center-sampled)\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\n\n  // Actual block size (may be smaller at image edges)\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n\n  // Which frequency coefficient are we computing?\n  float freq = floor(mod(dot(bv, gl_FragCoord.xy), float(blockSize))) / float(bs) * PI;\n\n  // DCT normalization factor: 1/N for DC, 2/N for AC\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\n\n  // Accumulate the DCT sum\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (bs <= i) break;\n\n    // Offset within block to sample i-th pixel\n    vec2 delta = float(i) * bv;\n\n    // DCT basis function: cos((x + 0.5) * freq)\n    float wave = cos((float(i) + 0.5) * freq);\n\n    // Convert pixel coords to UV\n    vec2 uv = (blockOrigin + delta) / resolution;\n\n    vec4 val = texture2D(inputTexture, uv);\n\n    // Process color or luminance on first (horizontal) pass\n    #if COLOR_ENABLED == 1\n      // Color mode: convert to YCbCr (vec3 accumulation)\n      if (!isVert) {\n        val.rgb = rgb2ycbcr(val.rgb);\n      }\n    #else\n      // Y-only mode: extract luminance only (float accumulation)\n      if (!isVert) {\n        val.x = extractLuminance(val);\n        val.yz = vec2(0.0);\n      }\n    #endif\n\n    sum += wave * factor * val;\n  }\n\n  // High frequency boost/cut (after vertical pass = full 2D DCT done)\n  if (isVert) {\n    float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n    sum *= 1.0 + len * highFreqMultiplier;\n  }\n\n  gl_FragColor = sum;\n}\n";

  var dctInverseBaseFrag = "/*\n  Inverse DCT shader (unified color and Y-only)\n  Reconstructs spatial image from DCT coefficients.\n  Run twice (horizontal then vertical) for full 2D IDCT.\n\n  COLOR_ENABLED define (set at compile time):\n  - 1: color mode (YCbCr→RGB conversion on final pass)\n  - 0: Y-only mode (luminance broadcasted to RGB)\n*/\n\n#pragma glslify: ycbcr2rgb = require('./modules/color-conversion.glsl')\n\n#define PI 3.14159265\n#define PI2 6.28318530\n#define hPI 1.57079632\n\nprecision highp float;\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nbool validuv(vec2 v) {\n  return 0.0 < v.x && v.x < 1.0 && 0.0 < v.y && v.y < 1.0;\n}\n\n// Waveform function (replaceable via JS API)\n// Parameters: angle (phase angle), time (current time in ms), wi (wave input parameter)\nfloat wave(float angle) {\n  return cos(angle);\n}\n\nvoid main() {\n  // Direction vector\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n\n  // Block dimensions\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(bs), lpf));\n\n  // Spatial position within block (which pixel are we reconstructing?)\n  float delta = mod(dot(bv, gl_FragCoord.xy), float(blockSize));\n\n  // Accumulate IDCT sum\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (loopLimit <= i) break;\n\n    float fdelta = float(i);\n\n    // Read DCT coefficient for frequency i\n    vec4 val = texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution);\n\n    // IDCT basis function\n    float awave = wave(delta * fdelta / float(bs) * PI);\n\n    sum += awave * val;\n  }\n\n  // On final (vertical) pass, handle color conversion or Y-broadcast\n  if (isVert) {\n    #if COLOR_ENABLED == 1\n      // Color mode: convert YCbCr back to RGB\n      sum.rgb = ycbcr2rgb(sum.rgb);\n    #else\n      // Y-only mode: broadcast luminance to RGB\n      sum = vec4(sum.x, sum.x, sum.x, sum.w);\n    #endif\n  }\n\n  gl_FragColor = sum;\n}\n";

  var dctQuantizeFrag = "/*\n  Quantization shader - applies lofi quantization to DCT coefficients\n  Input: raw DCT coefficients (from Forward H or V pass)\n  Output: quantized coefficients ready for inverse\n  Runs between forward and inverse when any DCT pass is enabled\n*/\n\n#pragma glslify: quantize = require('./modules/quantization.glsl')\n\nprecision highp float;\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nuniform float quantizeY;\nuniform float quantizeYf;\nuniform float quantizeC;\nuniform float quantizeCf;\nuniform float quantizeA;\nuniform float quantizeAf;\nuniform bool isColorMode;\n\nvoid main() {\n  // Read DCT coefficient at this fragment\n  vec4 coeff = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n\n  // Distance from DC component within block (frequency magnitude)\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n\n  // Quantize luminance (Y) - always present\n  float qY = quantizeY + quantizeYf * len;\n  coeff.x = qY > 0.0 ? quantize(coeff.x, qY) : coeff.x;\n\n  // Quantize chrominance (Cb, Cr) and alpha in color mode\n  if (isColorMode) {\n    float qC = quantizeC + quantizeCf * len;\n    coeff.y = qC > 0.0 ? quantize(coeff.y, qC) : coeff.y;\n    coeff.z = qC > 0.0 ? quantize(coeff.z, qC) : coeff.z;\n\n    float qA = quantizeA + quantizeAf * len;\n    coeff.w = qA > 0.0 ? quantize(coeff.w, qA) : coeff.w;\n  }\n\n  gl_FragColor = coeff;\n}\n";

  var passthroughFrag = "precision highp float;\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, uv);\n}\n";

  var blitClampFrag = "precision highp float;\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, uv * uvScale + uvOffset);\n}\n";

  var blitRepeatFrag = "precision highp float;\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, fract(uv * uvScale + uvOffset));\n}\n";

  var blitMirrorFrag = "precision highp float;\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  uv = uv * uvScale + uvOffset;\n  vec2 t = fract(uv * 0.5) * 2.0;\n  uv = 1.0 - abs(t - 1.0);\n  gl_FragColor = texture2D(inputTexture, uv);\n}\n";

  var blitMaskFrag = "precision highp float;\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  uv = uv * uvScale + uvOffset;\n  vec2 inBounds = step(vec2(0.0), uv) * step(uv, vec2(1.0));\n  float mask = inBounds.x * inBounds.y;\n  gl_FragColor = texture2D(inputTexture, uv) * mask;\n}\n";

  const DEFAULT_WAVE_BODY = 'return cos(angle);';

  function buildInverseSource(templateSrc, waveBody) {
    const pattern = /float\s+wave\s*\(\s*float\s+angle\s*\)\s*\{[^}]*\}/;
    if (!pattern.test(templateSrc)) {
      throw new Error('DCTLive: could not locate wave(float angle) function in inverse shader');
    }
    return templateSrc.replace(pattern, `float wave(float angle) {\n  ${waveBody}\n}`);
  }

  class RenderPipeline {
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

      // Compile base shaders with COLOR_ENABLED define
      this._forwardColorProgram = buildProgramWithDefines(gl, quadVert, dctForwardBaseFrag, { COLOR_ENABLED: 1 });
      this._forwardYOnlyProgram = buildProgramWithDefines(gl, quadVert, dctForwardBaseFrag, { COLOR_ENABLED: 0 });

      this._inverseFragTemplate  = dctInverseBaseFrag;
      this._inverseYFragTemplate = dctInverseBaseFrag;

      this._inverseColorProgram = buildProgramWithDefines(gl, quadVert, dctInverseBaseFrag, { COLOR_ENABLED: 1 });
      this._inverseYOnlyProgram = buildProgramWithDefines(gl, quadVert, dctInverseBaseFrag, { COLOR_ENABLED: 0 });

      // Quantization pass programs (color and Y-only variants)
      this._quantizeColorProgram = buildProgramWithDefines(gl, quadVert, dctQuantizeFrag, { isColorMode: 1 });
      this._quantizeYOnlyProgram = buildProgramWithDefines(gl, quadVert, dctQuantizeFrag, { isColorMode: 0 });

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

      this._inverseColorProgram = buildProgramWithDefines(gl, quadVert, colorSource, { COLOR_ENABLED: 1 });
      this._inverseYOnlyProgram = buildProgramWithDefines(gl, quadVert, yOnlySource, { COLOR_ENABLED: 0 });

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

      this.gl;

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

        // Apply quantization pass after forward DCT
        const quantizeProgram = this._yOnly ? this._quantizeYOnlyProgram : this._quantizeColorProgram;
        this._renderQuantize(quantizeProgram, currentTexture, resolveUniform);
        currentTexture = this._fbQuantized.texture;
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
      this._fbQuantized = createFramebuffer(gl, this.width, this.height, t);
      this._fbTempB = createFramebuffer(gl, this.width, this.height, t);
    }

    _resizeFramebuffers() {
      const gl = this.gl;
      for (const fb of [this._fbInput, this._fbTempA, this._fbDCT, this._fbQuantized, this._fbTempB]) {
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
      } else {
        gl.uniform1f(gl.getUniformLocation(program, 'time'), performance.now());
        gl.uniform1f(gl.getUniformLocation(program, 'wi'), resolveUniform('waveInput'));
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _renderQuantize(program, inputTexture, resolveUniform) {
      const gl = this.gl;

      gl.useProgram(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbQuantized.framebuffer);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const posLoc = gl.getAttribLocation(program, 'position');
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(gl.getUniformLocation(program, 'resolution'), this.width, this.height);
      gl.uniform1i(gl.getUniformLocation(program, 'blockSize'), resolveUniform('blockSize'));

      // Quantization uniforms
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeY'),  resolveUniform('quantizeY'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeYf'), resolveUniform('quantizeYf'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeC'),  resolveUniform('quantizeC'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeCf'), resolveUniform('quantizeCf'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeA'),  resolveUniform('quantizeA'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeAf'), resolveUniform('quantizeAf'));

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'inputTexture'), 0);

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
      gl.deleteProgram(this._quantizeColorProgram);
      gl.deleteProgram(this._quantizeYOnlyProgram);
      gl.deleteProgram(this._passthroughProgram);

      for (const prog of Object.values(this._blitPrograms)) gl.deleteProgram(prog);
      gl.deleteBuffer(this._quadBuffer);

      for (const fb of [this._fbInput, this._fbTempA, this._fbDCT, this._fbQuantized, this._fbTempB]) {
        gl.deleteFramebuffer(fb.framebuffer);
        gl.deleteTexture(fb.texture);
      }
    }
  }

  var dctForwardFrag = "/*\r\n  Forward DCT shader (jpeg-cosine)\r\n  Computes 1D DCT along one axis (horizontal or vertical).\r\n  Run twice (horizontal then vertical) for full 2D DCT.\r\n*/\r\n\r\n#define lofi(i,j) floor((i)/(j)+.5)*(j)\r\n#define PI 3.14159265\r\n\r\nprecision highp float;\r\n\r\nuniform vec2 resolution;\r\nuniform bool isVert;\r\nuniform int blockSize;\r\nuniform sampler2D inputTexture;\r\n\r\nuniform float highFreqMultiplier;\r\nuniform float quantizeY;\r\nuniform float quantizeYf;\r\nuniform float quantizeC;\r\nuniform float quantizeCf;\r\nuniform float quantizeA;\r\nuniform float quantizeAf;\r\n\r\n// RGB to YCbCr conversion\r\nvec3 rgb2ycbcr(vec3 rgb) {\r\n  return vec3(\r\n     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,\r\n    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,\r\n     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b\r\n  );\r\n}\r\n\r\nvoid main() {\r\n  // Direction vector: (1,0) for horizontal, (0,1) for vertical\r\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\r\n\r\n  // Block dimensions in pixel space along the processing axis\r\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\r\n\r\n  // Origin of the current block (pixel coords, center-sampled)\r\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\r\n\r\n  // Actual block size (may be smaller at image edges)\r\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\r\n\r\n  // Which frequency coefficient are we computing?\r\n  // Position within block maps directly to frequency index\r\n  float freq = floor(mod(dot(bv, gl_FragCoord.xy), float(blockSize))) / float(bs) * PI;\r\n\r\n  // DCT normalization factor: 1/N for DC, 2/N for AC\r\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\r\n\r\n  // Accumulate the DCT sum (always use full block for correct coefficients)\r\n  vec4 sum = vec4(0.0);\r\n  for (int i = 0; i < 1024; i++) {\r\n    if (bs <= i) break;\r\n\r\n    // Offset within block to sample i-th pixel\r\n    vec2 delta = float(i) * bv;\r\n\r\n    // DCT basis function: cos((x + 0.5) * freq)\r\n    float wave = cos((float(i) + 0.5) * freq);\r\n\r\n    // Convert pixel coords to UV\r\n    vec2 uv = (blockOrigin + delta) / resolution;\r\n\r\n    // Flip Y on horizontal pass (WebGL texture coords vs image coords)\r\n    if (!isVert) {\r\n      uv = vec2(0.0, 1.0) + vec2(1.0, -1.0) * uv;\r\n    }\r\n\r\n    vec4 val = texture2D(inputTexture, uv);\r\n\r\n    // Convert RGB -> YCbCr on first (horizontal) pass\r\n    if (!isVert) {\r\n      val.rgb = rgb2ycbcr(val.rgb);\r\n    }\r\n\r\n    sum += wave * factor * val;\r\n  }\r\n\r\n  // Quantization (only after vertical pass = full 2D DCT done)\r\n  if (isVert) {\r\n    // Distance from DC component within block (frequency magnitude)\r\n    float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\r\n\r\n    // Quantize luminance (Y)\r\n    float qY = quantizeY + quantizeYf * len;\r\n    sum.x = qY > 0.0 ? lofi(sum.x, qY) : sum.x;\r\n\r\n    // Quantize chrominance (Cb, Cr)\r\n    float qC = quantizeC + quantizeCf * len;\r\n    sum.yz = qC > 0.0 ? lofi(sum.yz, qC) : sum.yz;\r\n\r\n    // Quantize alpha\r\n    float qA = quantizeA + quantizeAf * len;\r\n    sum.w = qA > 0.0 ? lofi(sum.w, qA) : sum.w;\r\n\r\n    // High frequency boost/cut\r\n    sum *= 1.0 + len * highFreqMultiplier;\r\n  }\r\n\r\n  gl_FragColor = sum;\r\n}\r\n";

  var dctForwardYFrag = "/*\n  Forward DCT shader - Y-only mode (grayscale)\n  Computes 1D DCT along one axis, luminance channel only.\n  Run twice (horizontal then vertical) for full 2D DCT.\n*/\n\n#define lofi(i,j) floor((i)/(j)+.5)*(j)\n#define PI 3.14159265\n\nprecision highp float;\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\n\nvoid main() {\n  // Direction vector: (1,0) for horizontal, (0,1) for vertical\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n\n  // Block dimensions in pixel space along the processing axis\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n\n  // Origin of the current block (pixel coords, center-sampled)\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\n\n  // Actual block size (may be smaller at image edges)\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n\n  // Which frequency coefficient are we computing?\n  float freq = floor(mod(dot(bv, gl_FragCoord.xy), float(blockSize))) / float(bs) * PI;\n\n  // DCT normalization factor: 1/N for DC, 2/N for AC\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\n\n  // Accumulate the DCT sum\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (bs <= i) break;\n\n    // Offset within block to sample i-th pixel\n    vec2 delta = float(i) * bv;\n\n    // DCT basis function: cos((x + 0.5) * freq)\n    float wave = cos((float(i) + 0.5) * freq);\n\n    // Convert pixel coords to UV\n    vec2 uv = (blockOrigin + delta) / resolution;\n\n    // Flip Y on horizontal pass (WebGL texture coords vs image coords)\n    if (!isVert) {\n      uv = vec2(0.0, 1.0) + vec2(1.0, -1.0) * uv;\n    }\n\n    vec4 val = texture2D(inputTexture, uv);\n\n    // Extract luminance on first (horizontal) pass\n    if (!isVert) {\n      val.x = dot(val.rgb, vec3(0.299, 0.587, 0.114));\n      val.yz = vec2(0.0);\n    }\n\n    sum += wave * factor * val;\n  }\n\n  // Quantization (only after vertical pass = full 2D DCT done)\n  if (isVert) {\n    // Distance from DC component within block (frequency magnitude)\n    float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n\n    // Quantize luminance (Y)\n    float qY = quantizeY + quantizeYf * len;\n    sum.x = qY > 0.0 ? lofi(sum.x, qY) : sum.x;\n\n    // High frequency boost/cut\n    sum *= 1.0 + len * highFreqMultiplier;\n  }\n\n  gl_FragColor = sum;\n}\n";

  var dctInverseFrag = "/*\r\n  Inverse DCT shader (jpeg-render)\r\n  Reconstructs spatial image from DCT coefficients.\r\n  Run twice (horizontal then vertical) for full 2D IDCT.\r\n*/\r\n\r\n#define PI 3.14159265\r\n#define PI2 6.28318530\r\n#define hPI 1.57079632\r\n\r\nprecision highp float;\r\n\r\nuniform vec2 resolution;\r\nuniform bool isVert;\r\nuniform int blockSize;\r\nuniform sampler2D inputTexture;\r\nuniform float lpf;\r\nuniform float time;\r\nuniform float wi;\r\n\r\nbool validuv(vec2 v) {\r\n  return 0.0 < v.x && v.x < 1.0 && 0.0 < v.y && v.y < 1.0;\r\n}\r\n\r\n// YCbCr to RGB conversion\r\nvec3 ycbcr2rgb(vec3 yuv) {\r\n  return vec3(\r\n    yuv.x + 1.402    * yuv.z,\r\n    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,\r\n    yuv.x + 1.772    * yuv.y\r\n  );\r\n}\r\n\r\n// Waveform function (replaceable via JS API)\r\n// Parameters: angle (phase angle), time (current time in ms), wi (wave input parameter)\r\nfloat wave(float angle) {\r\n  return cos(angle);\r\n}\r\n\r\nvoid main() {\r\n  // Direction vector\r\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\r\n\r\n  // Block dimensions\r\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\r\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\r\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\r\n  int loopLimit = int(min(float(bs), lpf));\r\n\r\n  // Spatial position within block (which pixel are we reconstructing?)\r\n  float delta = mod(dot(bv, gl_FragCoord.xy), float(blockSize));\r\n\r\n  // Accumulate IDCT sum\r\n  vec4 sum = vec4(0.0);\r\n  for (int i = 0; i < 1024; i++) {\r\n    if (loopLimit <= i) break;\r\n\r\n    float fdelta = float(i);\r\n\r\n    // Read DCT coefficient for frequency i\r\n    vec4 val = texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution);\r\n\r\n    // IDCT basis function\r\n    float awave = wave(delta * fdelta / float(bs) * PI);\r\n\r\n    sum += awave * val;\r\n  }\r\n\r\n  // On final (vertical) pass, convert back to RGB\r\n  if (isVert) {\r\n    sum.rgb = ycbcr2rgb(sum.rgb);\r\n  }\r\n\r\n  gl_FragColor = sum;\r\n}\r\n";

  var dctInverseYFrag = "/*\n  Inverse DCT shader - Y-only mode (grayscale)\n  Reconstructs spatial image from DCT coefficients, luminance channel only.\n  Run twice (horizontal then vertical) for full 2D IDCT.\n*/\n\n#define PI 3.14159265\n#define PI2 6.28318530\n#define hPI 1.57079632\n\nprecision highp float;\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nbool validuv(vec2 v) {\n  return 0.0 < v.x && v.x < 1.0 && 0.0 < v.y && v.y < 1.0;\n}\n\n// Waveform function (replaceable via JS API)\n// Parameters: angle (phase angle), time (current time in ms), wi (wave input parameter)\nfloat wave(float angle) {\n  return cos(angle);\n}\n\nvoid main() {\n  // Direction vector\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n\n  // Block dimensions\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(bs), lpf));\n\n  // Spatial position within block (which pixel are we reconstructing?)\n  float delta = mod(dot(bv, gl_FragCoord.xy), float(blockSize));\n\n  // Accumulate IDCT sum\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (loopLimit <= i) break;\n\n    float fdelta = float(i);\n\n    // Read DCT coefficient for frequency i\n    vec4 val = texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution);\n\n    // IDCT basis function\n    float awave = wave(delta * fdelta / float(bs) * PI);\n\n    sum += awave * val;\n  }\n\n  // On final (vertical) pass, output luminance as grayscale\n  if (isVert) {\n    sum = vec4(sum.x, sum.x, sum.x, sum.w);\n  }\n\n  gl_FragColor = sum;\n}\n";

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
    return src.replace('gl_FragColor = sum;', RGBM_ENCODE);
  }

  function buildFwdV(src) {
    return src
      .replace('vec4 val = texture2D(inputTexture, uv);', rgbmDecode('texture2D(inputTexture, uv)'))
      .replace('gl_FragColor = sum;', RGBM_ENCODE);
  }

  function buildInvH(src) {
    return src
      .replace(
        'vec4 val = texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution);',
        rgbmDecode('texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution)')
      )
      .replace('gl_FragColor = sum;', RGBM_ENCODE);
  }

  function buildInvV(src) {
    return src
      .replace(
        'vec4 val = texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution);',
        rgbmDecode('texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution)')
      )
      .replace('gl_FragColor = sum;', 'gl_FragColor = clamp(sum, 0.0, 1.0); gl_FragColor.a = 1.0;');
  }

  class RenderPipeline8bit extends RenderPipeline {
    _buildPrograms() {
      const gl = this.gl;

      // Precompute injected forward sources (static — no wave replacement needed)
      this._fwdColorH_src = buildFwdH(dctForwardFrag);
      this._fwdColorV_src = buildFwdV(dctForwardFrag);
      this._fwdYH_src     = buildFwdH(dctForwardYFrag);
      this._fwdYV_src     = buildFwdV(dctForwardYFrag);

      // Precompute injected inverse templates (wave replacement operates on these)
      this._invColorH_tpl = buildInvH(dctInverseFrag);
      this._invColorV_tpl = buildInvV(dctInverseFrag);
      this._invYH_tpl     = buildInvH(dctInverseYFrag);
      this._invYV_tpl     = buildInvV(dctInverseYFrag);

      this._fwdColorH = buildProgram(gl, quadVert, this._fwdColorH_src);
      this._fwdColorV = buildProgram(gl, quadVert, this._fwdColorV_src);
      this._fwdYH     = buildProgram(gl, quadVert, this._fwdYH_src);
      this._fwdYV     = buildProgram(gl, quadVert, this._fwdYV_src);

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
      ]) gl.deleteProgram(prog);

      gl.deleteProgram(this._passthroughProgram);
      for (const prog of Object.values(this._blitPrograms)) gl.deleteProgram(prog);
      gl.deleteBuffer(this._quadBuffer);

      for (const fb of [this._fbInput, this._fbTempA, this._fbDCT, this._fbTempB]) {
        gl.deleteFramebuffer(fb.framebuffer);
        gl.deleteTexture(fb.texture);
      }
    }
  }

  class DisplayController {
    constructor(canvas) {
      this.canvas = canvas;
      this._shown = false;
      this._flipY = false;
    }

    show() {
      this._shown = true;
      this.canvas.style.display = '';
    }

    hide() {
      this._shown = false;
      this.canvas.style.display = 'none';
    }

    mount(parent = document.body) {
      if (!parent || !(parent instanceof HTMLElement)) {
        throw new Error('DisplayController.mount: parent must be an HTMLElement');
      }
      if (this.canvas.parentNode !== parent) {
        parent.appendChild(this.canvas);
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
      }
    }

    unmount() {
      if (this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
    }

    setSize(width, height) {
      if (width !== undefined && width !== null) {
        this.canvas.style.width = typeof width === 'number' ? `${width}px` : width;
      }
      if (height !== undefined && height !== null) {
        this.canvas.style.height = typeof height === 'number' ? `${height}px` : height;
      }
    }

    set flipY(val) {
      this._flipY = !!val;
      this.canvas.style.transform = this._flipY ? 'scaleY(-1)' : '';
    }

    get flipY() {
      return this._flipY;
    }
  }

  const DEFAULT_UNIFORMS = {
    blockSize: 8,
    lpf: 128.0,
    highFreqMultiplier: 0.0,
    quantizeY: 0.0,
    quantizeYf: 0.0,
    quantizeC: 0.0,
    quantizeCf: 0.0,
    quantizeA: 0.0,
    quantizeAf: 0.0,
    yOnly: false,
    waveInput: 0.0,
  };

  const QUANTIZE_PROPS = new Set(['quantizeY', 'quantizeYf', 'quantizeC', 'quantizeCf', 'quantizeA', 'quantizeAf']);

  function normalizeQuantize(name, value) {
    if (QUANTIZE_PROPS.has(name) && typeof value === 'number') {
      const t = Math.min(Math.max(value, 0), 1);
      return t * t;
    }
    return value;
  }

  class ShaderConfig {
    constructor() {
      this.uniforms = { ...DEFAULT_UNIFORMS };
      this._fps = 0;
      this._frameInterval = 0;
    }

    setUniform(name, value) {
      if (!(name in this.uniforms)) {
        console.warn(`ShaderConfig: unknown uniform "${name}"`);
      }
      this.uniforms[name] = value;
    }

    setUniforms(obj) {
      for (const key in obj) {
        this.setUniform(key, obj[key]);
      }
    }

    resolveUniform(name) {
      const current = this.uniforms[name];
      const value = typeof current === 'function' ? current() : current;
      return value === undefined ? DEFAULT_UNIFORMS[name] : normalizeQuantize(name, value);
    }

    setFPS(fps) {
      this._fps = Math.max(0, Number(fps) || 0);
      this._frameInterval = this._fps > 0 ? 1000 / this._fps : 0;
    }

    get fps() {
      return this._fps;
    }

    set fps(value) {
      this.setFPS(value);
    }

    get frameInterval() {
      return this._frameInterval;
    }
  }

  /**
   * DCTLive — WebGL implementation of JPEG-like DCT.
   *
   * Design & API: geikha
   * Implementation: Claude Code
   * DCT shader reference: FMS-Cat (https://www.youtube.com/watch?v=xt4UFRPqX_w)
   * Guidance: sol sarratea (https://solsarratea.world/)
   *
   * Usage:
   *   const dct = new DCTLive({ width: 512, height: 512, loop: true });
   *   await dct.initImage('image.png');
   *   dct.show();
   *   dct.start();
   */


  class DCTLive {
    /**
     * @param {Object} opts
     * @param {number}  [opts.width=256]  - Canvas / processing width
     * @param {number}  [opts.height=256] - Canvas / processing height
     * @param {boolean} [opts.loop=true]  - Continuously re-run the pipeline (default: true)
     * @param {HTMLCanvasElement} [opts.canvas] - Optional existing canvas
     */
    constructor(opts = {}) {
      this.width = opts.width || 256;
      this.height = opts.height || 256;
      this._looping = false;
      this._rafId = null;
      this._lastFrameTime = null;

      // Canvas
      this.canvas = opts.canvas || document.createElement('canvas');
      this.canvas.width = this.width;
      this.canvas.height = this.height;

      // WebGL
      const gl = this.canvas.getContext('webgl');
      if (!gl) throw new Error('WebGL not supported');
      this.gl = gl;

      // GL state
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // Resolve texture precision (default '16bit', fallback chain: 16→8 or 32→16→8)
      const { type: texType, actual: precision } = resolveTexType(gl, opts.precision || '16bit');
      this._precision = precision;

      // Modules
      const Pipeline = precision === '8bit' ? RenderPipeline8bit : RenderPipeline;
      this._pipeline = new Pipeline(gl, this.width, this.height, texType);
      this._display = new DisplayController(this.canvas);
      this._config = new ShaderConfig();

      // DCT/RDCT pass control
      this.dctHorizontal = true;
      this.dctVertical = true;
      this.rdctHorizontal = true;
      this.rdctVertical = true;

      // Input source manager
      this.input = new InputSource(gl, this.width, this.height);

      // Define shorthand uniform properties
      this._defineShorthandProperties();

      // Auto-start loop when an input source is ready (default: true)
      this._autoLoop = opts.loop !== false;
    }

    _defineShorthandProperties() {
      const shorthandMap = {
        qY: 'quantizeY',
        qYf: 'quantizeYf',
        qC: 'quantizeC',
        qCf: 'quantizeCf',
        qA: 'quantizeA',
        qAf: 'quantizeAf',
        hfreq: 'highFreqMultiplier',
        blockSize: 'blockSize',
        lpf: 'lpf',
        waveInput: 'waveInput',
      };

      for (const [shorthand, fullName] of Object.entries(shorthandMap)) {
        Object.defineProperty(this, shorthand, {
          get: () => this._config.uniforms[fullName],
          set: (value) => { this._config.uniforms[fullName] = value; },
          enumerable: true,
          configurable: true,
        });
      }

      // yOnly has special behavior: swaps programs in the pipeline
      Object.defineProperty(this, 'yOnly', {
        get: () => this._config.uniforms.yOnly,
        set: (value) => {
          this._config.uniforms.yOnly = value;
          this._pipeline.setYOnly(value);
        },
        enumerable: true,
        configurable: true,
      });
    }

    // ---- Proxy to modules (backwards compatibility) ----

    get uniforms() {
      return this._config.uniforms;
    }

    get precision() {
      return this._precision;
    }

    get flipY() {
      return this._display.flipY;
    }

    set flipY(value) {
      this._display.flipY = value;
      this.input.flipY = value;
    }

    get fps() {
      return this._config.fps;
    }

    set fps(value) {
      this._config.fps = value;
    }

    // ---- Image / source loading ----

    /**
     * Load an image from a URL or set an HTMLImageElement as input.
     * @param {string|HTMLImageElement} source - URL string or image element
     * @param {Object} [opts] - { fit, minFilter, magFilter, wrapS, wrapT, wrap }
     * @returns {Promise<void>}
     */
    async initImage(source, opts = {}) {
      try {
        if (typeof source === 'string') {
          await this.input.loadImage(source, opts);
        } else if (source instanceof HTMLImageElement) {
          this.input.setImage(source, opts);
        } else {
          throw new Error('DCTLive.initImage: source must be a URL string or HTMLImageElement');
        }
        this.run();
        if (this._autoLoop) this.start();
      } catch (err) {
        console.error('DCTLive.initImage failed:', err);
      }
    }

    /**
     * Load a video from a URL or set an HTMLVideoElement as dynamic input.
     * @param {string|HTMLVideoElement} source - URL string or video element
     * @param {Object} [opts] - { fit, minFilter, magFilter, wrapS, wrapT, wrap }
     * @returns {Promise<void>}
     */
    async initVideo(source, opts = {}) {
      try {
        if (typeof source === 'string') {
          await new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.src = source;
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.loop = true;
            video.playsInline = true;

            const cleanup = () => {
              video.removeEventListener('loadeddata', onLoaded);
              video.removeEventListener('error', onError);
            };
            const onLoaded = () => {
              cleanup();
              this.input.setVideo(video, opts);
              video.play().catch(() => {});
              resolve();
            };
            const onError = (e) => {
              cleanup();
              reject(new Error(`DCTLive.initVideo: failed to load "${source}" — ${e.message || 'unknown error'}`));
            };

            video.addEventListener('loadeddata', onLoaded);
            video.addEventListener('error', onError);
          });
        } else if (source instanceof HTMLVideoElement) {
          this.input.setVideo(source, opts);
        } else {
          throw new Error('DCTLive.initVideo: source must be a URL string or HTMLVideoElement');
        }
        this.run();
        if (this._autoLoop) this.start();
      } catch (err) {
        console.error('DCTLive.initVideo failed:', err);
      }
    }

    /**
     * Set another canvas as dynamic input.
     * Accepts HTMLCanvasElement, a CanvasRenderingContext2D, or Hydra-style wrapper objects.
     * @param {HTMLCanvasElement|CanvasRenderingContext2D|Object} canvas
     * @param {Object} [opts]
     */
    async initCanvas(canvas, opts = {}) {
      try {
        let targetCanvas = canvas;

        if (canvas && typeof canvas === 'object') {
          if (canvas instanceof HTMLCanvasElement) {
            targetCanvas = canvas;
          } else if (canvas instanceof CanvasRenderingContext2D) {
            targetCanvas = canvas.canvas;
          } else if (canvas.src instanceof HTMLCanvasElement) {
            targetCanvas = canvas.src;
          } else if (canvas.src instanceof CanvasRenderingContext2D) {
            targetCanvas = canvas.src.canvas;
          } else if (canvas.canvas instanceof HTMLCanvasElement) {
            targetCanvas = canvas.canvas;
          } else if (canvas.canvas instanceof CanvasRenderingContext2D) {
            targetCanvas = canvas.canvas.canvas;
          } else if (typeof canvas.getContext === 'function') {
            targetCanvas = canvas;
          }
        }

        if (!(targetCanvas instanceof HTMLCanvasElement)) {
          throw new Error('DCTLive.initCanvas: expected an HTMLCanvasElement, CanvasRenderingContext2D, or wrapper object with a canvas source');
        }

        this.input.setCanvas(targetCanvas, opts);
        this.run();
        if (this._autoLoop) this.start();
      } catch (err) {
        console.error('DCTLive.initCanvas failed:', err);
      }
    }

    /**
     * Initialize camera input from device camera(s).
     * @param {number|string} [selector=0] - Camera index (number) or label (string)
     * @param {Object} [opts] - { constraints }
     * @returns {Promise<HTMLVideoElement>}
     */
    async initCam(selector = 0, opts = {}) {
      try {
        async function getCameras() {
          let devices = await navigator.mediaDevices.enumerateDevices();
          let cameras = devices.filter((d) => d.kind === 'videoinput');
          if (!cameras.some((d) => d.deviceId)) {
            // Permission not yet granted — trigger prompt, stop immediately, re-enumerate
            const temp = await navigator.mediaDevices.getUserMedia({ video: true });
            temp.getTracks().forEach((t) => t.stop());
            devices = await navigator.mediaDevices.enumerateDevices();
            cameras = devices.filter((d) => d.kind === 'videoinput');
          }
          return cameras;
        }

        const cameras = await getCameras();

        let device;
        if (typeof selector === 'number') {
          device = cameras[selector];
        } else if (typeof selector === 'string') {
          device = cameras.find((d) => d.label === selector);
          if (!device) device = cameras.find((d) => d.label.toLowerCase().includes(selector.toLowerCase()));
        }

        if (!device && cameras.length === 0) {
          console.warn('DCTLive.initCam: no cameras found');
          return;
        }

        const constraints = opts.constraints || {
          video: device
            ? { deviceId: { exact: device.deviceId }, width: { ideal: this.width }, height: { ideal: this.height } }
            : { width: { ideal: this.width }, height: { ideal: this.height } },
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;

        return new Promise((resolve) => {
          const cleanup = () => {
            video.removeEventListener('loadeddata', onLoadedData);
            video.removeEventListener('error', onError);
          };

          const onLoadedData = () => {
            cleanup();
            this.input.setVideo(video, opts);
            this.run();
            if (this._autoLoop) this.start();
            resolve(video);
          };

          const onError = (e) => {
            cleanup();
            console.warn('DCTLive.initCam: video error:', e);
            resolve(video);
          };

          video.addEventListener('loadeddata', onLoadedData, { once: true });
          video.addEventListener('error', onError, { once: true });
          video.play().catch((e) => {
            console.warn('DCTLive.initCam: play() blocked:', e);
          });
        });
      } catch (err) {
        const msg = `Camera error: ${err.name || 'unknown'} - ${err.message || err}`;
        console.error('DCTLive.initCam:', msg);
        throw err;
      }
    }

    // ---- Uniform setters ----

    setUniform(name, value) {
      this._config.setUniform(name, value);
    }

    setUniforms(obj) {
      this._config.setUniforms(obj);
    }

    // ---- Wave function ----

    /**
     * Replace the wave function body in the inverse DCT shader.
     * @param {string} glslBody - GLSL function body, e.g. "return cos(angle);"
     */
    setWaveFunction(glslBody) {
      this._pipeline.setWaveFunction(glslBody);
    }

    /**
     * Reset the wave function to the default cosine.
     */
    resetWaveFunction() {
      this._pipeline.resetWaveFunction();
    }

    /**
     * Set the WebGL processing resolution.
     * @param {number} width
     * @param {number} height
     */
    setResolution(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      if (w === this.width && h === this.height) return;
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this._pipeline.setResolution(w, h);
      this.input.setTargetSize(w, h);
      if (!this._looping) this.run();
    }

    /**
     * Resize the canvas display area using CSS (does not affect WebGL resolution).
     * @param {number|string} width  - CSS width (number treated as px, or any CSS string)
     * @param {number|string} height - CSS height
     */
    resizeCanvas(width, height) {
      this._display.setSize(width, height);
    }

    /**
     * Control which forward DCT passes run (horizontal and/or vertical).
     * Vertical defaults to the same as horizontal if not explicitly set.
     * @param {boolean} [horizontal=true]
     * @param {boolean} [vertical=undefined]
     */
    setDCT(horizontal = true, vertical = undefined) {
      this.dctHorizontal = !!horizontal;
      this.dctVertical = vertical !== undefined ? !!vertical : this.dctHorizontal;
    }

    /**
     * Control which inverse DCT passes run (horizontal and/or vertical).
     * Vertical defaults to the same as horizontal if not explicitly set.
     * @param {boolean} [horizontal=true]
     * @param {boolean} [vertical=undefined]
     */
    setRDCT(horizontal = true, vertical = undefined) {
      this.rdctHorizontal = !!horizontal;
      this.rdctVertical = vertical !== undefined ? !!vertical : this.rdctHorizontal;
    }

    // ---- Rendering ----

    /**
     * Run the DCT/IDCT pipeline once.
     */
    run() {
      if (!this.input.texture) return;
      this.input.update();
      this._pipeline.render({
        inputTexture: this.input.texture,
        uvScale:      this.input.uvScale,
        uvOffset:     this.input.uvOffset,
        wrap:         this.input.effectiveWrap,
        dctHorizontal: this.dctHorizontal,
        dctVertical: this.dctVertical,
        rdctHorizontal: this.rdctHorizontal,
        rdctVertical: this.rdctVertical,
        resolveUniform: (name) => this._config.resolveUniform(name),
      });
    }

    // ---- Loop control ----

    /**
     * Start the render loop.
     */
    start() {
      if (this._looping) return;
      this._looping = true;
      this._lastFrameTime = null;
      const loop = (timestamp) => {
        if (!this._looping) return;
        const frameInterval = this._config.frameInterval;
        if (this._lastFrameTime === null) {
          // First tick: always render, anchor the clock cleanly
          this.run();
          this._lastFrameTime = timestamp;
        } else {
          const delta = timestamp - this._lastFrameTime;
          if (frameInterval <= 0 || delta >= frameInterval) {
            this.run();
            // Drift-correct: carry over any excess time so frame rate stays accurate
            this._lastFrameTime = frameInterval > 0
              ? timestamp - (delta % frameInterval)
              : timestamp;
          }
        }
        this._rafId = requestAnimationFrame(loop);
      };
      this._rafId = requestAnimationFrame(loop);
    }

    /**
     * Stop the render loop.
     */
    stop() {
      this._looping = false;
      if (this._rafId !== null) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
    }

    // ---- Display ----

    /**
     * Show the canvas.
     */
    show() {
      this._display.show();
    }

    /**
     * Hide the canvas.
     */
    hide() {
      this._display.hide();
    }

    /**
     * Append the canvas into a DOM parent.
     * @param {HTMLElement} parent
     */
    mount(parent = document.body) {
      this._display.mount(parent);
    }

    /**
     * Remove the canvas from the DOM.
     */
    unmount() {
      this._display.unmount();
    }

    /**
     * Reset to initial configuration: all uniforms to defaults, wave function to cosine, all passes enabled.
     */
    reset() {
      this._config.uniforms.blockSize = 8;
      this._config.uniforms.lpf = 128;
      this._config.uniforms.highFreqMultiplier = 0;
      this._config.uniforms.quantizeY = 0;
      this._config.uniforms.quantizeYf = 0;
      this._config.uniforms.quantizeC = 0;
      this._config.uniforms.quantizeCf = 0;
      this._config.uniforms.quantizeA = 0;
      this._config.uniforms.quantizeAf = 0;
      this._config.uniforms.waveInput = 0;
      this.yOnly = false;
      this.resetWaveFunction();
      this.dctHorizontal = true;
      this.dctVertical = true;
      this.rdctHorizontal = true;
      this.rdctVertical = true;
    }

    /**
     * Clean up WebGL resources.
     */
    destroy() {
      this.stop();
      this.hide();
      this._pipeline.destroy();
      this.input.destroy();
    }
  }

  exports.InputSource = InputSource;
  exports.default = DCTLive;

  Object.defineProperty(exports, '__esModule', { value: true });

  return exports;

})({});
/* Expose default export as global DCTLive */
var DCTLive = DCTLiveModule.default;
DCTLive.InputSource = DCTLiveModule.InputSource;
