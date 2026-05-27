/**
 * InputSource — Manages an input source (image, video, canvas) for DCTLive.
 *
 * Handles texture creation, scaling/fitting, filter modes, wrap modes,
 * and dynamic source updating (video/canvas re-upload each frame).
 *
 * Usage:
 *   const src = new InputSource(gl, dctWidth, dctHeight);
 *   await src.loadImage('photo.png', { fit: 'fit' });
 *   // or
 *   src.setVideo(videoElement, { fit: 'fill', filter: 'nearest' });
 *   // or
 *   src.setCanvas(otherCanvas, { wrap: 'repeat' });
 *
 *   // Each frame (called by DCTLive.run automatically):
 *   src.update();  // re-uploads texture data if source is dynamic
 */

// ---- GL constant maps ----

const FILTER_MAP = {
  linear: 'LINEAR',
  nearest: 'NEAREST',
};

const WRAP_MAP = {
  clamp: 'CLAMP_TO_EDGE',
  repeat: 'REPEAT',
  mirror: 'MIRRORED_REPEAT',
};

const FIT_MODES = ['stretch', 'fill', 'fit'];

// ---- Class ----

class InputSource {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {number} targetWidth  - DCT processing width
   * @param {number} targetHeight - DCT processing height
   */
  constructor(gl, targetWidth, targetHeight) {
    this.gl = gl;
    this.targetWidth = targetWidth;
    this.targetHeight = targetHeight;

    // The WebGL texture used as shader input
    this.texture = null;

    // Current settings (defaults)
    this._minFilter = 'linear';
    this._magFilter = 'linear';
    this._wrapS = 'clamp';
    this._wrapT = 'clamp';
    this._fit = 'stretch';

    // Source tracking
    this._source = null;       // HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
    this._isDynamic = false;   // true for video/canvas → re-upload each frame
    this._needsUpload = false; // flag to upload on next update()

    // Offscreen canvas for fit/scaling
    this._offscreen = document.createElement('canvas');
    this._offscreen.width = targetWidth;
    this._offscreen.height = targetHeight;
    this._offscreenCtx = this._offscreen.getContext('2d');
  }

  /**
   * Update the input target resolution.
   * @param {number} width
   * @param {number} height
   */
  setTargetSize(width, height) {
    this.targetWidth = Math.max(1, Math.floor(width));
    this.targetHeight = Math.max(1, Math.floor(height));
    this._offscreen.width = this.targetWidth;
    this._offscreen.height = this.targetHeight;
    this._offscreenCtx = this._offscreen.getContext('2d');
    if (this._source) {
      this._drawToOffscreen(this._source);
      this._needsUpload = true;
    }
  }

  // ---- Public settings ----

  /**
   * Set texture minification filter.
   * @param {'linear'|'nearest'} mode
   */
  set minFilter(mode) {
    this._minFilter = mode;
    this._applyTexParams();
  }
  get minFilter() { return this._minFilter; }

  /**
   * Set texture magnification filter.
   * @param {'linear'|'nearest'} mode
   */
  set magFilter(mode) {
    this._magFilter = mode;
    this._applyTexParams();
  }
  get magFilter() { return this._magFilter; }

  /**
   * Set texture wrap mode for S (horizontal).
   * @param {'clamp'|'repeat'|'mirror'} mode
   */
  set wrapS(mode) {
    this._wrapS = mode;
    this._applyTexParams();
  }
  get wrapS() { return this._wrapS; }

  /**
   * Set texture wrap mode for T (vertical).
   * @param {'clamp'|'repeat'|'mirror'} mode
   */
  set wrapT(mode) {
    this._wrapT = mode;
    this._applyTexParams();
  }
  get wrapT() { return this._wrapT; }

  /**
   * Set both wrap modes at once.
   * @param {'clamp'|'repeat'|'mirror'} mode
   */
  set wrap(mode) {
    this._wrapS = mode;
    this._wrapT = mode;
    this._applyTexParams();
  }

  /**
   * Set fit mode (how source is drawn onto the target dimensions).
   * @param {'stretch'|'fill'|'fit'} mode
   */
  set fit(mode) {
    if (!FIT_MODES.includes(mode)) {
      console.warn(`InputSource: unknown fit mode "${mode}"`);
      return;
    }
    this._fit = mode;
    // Re-draw existing source with new fit
    if (this._source) {
      this._drawToOffscreen(this._source);
      this._needsUpload = true;
    }
  }
  get fit() { return this._fit; }

  /**
   * Bulk-set options.
   * @param {Object} opts - { minFilter, magFilter, wrapS, wrapT, wrap, fit }
   */
  setOptions(opts = {}) {
    if (opts.minFilter) this._minFilter = opts.minFilter;
    if (opts.magFilter) this._magFilter = opts.magFilter;
    if (opts.wrap) {
      this._wrapS = opts.wrap;
      this._wrapT = opts.wrap;
    }
    if (opts.wrapS) this._wrapS = opts.wrapS;
    if (opts.wrapT) this._wrapT = opts.wrapT;
    if (opts.fit && FIT_MODES.includes(opts.fit)) this._fit = opts.fit;
    this._applyTexParams();
    // Re-draw if source exists and fit changed
    if (this._source && opts.fit) {
      this._drawToOffscreen(this._source);
      this._needsUpload = true;
    }
  }

  // ---- Source loaders ----

  /**
   * Load an image from a URL.
   * @param {string} url
   * @param {Object} [opts] - { fit, minFilter, magFilter, wrapS, wrapT, wrap }
   * @returns {Promise<void>}
   */
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

  /**
   * Set an HTMLImageElement directly.
   * @param {HTMLImageElement} img
   * @param {Object} [opts]
   */
  setImage(img, opts = {}) {
    if (opts) this.setOptions(opts);
    this._setSource(img, false);
  }

  /**
   * Set an HTMLVideoElement as a dynamic source.
   * The texture will be re-uploaded every frame.
   * @param {HTMLVideoElement} video
   * @param {Object} [opts]
   */
  setVideo(video, opts = {}) {
    if (opts) this.setOptions(opts);
    this._setSource(video, true);
  }

  /**
   * Set another HTMLCanvasElement as a dynamic source.
   * The texture will be re-uploaded every frame.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [opts]
   */
  setCanvas(canvas, opts = {}) {
    if (opts) this.setOptions(opts);
    this._setSource(canvas, true);
  }

  // ---- Frame update ----

  /**
   * Called each frame before rendering.
   * Re-uploads the texture if the source is dynamic (video/canvas).
   */
  update() {
    if (!this._source || !this.texture) return;

    if (this._isDynamic) {
      // Dynamic sources: always re-draw and re-upload
      this._drawToOffscreen(this._source);
      this._uploadTexture();
    } else if (this._needsUpload) {
      // Static source that was redrawn (e.g. fit changed)
      this._uploadTexture();
      this._needsUpload = false;
    }
  }

  // ---- Internal ----

  /**
   * @private
   */
  _setSource(source, isDynamic) {
    this._source = source;
    this._isDynamic = isDynamic;

    // Draw to offscreen (applies fit)
    this._drawToOffscreen(source);

    // Create texture if needed
    if (!this.texture) {
      this.texture = this.gl.createTexture();
    }

    // Upload and set params
    this._uploadTexture();
    this._applyTexParams();
  }

  /**
   * Draw the source onto the offscreen canvas with the current fit mode.
   * @private
   */
  _drawToOffscreen(source) {
    const ctx = this._offscreenCtx;
    const cw = this.targetWidth;
    const ch = this.targetHeight;

    // Clear
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    // Source dimensions
    const sw = source.videoWidth || source.width;
    const sh = source.videoHeight || source.height;
    if (!sw || !sh) return; // video not ready yet

    const srcAspect = sw / sh;
    const tgtAspect = cw / ch;
    let dw, dh, dx, dy;

    switch (this._fit) {
      case 'stretch':
        dw = cw; dh = ch; dx = 0; dy = 0;
        break;
      case 'fill':
        if (srcAspect > tgtAspect) {
          dh = ch; dw = dh * srcAspect;
        } else {
          dw = cw; dh = dw / srcAspect;
        }
        dx = (cw - dw) / 2;
        dy = (ch - dh) / 2;
        break;
      case 'fit':
      default:
        if (srcAspect > tgtAspect) {
          dw = cw; dh = dw / srcAspect;
        } else {
          dh = ch; dw = dh * srcAspect;
        }
        dx = (cw - dw) / 2;
        dy = (ch - dh) / 2;
        break;
    }

    ctx.drawImage(source, dx, dy, dw, dh);
  }

  /**
   * Upload the offscreen canvas to the GL texture.
   * @private
   */
  _uploadTexture() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._offscreen);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Apply current filter and wrap params to the texture.
   * @private
   */
  _applyTexParams() {
    if (!this.texture) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl[FILTER_MAP[this._minFilter]] || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl[FILTER_MAP[this._magFilter]] || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl[WRAP_MAP[this._wrapS]] || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl[WRAP_MAP[this._wrapT]] || gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Clean up GL resources.
   */
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
 * Create a floating-point framebuffer (render target).
 * @param {WebGLRenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @returns {{ framebuffer: WebGLFramebuffer, texture: WebGLTexture }}
 */
function createFloatFramebuffer(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  // Unbind
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { framebuffer, texture };
}

var quadVert = "attribute vec2 position;\r\n\r\nvoid main() {\r\n  gl_Position = vec4(position, 0.0, 1.0);\r\n}\r\n";

var dctForwardFrag = "/*\r\n  Forward DCT shader (jpeg-cosine)\r\n  Computes 1D DCT along one axis (horizontal or vertical).\r\n  Run twice (horizontal then vertical) for full 2D DCT.\r\n*/\r\n\r\n#define lofi(i,j) floor((i)/(j)+.5)*(j)\r\n#define PI 3.14159265\r\n\r\nprecision highp float;\r\n\r\nuniform vec2 resolution;\r\nuniform bool isVert;\r\nuniform int blockSize;\r\nuniform sampler2D inputTexture;\r\n\r\nuniform float highFreqMultiplier;\r\nuniform float quantizeY;\r\nuniform float quantizeYf;\r\nuniform float quantizeC;\r\nuniform float quantizeCf;\r\nuniform float quantizeA;\r\nuniform float quantizeAf;\r\n\r\n// RGB to YCbCr conversion\r\nvec3 rgb2ycbcr(vec3 rgb) {\r\n  return vec3(\r\n     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,\r\n    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,\r\n     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b\r\n  );\r\n}\r\n\r\nvoid main() {\r\n  // Direction vector: (1,0) for horizontal, (0,1) for vertical\r\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\r\n\r\n  // Block dimensions in pixel space along the processing axis\r\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\r\n\r\n  // Origin of the current block (pixel coords, center-sampled)\r\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\r\n\r\n  // Actual block size (may be smaller at image edges)\r\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\r\n\r\n  // Which frequency coefficient are we computing?\r\n  // Position within block maps directly to frequency index\r\n  float freq = floor(mod(dot(bv, gl_FragCoord.xy), float(blockSize))) / float(bs) * PI;\r\n\r\n  // DCT normalization factor: 1/N for DC, 2/N for AC\r\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\r\n\r\n  // Accumulate the DCT sum (always use full block for correct coefficients)\r\n  vec4 sum = vec4(0.0);\r\n  for (int i = 0; i < 1024; i++) {\r\n    if (bs <= i) break;\r\n\r\n    // Offset within block to sample i-th pixel\r\n    vec2 delta = float(i) * bv;\r\n\r\n    // DCT basis function: cos((x + 0.5) * freq)\r\n    float wave = cos((float(i) + 0.5) * freq);\r\n\r\n    // Convert pixel coords to UV\r\n    vec2 uv = (blockOrigin + delta) / resolution;\r\n\r\n    // Flip Y on horizontal pass (WebGL texture coords vs image coords)\r\n    if (!isVert) {\r\n      uv = vec2(0.0, 1.0) + vec2(1.0, -1.0) * uv;\r\n    }\r\n\r\n    vec4 val = texture2D(inputTexture, uv);\r\n\r\n    // Convert RGB -> YCbCr on first (horizontal) pass\r\n    if (!isVert) {\r\n      val.rgb = rgb2ycbcr(val.rgb);\r\n    }\r\n\r\n    sum += wave * factor * val;\r\n  }\r\n\r\n  // Quantization (only after vertical pass = full 2D DCT done)\r\n  if (isVert) {\r\n    // Distance from DC component within block (frequency magnitude)\r\n    float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\r\n\r\n    // Quantize luminance (Y)\r\n    float qY = quantizeY + quantizeYf * len;\r\n    sum.x = qY > 0.0 ? lofi(sum.x, qY) : sum.x;\r\n\r\n    // Quantize chrominance (Cb, Cr)\r\n    float qC = quantizeC + quantizeCf * len;\r\n    sum.yz = qC > 0.0 ? lofi(sum.yz, qC) : sum.yz;\r\n\r\n    // Quantize alpha\r\n    float qA = quantizeA + quantizeAf * len;\r\n    sum.w = qA > 0.0 ? lofi(sum.w, qA) : sum.w;\r\n\r\n    // High frequency boost/cut\r\n    sum *= 1.0 + len * highFreqMultiplier;\r\n  }\r\n\r\n  gl_FragColor = sum;\r\n}\r\n";

var dctForwardYFrag = "/*\n  Forward DCT shader - Y-only mode (grayscale)\n  Computes 1D DCT along one axis, luminance channel only.\n  Run twice (horizontal then vertical) for full 2D DCT.\n*/\n\n#define lofi(i,j) floor((i)/(j)+.5)*(j)\n#define PI 3.14159265\n\nprecision highp float;\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\n\nvoid main() {\n  // Direction vector: (1,0) for horizontal, (0,1) for vertical\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n\n  // Block dimensions in pixel space along the processing axis\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n\n  // Origin of the current block (pixel coords, center-sampled)\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\n\n  // Actual block size (may be smaller at image edges)\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n\n  // Which frequency coefficient are we computing?\n  float freq = floor(mod(dot(bv, gl_FragCoord.xy), float(blockSize))) / float(bs) * PI;\n\n  // DCT normalization factor: 1/N for DC, 2/N for AC\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\n\n  // Accumulate the DCT sum\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (bs <= i) break;\n\n    // Offset within block to sample i-th pixel\n    vec2 delta = float(i) * bv;\n\n    // DCT basis function: cos((x + 0.5) * freq)\n    float wave = cos((float(i) + 0.5) * freq);\n\n    // Convert pixel coords to UV\n    vec2 uv = (blockOrigin + delta) / resolution;\n\n    // Flip Y on horizontal pass (WebGL texture coords vs image coords)\n    if (!isVert) {\n      uv = vec2(0.0, 1.0) + vec2(1.0, -1.0) * uv;\n    }\n\n    vec4 val = texture2D(inputTexture, uv);\n\n    // Extract luminance on first (horizontal) pass\n    if (!isVert) {\n      val.x = dot(val.rgb, vec3(0.299, 0.587, 0.114));\n      val.yz = vec2(0.0);\n    }\n\n    sum += wave * factor * val;\n  }\n\n  // Quantization (only after vertical pass = full 2D DCT done)\n  if (isVert) {\n    // Distance from DC component within block (frequency magnitude)\n    float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n\n    // Quantize luminance (Y)\n    float qY = quantizeY + quantizeYf * len;\n    sum.x = qY > 0.0 ? lofi(sum.x, qY) : sum.x;\n\n    // High frequency boost/cut\n    sum *= 1.0 + len * highFreqMultiplier;\n  }\n\n  gl_FragColor = sum;\n}\n";

var dctInverseFrag = "/*\r\n  Inverse DCT shader (jpeg-render)\r\n  Reconstructs spatial image from DCT coefficients.\r\n  Run twice (horizontal then vertical) for full 2D IDCT.\r\n*/\r\n\r\n#define PI 3.14159265\r\n#define PI2 6.28318530\r\n#define hPI 1.57079632\r\n\r\nprecision highp float;\r\n\r\nuniform vec2 resolution;\r\nuniform bool isVert;\r\nuniform int blockSize;\r\nuniform sampler2D inputTexture;\r\nuniform float lpf;\r\n\r\nbool validuv(vec2 v) {\r\n  return 0.0 < v.x && v.x < 1.0 && 0.0 < v.y && v.y < 1.0;\r\n}\r\n\r\n// YCbCr to RGB conversion\r\nvec3 ycbcr2rgb(vec3 yuv) {\r\n  return vec3(\r\n    yuv.x + 1.402    * yuv.z,\r\n    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,\r\n    yuv.x + 1.772    * yuv.y\r\n  );\r\n}\r\n\r\n// Waveform function (replaceable via JS API)\r\nfloat wave(float angle) {\r\n  return cos(angle);\r\n}\r\n\r\nvoid main() {\r\n  // Direction vector\r\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\r\n\r\n  // Block dimensions\r\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\r\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\r\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\r\n  int loopLimit = int(min(float(bs), lpf));\r\n\r\n  // Spatial position within block (which pixel are we reconstructing?)\r\n  float delta = mod(dot(bv, gl_FragCoord.xy), float(blockSize));\r\n\r\n  // Accumulate IDCT sum\r\n  vec4 sum = vec4(0.0);\r\n  for (int i = 0; i < 1024; i++) {\r\n    if (loopLimit <= i) break;\r\n\r\n    float fdelta = float(i);\r\n\r\n    // Read DCT coefficient for frequency i\r\n    vec4 val = texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution);\r\n\r\n    // IDCT basis function\r\n    float awave = wave(delta * fdelta / float(bs) * PI);\r\n\r\n    sum += awave * val;\r\n  }\r\n\r\n  // On final (vertical) pass, convert back to RGB\r\n  if (isVert) {\r\n    sum.rgb = ycbcr2rgb(sum.rgb);\r\n  }\r\n\r\n  gl_FragColor = sum;\r\n}\r\n";

var dctInverseYFrag = "/*\n  Inverse DCT shader - Y-only mode (grayscale)\n  Reconstructs spatial image from DCT coefficients, luminance channel only.\n  Run twice (horizontal then vertical) for full 2D IDCT.\n*/\n\n#define PI 3.14159265\n#define PI2 6.28318530\n#define hPI 1.57079632\n\nprecision highp float;\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\n\nbool validuv(vec2 v) {\n  return 0.0 < v.x && v.x < 1.0 && 0.0 < v.y && v.y < 1.0;\n}\n\n// Waveform function (replaceable via JS API)\nfloat wave(float angle) {\n  return cos(angle);\n}\n\nvoid main() {\n  // Direction vector\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n\n  // Block dimensions\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(bs), lpf));\n\n  // Spatial position within block (which pixel are we reconstructing?)\n  float delta = mod(dot(bv, gl_FragCoord.xy), float(blockSize));\n\n  // Accumulate IDCT sum\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (loopLimit <= i) break;\n\n    float fdelta = float(i);\n\n    // Read DCT coefficient for frequency i\n    vec4 val = texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution);\n\n    // IDCT basis function\n    float awave = wave(delta * fdelta / float(bs) * PI);\n\n    sum += awave * val;\n  }\n\n  // On final (vertical) pass, output luminance as grayscale\n  if (isVert) {\n    sum = vec4(sum.x, sum.x, sum.x, sum.w);\n  }\n\n  gl_FragColor = sum;\n}\n";

var passthroughFrag = "precision highp float;\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, uv);\n}\n";

const DEFAULT_WAVE_BODY = 'return cos(angle);';

function buildInverseSource(templateSrc, waveBody) {
  const replaced = templateSrc.replace(
    /float\s+wave\s*\(\s*float\s+angle\s*\)\s*\{[^}]*\}/,
    `float wave(float angle) {\n  ${waveBody}\n}`
  );
  if (replaced === templateSrc) {
    throw new Error('DCTLive: could not locate wave(float angle) function in inverse shader');
  }
  return replaced;
}

class RenderPipeline {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    // Build shader programs (color and Y-only variants)
    this._forwardColorProgram = buildProgram(gl, quadVert, dctForwardFrag);
    this._forwardYOnlyProgram = buildProgram(gl, quadVert, dctForwardYFrag);
    this._inverseColorProgram = buildProgram(gl, quadVert, dctInverseFrag);
    this._inverseYOnlyProgram = buildProgram(gl, quadVert, dctInverseYFrag);

    // Active pointers (start with color variants)
    this._forwardProgram = this._forwardColorProgram;
    this._inverseProgram = this._inverseColorProgram;

    // Templates for wave function updates
    this._inverseFragTemplate = dctInverseFrag;
    this._inverseYFragTemplate = dctInverseYFrag;
    this._waveBody = DEFAULT_WAVE_BODY;
    this._yOnly = false;

    this._passthroughProgram = buildProgram(gl, quadVert, passthroughFrag);

    // Fullscreen quad buffer
    this._quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    // Framebuffers for 4-pass pipeline
    this._createFramebuffers();
  }

  setWaveFunction(glslBody) {
    const gl = this.gl;
    const colorSource = buildInverseSource(this._inverseFragTemplate, glslBody);
    const yOnlySource = buildInverseSource(this._inverseYFragTemplate, glslBody);

    gl.deleteProgram(this._inverseColorProgram);
    gl.deleteProgram(this._inverseYOnlyProgram);

    this._inverseColorProgram = buildProgram(gl, quadVert, colorSource);
    this._inverseYOnlyProgram = buildProgram(gl, quadVert, yOnlySource);

    this._inverseProgram = this._yOnly ? this._inverseYOnlyProgram : this._inverseColorProgram;
    this._waveBody = glslBody;
  }

  resetWaveFunction() {
    this.setWaveFunction(DEFAULT_WAVE_BODY);
  }

  setYOnly(enabled) {
    this._yOnly = enabled;
    this._forwardProgram = enabled ? this._forwardYOnlyProgram : this._forwardColorProgram;
    this._inverseProgram = enabled ? this._inverseYOnlyProgram : this._inverseColorProgram;
  }

  setResolution(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this._resizeFramebuffers();
  }

  render(config) {
    const {
      inputTexture,
      dctHorizontal,
      dctVertical,
      rdctHorizontal,
      rdctVertical,
      resolveUniform,
    } = config;

    if (!inputTexture) return;

    this.gl;
    let currentTexture = inputTexture;
    const anyDCTEnabled = dctHorizontal || dctVertical;
    const anyRDCTEnabled = rdctHorizontal || rdctVertical;

    if (anyDCTEnabled) {
      if (dctHorizontal) {
        this._renderPass(this._forwardProgram, {
          target: this._fbTempA.framebuffer,
          inputTexture: currentTexture,
          isVert: false,
          isForward: true,
        }, resolveUniform);
        currentTexture = this._fbTempA.texture;
      }

      if (dctVertical) {
        this._renderPass(this._forwardProgram, {
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
        this._renderPass(this._inverseProgram, {
          target: this._fbTempB.framebuffer,
          inputTexture: currentTexture,
          isVert: false,
          isForward: false,
        }, resolveUniform);
        currentTexture = this._fbTempB.texture;
      }

      if (rdctVertical) {
        this._renderPass(this._inverseProgram, {
          target: null,
          inputTexture: currentTexture,
          isVert: true,
          isForward: false,
        }, resolveUniform);
      } else {
        this._renderPass(this._inverseProgram, {
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
    this._fbTempA = createFloatFramebuffer(gl, this.width, this.height);
    this._fbDCT = createFloatFramebuffer(gl, this.width, this.height);
    this._fbTempB = createFloatFramebuffer(gl, this.width, this.height);
  }

  _resizeFramebuffers() {
    const gl = this.gl;
    if (this._fbTempA) {
      gl.deleteFramebuffer(this._fbTempA.framebuffer);
      gl.deleteTexture(this._fbTempA.texture);
    }
    if (this._fbDCT) {
      gl.deleteFramebuffer(this._fbDCT.framebuffer);
      gl.deleteTexture(this._fbDCT.texture);
    }
    if (this._fbTempB) {
      gl.deleteFramebuffer(this._fbTempB.framebuffer);
      gl.deleteTexture(this._fbTempB.texture);
    }
    this._createFramebuffers();
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
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeY'), resolveUniform('quantizeY'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeYf'), resolveUniform('quantizeYf'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeC'), resolveUniform('quantizeC'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeCf'), resolveUniform('quantizeCf'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeA'), resolveUniform('quantizeA'));
      gl.uniform1f(gl.getUniformLocation(program, 'quantizeAf'), resolveUniform('quantizeAf'));
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
    gl.deleteBuffer(this._quadBuffer);
    gl.deleteFramebuffer(this._fbTempA.framebuffer);
    gl.deleteTexture(this._fbTempA.texture);
    gl.deleteFramebuffer(this._fbDCT.framebuffer);
    gl.deleteTexture(this._fbDCT.texture);
    gl.deleteFramebuffer(this._fbTempB.framebuffer);
    gl.deleteTexture(this._fbTempB.texture);
  }
}

class DisplayController {
  constructor(canvas) {
    this.canvas = canvas;
    this._shown = false;
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
  bypassRDCT: false,
  bypassDCT: false,
  yOnly: false,
};

function normalizeQuantize(name, value) {
  if (/^quantize/.test(name) && typeof value === 'number') {
    if (value > 1) {
      return Math.min(Math.max(value, 0), 100) / 100;
    }
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
 *
 *   // Bypass modes:
 *   dct.bypassDCT = true;   // Skip forward DCT, treat input as raw coefficients
 *   dct.bypassRDCT = true;  // Show DCT coefficients instead of reconstructed image
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

    // Required extensions for float textures
    const extFloat = gl.getExtension('OES_texture_float');
    if (!extFloat) throw new Error('OES_texture_float extension not supported');
    gl.getExtension('OES_texture_float_linear');

    // GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // Modules
    this._pipeline = new RenderPipeline(gl, this.width, this.height);
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
      bypassRDCT: 'bypassRDCT',
      bypassDCT: 'bypassDCT',
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
   * Clean up WebGL resources.
   */
  destroy() {
    this.stop();
    this.hide();
    this._pipeline.destroy();
    this.input.destroy();
  }
}

export { InputSource, DCTLive as default };
