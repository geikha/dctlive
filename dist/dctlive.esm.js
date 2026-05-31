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
    // flipY=true (default): flip texture on upload so top of image = top of screen.
    // flipY=false: raw WebGL orientation (bottom-up). Use when the source is already
    // in WebGL coordinate space or when compensating with a CSS scaleY(-1) transform.
    this._flipY = true;

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

  // Source dimensions
  get sourceWidth() { return this._sourceWidth; }
  get sourceHeight() { return this._sourceHeight; }

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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this._flipY ? 1 : 0);
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

var quadVert = "#define GLSLIFY 1\nattribute vec2 position;\n\nvoid main() {\n  gl_Position = vec4(position, 0.0, 1.0);\n}\n";

var quadFlipYVert = "#define GLSLIFY 1\nattribute vec2 position;\n\nvoid main() {\n  gl_Position = vec4(position.x, -position.y, 0.0, 1.0);\n}\n";

var dctColorInFrag = "precision highp float;\n#define GLSLIFY 1\n\n// ITU-R BT.601: convert linear RGB (0–1) to YCbCr.\n// Y  = luminance.  Cb = blue-difference chroma.  Cr = red-difference chroma.\n// The chroma channels are centred on zero (neutral grey = 0, not 0.5).\nvec3 rgb2ycbcr(vec3 rgb) {\n  return vec3(\n     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,\n    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,\n     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b\n  );\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec4 color = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n  color.rgb = rgb2ycbcr(color.rgb);\n  gl_FragColor = color;\n}\n";

var dctColorOutFrag = "precision highp float;\n#define GLSLIFY 1\n\n// ITU-R BT.601 inverse: YCbCr → linear RGB.\n// Exact inverse of rgb2ycbcr — chroma channels are zero-centred.\nvec3 ycbcr2rgb(vec3 yuv) {\n  return vec3(\n    yuv.x + 1.402    * yuv.z,\n    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,\n    yuv.x + 1.772    * yuv.y\n  );\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\nuniform bool yOnlyMode;\nuniform bool flipY;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  if (flipY) uv.y = 1.0 - uv.y;\n  vec4 color = texture2D(inputTexture, uv);\n\n  if (yOnlyMode) {\n    color.rgb = vec3(color.x);\n    color.a = 1.0;\n  } else {\n    color.rgb = ycbcr2rgb(color.rgb);\n  }\n\n  gl_FragColor = color;\n}\n";

var dctForwardColorFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nvec4 readTexel(vec2 uv) { return texture2D(inputTexture, uv); }\n\n#define PI 3.14159265\n\n// 1D forward DCT for one output coefficient (one fragment = one frequency bin).\n// The caller injects readTexel(vec2 uv) → vec4, which handles any codec wrapping.\n//\n// fragCoord: gl_FragCoord.xy of the output fragment\n// isVert:    true = vertical pass (down columns), false = horizontal (across rows)\n// blockSize: DCT block size (e.g. 8)\n//\n// The fragment's position within its block determines which frequency it represents.\n// Its value is the inner product of the block's input samples with the cosine basis:\n//   F[k] = factor * Σ x[n] * cos((n + 0.5) * k*π/N)\n// factor = 1/N for DC (k=0), 2/N otherwise — the standard orthonormal DCT-II scaling.\nvec4 dctForward(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize) {\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n\n  float freq = floor(mod(dot(bv, fragCoord), float(blockSize))) / float(bs) * PI;\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\n\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (bs <= i) break;\n    vec2 uv = (blockOrigin + float(i) * bv) / resolution;\n    float w = cos((float(i) + 0.5) * freq);\n    sum += w * factor * readTexel(uv);\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = dctForward(gl_FragCoord.xy, resolution, isVert, blockSize);\n}\n";

var dctForwardYFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nfloat readTexel(vec2 uv) { return texture2D(inputTexture, uv).x; }\n\n#define PI 3.14159265\n\n// 1D forward DCT, scalar (Y-only) variant. Same math as dct-forward.glsl but\n// operates on a single float channel — cheaper inner loop for luminance-only processing.\n// The caller injects readTexel(vec2 uv) → float.\nfloat dctForwardY(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize) {\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n\n  float freq = floor(mod(dot(bv, fragCoord), float(blockSize))) / float(bs) * PI;\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\n\n  float sum = 0.0;\n  for (int i = 0; i < 1024; i++) {\n    if (bs <= i) break;\n    vec2 uv = (blockOrigin + float(i) * bv) / resolution;\n    float w = cos((float(i) + 0.5) * freq);\n    sum += w * factor * readTexel(uv);\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = vec4(dctForwardY(gl_FragCoord.xy, resolution, isVert, blockSize), 0.0, 0.0, 1.0);\n}\n";

var dctInverseColorFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nvec4 readTexel(vec2 uv) { return texture2D(inputTexture, uv); }\n\n// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().\n#define DCTLIVE_WAVE_BODY return cos(angle);\nfloat wave(float angle) { DCTLIVE_WAVE_BODY }\n\n#define PI 3.14159265\n\n// 1D inverse DCT for one output pixel (one fragment = one spatial position).\n// The caller injects:\n//   readTexel(vec2 uv) -> vec4  -- read a coefficient; handles any codec wrapping\n//   wave(float angle) -> float  -- the reconstruction basis function (normally cos)\n//\n// lpf: low-pass filter limit -- only the first `lpf` frequency bins are summed.\n//   lpf = blockSize: full reconstruction.  lpf = 1: DC only (flat coloured blocks).\n//\n// The fragment's position within its block is `delta` (0 to blockSize-1).\n// Each frequency bin k contributes: F[k] * wave(delta * k * PI / N)\nvec4 dctInverse(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize, float lpf) {\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(bs), lpf));\n\n  float delta = mod(dot(bv, fragCoord), float(blockSize));\n\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (loopLimit <= i) break;\n    float fdelta = float(i);\n    vec4 val = readTexel((blockOrigin + bv * fdelta) / resolution);\n    sum += wave(delta * fdelta / float(bs) * PI) * val;\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = dctInverse(gl_FragCoord.xy, resolution, isVert, blockSize, lpf);\n}\n";

var dctInverseYFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nfloat readTexel(vec2 uv) { return texture2D(inputTexture, uv).x; }\n\n// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().\n#define DCTLIVE_WAVE_BODY return cos(angle);\nfloat wave(float angle) { DCTLIVE_WAVE_BODY }\n\n#define PI 3.14159265\n\n// 1D inverse DCT, scalar (Y-only) variant. Same math as dct-inverse.glsl but\n// accumulates a single float -- cheaper inner loop for luminance-only reconstruction.\n// The caller injects readTexel(vec2 uv) -> float and wave(float) -> float.\nfloat dctInverseY(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize, float lpf) {\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(bs), lpf));\n\n  float delta = mod(dot(bv, fragCoord), float(blockSize));\n\n  float sum = 0.0;\n  for (int i = 0; i < 1024; i++) {\n    if (loopLimit <= i) break;\n    float fdelta = float(i);\n    float lum = readTexel((blockOrigin + bv * fdelta) / resolution);\n    sum += wave(delta * fdelta / float(bs) * PI) * lum;\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = vec4(dctInverseY(gl_FragCoord.xy, resolution, isVert, blockSize, lpf), 0.0, 0.0, 1.0);\n}\n";

var dctQuantizeColorFrag = "precision highp float;\n#define GLSLIFY 1\n\n// Round `value` to the nearest multiple of `step`.\n// step=0 means no quantization (caller should guard against this).\nfloat quantize(float value, float step) {\n  return floor(value / step + 0.5) * step;\n}\n\n// Quantize a vec4 DCT coefficient (Y, Cb, Cr, A channels independently).\n// `len` is the Euclidean distance from the block's DC corner to this frequency bin —\n// used to scale the step size up for high-frequency coefficients (mimics JPEG's\n// quantization matrix). highFreqMultiplier amplifies the coefficient itself first.\nvec4 quantizeCoeff(vec4 coeff, float len, float highFreqMultiplier,\n    float qY, float qYf, float qC, float qCf, float qA, float qAf) {\n  coeff *= 1.0 + len * highFreqMultiplier;\n\n  float stepY = qY + qYf * len;\n  coeff.x = stepY > 0.0 ? quantize(coeff.x, stepY) : coeff.x;\n\n  float stepC = qC + qCf * len;\n  coeff.y = stepC > 0.0 ? quantize(coeff.y, stepC) : coeff.y;\n  coeff.z = stepC > 0.0 ? quantize(coeff.z, stepC) : coeff.z;\n\n  float stepA = qA + qAf * len;\n  coeff.w = stepA > 0.0 ? quantize(coeff.w, stepA) : coeff.w;\n\n  return coeff;\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\nuniform float quantizeC;\nuniform float quantizeCf;\nuniform float quantizeA;\nuniform float quantizeAf;\n\nvoid main() {\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n  vec4 coeff = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n  gl_FragColor = quantizeCoeff(coeff, len, highFreqMultiplier,\n    quantizeY, quantizeYf, quantizeC, quantizeCf, quantizeA, quantizeAf);\n}\n";

var dctQuantizeYFrag = "precision highp float;\n#define GLSLIFY 1\n\n// Round `value` to the nearest multiple of `step`.\n// step=0 means no quantization (caller should guard against this).\nfloat quantize(float value, float step) {\n  return floor(value / step + 0.5) * step;\n}\n\n// Quantize a single float luminance DCT coefficient.\n// Scalar version of quantizeCoeff — used in Y-only mode where chroma/alpha are absent.\nfloat quantizeCoeffY(float lum, float len, float highFreqMultiplier, float qY, float qYf) {\n  lum *= 1.0 + len * highFreqMultiplier;\n  float stepY = qY + qYf * len;\n  return stepY > 0.0 ? quantize(lum, stepY) : lum;\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\n\nvoid main() {\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n  float lum = texture2D(inputTexture, gl_FragCoord.xy / resolution).x;\n  gl_FragColor = vec4(quantizeCoeffY(lum, len, highFreqMultiplier, quantizeY, quantizeYf), 0.0, 0.0, 1.0);\n}\n";

var passthroughFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, uv);\n}\n";

var blitClampFrag = "precision highp float;\n#define GLSLIFY 1\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, uv * uvScale + uvOffset);\n}\n";

var blitRepeatFrag = "precision highp float;\n#define GLSLIFY 1\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, fract(uv * uvScale + uvOffset));\n}\n";

var blitMirrorFrag = "precision highp float;\n#define GLSLIFY 1\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  uv = uv * uvScale + uvOffset;\n  vec2 t = fract(uv * 0.5) * 2.0;\n  uv = 1.0 - abs(t - 1.0);\n  gl_FragColor = texture2D(inputTexture, uv);\n}\n";

var blitMaskFrag = "precision highp float;\n#define GLSLIFY 1\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  uv = uv * uvScale + uvOffset;\n  vec2 inBounds = step(vec2(0.0), uv) * step(uv, vec2(1.0));\n  float mask = inBounds.x * inBounds.y;\n  gl_FragColor = texture2D(inputTexture, uv) * mask;\n}\n";

const DEFAULT_WAVE_BODY = 'return cos(angle);';

// Patch the DCTLIVE_WAVE_BODY define in a glslified inverse shader source.
// Using a #define (rather than replacing the function body directly) means the
// target is a preprocessor directive — glslify never renames these, so the
// pattern is stable across shader refactors.
function buildInverseSource(templateSrc, waveBody) {
  const pattern = /#define DCTLIVE_WAVE_BODY [^\n]*/;
  if (!pattern.test(templateSrc)) {
    throw new Error('DCTLive: could not locate DCTLIVE_WAVE_BODY define in inverse shader');
  }
  return templateSrc.replace(pattern, `#define DCTLIVE_WAVE_BODY ${waveBody}`);
}

class RenderPipeline {
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
    this._passthroughFlipYProgram = buildProgram(gl, quadFlipYVert, passthroughFrag);

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

    this._colorInProgram  = buildProgram(gl, quadVert, dctColorInFrag);
    this._colorOutProgram = buildProgram(gl, quadVert, dctColorOutFrag);
    this._colorOutFlipYProgram = buildProgram(gl, quadFlipYVert, dctColorOutFrag);

    this._forwardColorProgram = buildProgram(gl, quadVert, dctForwardColorFrag);
    this._forwardYOnlyProgram = buildProgram(gl, quadVert, dctForwardYFrag);

    this._inverseFragTemplate  = dctInverseColorFrag;
    this._inverseYFragTemplate = dctInverseYFrag;

    this._inverseColorProgram = buildProgram(gl, quadVert, buildInverseSource(dctInverseColorFrag, DEFAULT_WAVE_BODY));
    this._inverseYOnlyProgram = buildProgram(gl, quadVert, buildInverseSource(dctInverseYFrag, DEFAULT_WAVE_BODY));

    this._quantizeColorProgram = buildProgram(gl, quadVert, dctQuantizeColorFrag);
    this._quantizeYOnlyProgram = buildProgram(gl, quadVert, dctQuantizeYFrag);

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
    this._draw(prog, null, () => {  // null = render to canvas
      gl.uniform2f(this._u(prog, 'resolution'), this.width, this.height);
      gl.uniform1i(this._u(prog, 'yOnlyMode'), this._yOnly ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      gl.uniform1i(this._u(prog, 'inputTexture'), 0);
    });
  }

  _renderPassthrough(inputTexture, target, flipViewport = false) {
    const gl = this.gl;
    const prog = (target === null && flipViewport) ? this._passthroughFlipYProgram : this._passthroughProgram;
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

var fwdColor = "precision highp float;\n#define GLSLIFY 1\n\n// Decode an RGBM-encoded vec4 back to its original high-range values.\n// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.\n#define RGBM_MAX 4.0\n\nvec4 rgbmDecode(vec4 enc) {\n  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha\n  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]\n  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale\n}\n\n// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.\n//\n// The three colour channels are normalized by their maximum absolute value (the \"M\"),\n// then sqrt-companded to concentrate precision near zero.\n// The scale factor M is stored in alpha after its own sqrt-compand.\n//\n// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.\n// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless\n// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.\n//\n// Decode with rgbmDecode.\n#define RGBM_MAX 4.0\n\nvec4 rgbmEncode(vec4 val) {\n  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));\n  mv = clamp(mv, 0.01, RGBM_MAX);\n  vec3 nrm = val.xyz / mv;\n  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage\n  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));\n}\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nvec4 readTexel(vec2 uv) { return rgbmDecode(texture2D(inputTexture, uv)); }\n\n#define PI 3.14159265\n\n// 1D forward DCT for one output coefficient (one fragment = one frequency bin).\n// The caller injects readTexel(vec2 uv) → vec4, which handles any codec wrapping.\n//\n// fragCoord: gl_FragCoord.xy of the output fragment\n// isVert:    true = vertical pass (down columns), false = horizontal (across rows)\n// blockSize: DCT block size (e.g. 8)\n//\n// The fragment's position within its block determines which frequency it represents.\n// Its value is the inner product of the block's input samples with the cosine basis:\n//   F[k] = factor * Σ x[n] * cos((n + 0.5) * k*π/N)\n// factor = 1/N for DC (k=0), 2/N otherwise — the standard orthonormal DCT-II scaling.\nvec4 dctForward(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize) {\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n\n  float freq = floor(mod(dot(bv, fragCoord), float(blockSize))) / float(bs) * PI;\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\n\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (bs <= i) break;\n    vec2 uv = (blockOrigin + float(i) * bv) / resolution;\n    float w = cos((float(i) + 0.5) * freq);\n    sum += w * factor * readTexel(uv);\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = rgbmEncode(dctForward(gl_FragCoord.xy, resolution, isVert, blockSize));\n}\n";

var fwdY = "precision highp float;\n#define GLSLIFY 1\n\n// Decode a YM-encoded vec4 back to a single float.\n// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.\n#define RGBM_MAX 4.0\n\nfloat ymDecode(vec4 enc) {\n  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel\n  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]\n  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale\n}\n\n// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.\n// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.\n// B and A are unused (set to 1.0). Decode with ymDecode.\n#define RGBM_MAX 4.0\n\nvec4 ymEncode(float lum) {\n  float mv = clamp(abs(lum), 0.01, RGBM_MAX);\n  float norm = lum / mv;\n  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);\n}\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nfloat readTexel(vec2 uv) { return ymDecode(texture2D(inputTexture, uv)); }\n\n#define PI 3.14159265\n\n// 1D forward DCT, scalar (Y-only) variant. Same math as dct-forward.glsl but\n// operates on a single float channel — cheaper inner loop for luminance-only processing.\n// The caller injects readTexel(vec2 uv) → float.\nfloat dctForwardY(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize) {\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n\n  float freq = floor(mod(dot(bv, fragCoord), float(blockSize))) / float(bs) * PI;\n  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);\n\n  float sum = 0.0;\n  for (int i = 0; i < 1024; i++) {\n    if (bs <= i) break;\n    vec2 uv = (blockOrigin + float(i) * bv) / resolution;\n    float w = cos((float(i) + 0.5) * freq);\n    sum += w * factor * readTexel(uv);\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = ymEncode(dctForwardY(gl_FragCoord.xy, resolution, isVert, blockSize));\n}\n";

var invColor = "precision highp float;\n#define GLSLIFY 1\n\n// Decode an RGBM-encoded vec4 back to its original high-range values.\n// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.\n#define RGBM_MAX 4.0\n\nvec4 rgbmDecode(vec4 enc) {\n  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha\n  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]\n  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale\n}\n\n// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.\n//\n// The three colour channels are normalized by their maximum absolute value (the \"M\"),\n// then sqrt-companded to concentrate precision near zero.\n// The scale factor M is stored in alpha after its own sqrt-compand.\n//\n// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.\n// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless\n// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.\n//\n// Decode with rgbmDecode.\n#define RGBM_MAX 4.0\n\nvec4 rgbmEncode(vec4 val) {\n  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));\n  mv = clamp(mv, 0.01, RGBM_MAX);\n  vec3 nrm = val.xyz / mv;\n  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage\n  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));\n}\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nvec4 readTexel(vec2 uv) { return rgbmDecode(texture2D(inputTexture, uv)); }\n\n// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().\n#define DCTLIVE_WAVE_BODY return cos(angle);\nfloat wave(float angle) { DCTLIVE_WAVE_BODY }\n\n#define PI 3.14159265\n\n// 1D inverse DCT for one output pixel (one fragment = one spatial position).\n// The caller injects:\n//   readTexel(vec2 uv) -> vec4  -- read a coefficient; handles any codec wrapping\n//   wave(float angle) -> float  -- the reconstruction basis function (normally cos)\n//\n// lpf: low-pass filter limit -- only the first `lpf` frequency bins are summed.\n//   lpf = blockSize: full reconstruction.  lpf = 1: DC only (flat coloured blocks).\n//\n// The fragment's position within its block is `delta` (0 to blockSize-1).\n// Each frequency bin k contributes: F[k] * wave(delta * k * PI / N)\nvec4 dctInverse(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize, float lpf) {\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(bs), lpf));\n\n  float delta = mod(dot(bv, fragCoord), float(blockSize));\n\n  vec4 sum = vec4(0.0);\n  for (int i = 0; i < 1024; i++) {\n    if (loopLimit <= i) break;\n    float fdelta = float(i);\n    vec4 val = readTexel((blockOrigin + bv * fdelta) / resolution);\n    sum += wave(delta * fdelta / float(bs) * PI) * val;\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = rgbmEncode(dctInverse(gl_FragCoord.xy, resolution, isVert, blockSize, lpf));\n}\n";

var invY = "precision highp float;\n#define GLSLIFY 1\n\n// Decode a YM-encoded vec4 back to a single float.\n// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.\n#define RGBM_MAX 4.0\n\nfloat ymDecode(vec4 enc) {\n  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel\n  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]\n  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale\n}\n\n// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.\n// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.\n// B and A are unused (set to 1.0). Decode with ymDecode.\n#define RGBM_MAX 4.0\n\nvec4 ymEncode(float lum) {\n  float mv = clamp(abs(lum), 0.01, RGBM_MAX);\n  float norm = lum / mv;\n  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);\n}\n\nuniform vec2 resolution;\nuniform bool isVert;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nfloat readTexel(vec2 uv) { return ymDecode(texture2D(inputTexture, uv)); }\n\n// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().\n#define DCTLIVE_WAVE_BODY return cos(angle);\nfloat wave(float angle) { DCTLIVE_WAVE_BODY }\n\n#define PI 3.14159265\n\n// 1D inverse DCT, scalar (Y-only) variant. Same math as dct-inverse.glsl but\n// accumulates a single float -- cheaper inner loop for luminance-only reconstruction.\n// The caller injects readTexel(vec2 uv) -> float and wave(float) -> float.\nfloat dctInverseY(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize, float lpf) {\n  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);\n  vec2 block = bv * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;\n  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(bs), lpf));\n\n  float delta = mod(dot(bv, fragCoord), float(blockSize));\n\n  float sum = 0.0;\n  for (int i = 0; i < 1024; i++) {\n    if (loopLimit <= i) break;\n    float fdelta = float(i);\n    float lum = readTexel((blockOrigin + bv * fdelta) / resolution);\n    sum += wave(delta * fdelta / float(bs) * PI) * lum;\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = ymEncode(dctInverseY(gl_FragCoord.xy, resolution, isVert, blockSize, lpf));\n}\n";

var quantColor = "precision highp float;\n#define GLSLIFY 1\n\n// Decode an RGBM-encoded vec4 back to its original high-range values.\n// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.\n#define RGBM_MAX 4.0\n\nvec4 rgbmDecode(vec4 enc) {\n  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha\n  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]\n  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale\n}\n\n// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.\n//\n// The three colour channels are normalized by their maximum absolute value (the \"M\"),\n// then sqrt-companded to concentrate precision near zero.\n// The scale factor M is stored in alpha after its own sqrt-compand.\n//\n// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.\n// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless\n// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.\n//\n// Decode with rgbmDecode.\n#define RGBM_MAX 4.0\n\nvec4 rgbmEncode(vec4 val) {\n  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));\n  mv = clamp(mv, 0.01, RGBM_MAX);\n  vec3 nrm = val.xyz / mv;\n  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage\n  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));\n}\n\n// Round `value` to the nearest multiple of `step`.\n// step=0 means no quantization (caller should guard against this).\nfloat quantize(float value, float step) {\n  return floor(value / step + 0.5) * step;\n}\n\n// Quantize a vec4 DCT coefficient (Y, Cb, Cr, A channels independently).\n// `len` is the Euclidean distance from the block's DC corner to this frequency bin —\n// used to scale the step size up for high-frequency coefficients (mimics JPEG's\n// quantization matrix). highFreqMultiplier amplifies the coefficient itself first.\nvec4 quantizeCoeff(vec4 coeff, float len, float highFreqMultiplier,\n    float qY, float qYf, float qC, float qCf, float qA, float qAf) {\n  coeff *= 1.0 + len * highFreqMultiplier;\n\n  float stepY = qY + qYf * len;\n  coeff.x = stepY > 0.0 ? quantize(coeff.x, stepY) : coeff.x;\n\n  float stepC = qC + qCf * len;\n  coeff.y = stepC > 0.0 ? quantize(coeff.y, stepC) : coeff.y;\n  coeff.z = stepC > 0.0 ? quantize(coeff.z, stepC) : coeff.z;\n\n  float stepA = qA + qAf * len;\n  coeff.w = stepA > 0.0 ? quantize(coeff.w, stepA) : coeff.w;\n\n  return coeff;\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\nuniform float quantizeC;\nuniform float quantizeCf;\nuniform float quantizeA;\nuniform float quantizeAf;\n\nvoid main() {\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n  vec4 coeff = rgbmDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));\n  gl_FragColor = rgbmEncode(quantizeCoeff(coeff, len, highFreqMultiplier,\n    quantizeY, quantizeYf, quantizeC, quantizeCf, quantizeA, quantizeAf));\n}\n";

var quantY = "precision highp float;\n#define GLSLIFY 1\n\n// Decode a YM-encoded vec4 back to a single float.\n// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.\n#define RGBM_MAX 4.0\n\nfloat ymDecode(vec4 enc) {\n  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel\n  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]\n  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale\n}\n\n// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.\n// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.\n// B and A are unused (set to 1.0). Decode with ymDecode.\n#define RGBM_MAX 4.0\n\nvec4 ymEncode(float lum) {\n  float mv = clamp(abs(lum), 0.01, RGBM_MAX);\n  float norm = lum / mv;\n  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);\n}\n\n// Round `value` to the nearest multiple of `step`.\n// step=0 means no quantization (caller should guard against this).\nfloat quantize(float value, float step) {\n  return floor(value / step + 0.5) * step;\n}\n\n// Quantize a single float luminance DCT coefficient.\n// Scalar version of quantizeCoeff — used in Y-only mode where chroma/alpha are absent.\nfloat quantizeCoeffY(float lum, float len, float highFreqMultiplier, float qY, float qYf) {\n  lum *= 1.0 + len * highFreqMultiplier;\n  float stepY = qY + qYf * len;\n  return stepY > 0.0 ? quantize(lum, stepY) : lum;\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\n\nvoid main() {\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n  float lum = ymDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));\n  gl_FragColor = ymEncode(quantizeCoeffY(lum, len, highFreqMultiplier, quantizeY, quantizeYf));\n}\n";

var colorInColor = "precision highp float;\n#define GLSLIFY 1\n\n// ITU-R BT.601: convert linear RGB (0–1) to YCbCr.\n// Y  = luminance.  Cb = blue-difference chroma.  Cr = red-difference chroma.\n// The chroma channels are centred on zero (neutral grey = 0, not 0.5).\nvec3 rgb2ycbcr(vec3 rgb) {\n  return vec3(\n     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,\n    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,\n     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b\n  );\n}\n\n// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.\n//\n// The three colour channels are normalized by their maximum absolute value (the \"M\"),\n// then sqrt-companded to concentrate precision near zero.\n// The scale factor M is stored in alpha after its own sqrt-compand.\n//\n// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.\n// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless\n// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.\n//\n// Decode with rgbmDecode.\n#define RGBM_MAX 4.0\n\nvec4 rgbmEncode(vec4 val) {\n  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));\n  mv = clamp(mv, 0.01, RGBM_MAX);\n  vec3 nrm = val.xyz / mv;\n  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage\n  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec4 color = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n  color.rgb = rgb2ycbcr(color.rgb);\n  gl_FragColor = rgbmEncode(color);\n}\n";

var colorInY = "precision highp float;\n#define GLSLIFY 1\n\n// ITU-R BT.601: convert linear RGB (0–1) to YCbCr.\n// Y  = luminance.  Cb = blue-difference chroma.  Cr = red-difference chroma.\n// The chroma channels are centred on zero (neutral grey = 0, not 0.5).\nvec3 rgb2ycbcr(vec3 rgb) {\n  return vec3(\n     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,\n    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,\n     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b\n  );\n}\n\n// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.\n// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.\n// B and A are unused (set to 1.0). Decode with ymDecode.\n#define RGBM_MAX 4.0\n\nvec4 ymEncode(float lum) {\n  float mv = clamp(abs(lum), 0.01, RGBM_MAX);\n  float norm = lum / mv;\n  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec4 color = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n  float y = rgb2ycbcr(color.rgb).x;\n  gl_FragColor = ymEncode(y);\n}\n";

var colorOutColor = "precision highp float;\n#define GLSLIFY 1\n\n// Decode an RGBM-encoded vec4 back to its original high-range values.\n// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.\n#define RGBM_MAX 4.0\n\nvec4 rgbmDecode(vec4 enc) {\n  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha\n  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]\n  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale\n}\n\n// ITU-R BT.601 inverse: YCbCr → linear RGB.\n// Exact inverse of rgb2ycbcr — chroma channels are zero-centred.\nvec3 ycbcr2rgb(vec3 yuv) {\n  return vec3(\n    yuv.x + 1.402    * yuv.z,\n    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,\n    yuv.x + 1.772    * yuv.y\n  );\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec4 color = rgbmDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));\n  color.rgb = ycbcr2rgb(color.rgb);\n  gl_FragColor = color;\n}\n";

var colorOutY = "precision highp float;\n#define GLSLIFY 1\n\n// Decode a YM-encoded vec4 back to a single float.\n// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.\n#define RGBM_MAX 4.0\n\nfloat ymDecode(vec4 enc) {\n  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel\n  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]\n  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  float lum = ymDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));\n  gl_FragColor = vec4(lum, lum, lum, 1.0);\n}\n";

class RenderPipeline8bit extends RenderPipeline {
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

class DisplayController {
  constructor(canvas) {
    this.canvas = canvas;
    this._flipY = true;  // Default: texture flipped on upload, no CSS flip needed
  }

  show() { this.canvas.style.display = ''; }
  hide() { this.canvas.style.display = 'none'; }

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
    if (width  != null) this.canvas.style.width  = typeof width  === 'number' ? `${width}px`  : width;
    if (height != null) this.canvas.style.height = typeof height === 'number' ? `${height}px` : height;
  }

  set flipY(val) {
    this._flipY = !!val;
  }

  get flipY() { return this._flipY; }
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

// Quantize uniforms are user-facing 0–1 values that are squared before reaching the shader.
// The quadratic curve gives finer perceptual control at low values (where the difference
// between "barely quantizing" and "clearly quantizing" is most noticeable) and coarser
// steps at the high end. e.g. user input 0.5 → shader receives 0.25.
function normalizeQuantize(name, value) {
  if (QUANTIZE_PROPS.has(name) && typeof value === 'number') {
    const t = Math.min(Math.max(value, 0), 1);
    return t * t;
  }
  return value;
}

/** Central store for all shader uniforms and frame-rate control. */
class ShaderConfig {
  constructor() {
    this.uniforms = { ...DEFAULT_UNIFORMS };
    this._fps = 0;
    this._frameInterval = 0;
  }

  /**
   * Set a single named uniform. Warns if the name is unknown.
   * @param {string} name
   * @param {number|boolean|function} value - Scalar, bool, or zero-arg function returning a value.
   */
  setUniform(name, value) {
    if (!(name in this.uniforms)) {
      console.warn(`ShaderConfig: unknown uniform "${name}"`);
    }
    this.uniforms[name] = value;
  }

  /** Set multiple uniforms at once from a plain object. */
  setUniforms(obj) {
    for (const key in obj) {
      this.setUniform(key, obj[key]);
    }
  }

  /**
   * Resolve a uniform value for upload to the GPU.
   * Calls function-valued uniforms, applies quadratic scaling to quantize props,
   * and falls back to the default if the value is undefined.
   * @param {string} name
   * @returns {number|boolean}
   */
  resolveUniform(name) {
    const current = this.uniforms[name];
    const value = typeof current === 'function' ? current() : current;
    const resolved = value === undefined ? DEFAULT_UNIFORMS[name] : normalizeQuantize(name, value);
    // Clamp blockSize to a safe range — zero or negative causes GPU divide-by-zero in the shader.
    if (name === 'blockSize') return Math.max(1, Math.min(1024, Math.floor(resolved)));
    return resolved;
  }

  /**
   * Returns true if any quantization or high-frequency parameter is non-zero.
   * Used to skip the quantize render pass entirely when it would be a no-op.
   */
  isQuantizeActive() {
    const u = this.uniforms;
    return u.highFreqMultiplier !== 0 ||
      u.quantizeY !== 0 || u.quantizeYf !== 0 ||
      u.quantizeC !== 0 || u.quantizeCf !== 0 ||
      u.quantizeA !== 0 || u.quantizeAf !== 0;
  }

  /** Set frame rate. 0 = unlimited. */
  setFPS(fps) {
    this._fps = Math.max(0, Number(fps) || 0);
    this._frameInterval = this._fps > 0 ? 1000 / this._fps : 0;
  }

  get fps() { return this._fps; }
  set fps(value) { this.setFPS(value); }

  get frameInterval() { return this._frameInterval; }
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
   * @param {number}  [opts.width=256]     - Canvas / processing width in pixels
   * @param {number}  [opts.height=256]    - Canvas / processing height in pixels
   * @param {boolean} [opts.loop=true]     - Continuously re-render on each animation frame
   * @param {'16bit'|'32bit'|'8bit'} [opts.precision='16bit'] - Float texture precision.
   *   Falls back along the chain 32→16→8 if the hardware doesn't support the requested mode.
   * @param {HTMLCanvasElement} [opts.canvas] - Use an existing canvas instead of creating one
   */
  constructor(opts = {}) {
    this.width = opts.width || 256;
    this.height = opts.height || 256;
    this._looping = false;
    this._rafId = null;
    this._lastFrameTime = null;

    this.canvas = opts.canvas || document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    const gl = this.canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // Resolve texture precision (default '16bit', fallback chain: 16→8 or 32→16→8)
    const { type: texType, actual: precision } = resolveTexType(gl, opts.precision || '16bit');
    this._precision = precision;

    const Pipeline = precision === '8bit' ? RenderPipeline8bit : RenderPipeline;
    this._pipeline = new Pipeline(gl, this.width, this.height, texType);
    this._display = new DisplayController(this.canvas);
    this._config = new ShaderConfig();

    // DCT/IDCT pass control
    this.dctHorizontal  = true;
    this.dctVertical    = true;
    this.idctHorizontal = true;
    this.idctVertical   = true;

    this.input = new InputSource(gl, this.width, this.height);

    // Shorthand properties (e.g. dct.qY) that proxy to the uniform store.
    // Note: quantize uniforms (qY, qC, etc.) are squared before reaching the shader —
    // user input of 0–1 maps to a quadratic curve for perceptual control.
    this._defineShorthandProperties();

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

    // yOnly has special behaviour: swaps shader programs in the pipeline
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

  // ---- Public getters — delegate to internal modules ----

  get uniforms()   { return this._config.uniforms; }
  get precision()  { return this._precision; }

  get flipY()      { return this._display.flipY; }
  set flipY(value) {
    this._display.flipY = value;
    this.input.flipY = value;
  }

  get fps()        { return this._config.fps; }
  set fps(value)   { this._config.fps = value; }

  // ---- Image / source loading ----

  /**
   * Load an image from a URL or set an HTMLImageElement as input.
   * @param {string|HTMLImageElement} source - URL string or image element
   * @param {Object} [opts] - { fit, minFilter, magFilter, wrap }
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
   * @param {Object} [opts] - { fit, minFilter, magFilter, wrap }
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

  setUniform(name, value) { this._config.setUniform(name, value); }
  setUniforms(obj)        { this._config.setUniforms(obj); }

  // ---- Wave function ----

  /**
   * Replace the wave function used during inverse DCT reconstruction.
   * Triggers a recompile of the inverse shader programs.
   * @param {string} glslBody - GLSL function body, e.g. "return cos(angle);"
   *   Available variables: `angle` (float), `time` (float, ms), `wi` (float, waveInput uniform)
   */
  setWaveFunction(glslBody) { this._pipeline.setWaveFunction(glslBody); }

  /** Reset the wave function to the default cosine. */
  resetWaveFunction() { this._pipeline.resetWaveFunction(); }

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
  resizeCanvas(width, height) { this._display.setSize(width, height); }

  /**
   * Control which forward DCT passes run (spatial → frequency domain).
   * Disabling both lets you feed any image into the IDCT as raw coefficient data.
   * Vertical defaults to the same as horizontal if not explicitly set.
   * @param {boolean} [horizontal=true]
   * @param {boolean} [vertical=undefined]
   */
  setDCT(horizontal = true, vertical = undefined) {
    this.dctHorizontal = !!horizontal;
    this.dctVertical = vertical !== undefined ? !!vertical : this.dctHorizontal;
  }

  /**
   * Control which inverse DCT passes run (frequency → spatial domain).
   * Disabling both lets you visualise raw DCT coefficients directly.
   * Vertical defaults to the same as horizontal if not explicitly set.
   * @param {boolean} [horizontal=true]
   * @param {boolean} [vertical=undefined]
   */
  setIDCT(horizontal = true, vertical = undefined) {
    this.idctHorizontal = !!horizontal;
    this.idctVertical = vertical !== undefined ? !!vertical : this.idctHorizontal;
  }

  // ---- Rendering ----

  /** Run the DCT/IDCT pipeline once. */
  run() {
    if (!this.input.texture) return;
    this.input.update();
    this._pipeline.render({
      inputTexture:   this.input.texture,
      uvScale:        this.input.uvScale,
      uvOffset:       this.input.uvOffset,
      wrap:           this.input.effectiveWrap,
      dctHorizontal:  this.dctHorizontal,
      dctVertical:    this.dctVertical,
      idctHorizontal: this.idctHorizontal,
      idctVertical:   this.idctVertical,
      quantizeActive: this._config.isQuantizeActive(),
      flipY:          this.input.flipY,
      resolveUniform: (name) => this._config.resolveUniform(name),
    });
  }

  // ---- Loop control ----

  /** Start the render loop. */
  start() {
    if (this._looping) return;
    this._looping = true;
    this._lastFrameTime = null;
    const loop = (timestamp) => {
      if (!this._looping) return;
      const frameInterval = this._config.frameInterval;
      if (this._lastFrameTime === null) {
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

  /** Stop the render loop. */
  stop() {
    this._looping = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // ---- Display ----

  /** Show the canvas. */
  show() { this._display.show(); }

  /** Hide the canvas. */
  hide() { this._display.hide(); }

  /**
   * Append the canvas into a DOM parent.
   * @param {HTMLElement} parent
   */
  mount(parent = document.body) { this._display.mount(parent); }

  /** Remove the canvas from the DOM. */
  unmount() { this._display.unmount(); }

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
    this.dctHorizontal  = true;
    this.dctVertical    = true;
    this.idctHorizontal = true;
    this.idctVertical   = true;
  }

  /** Clean up WebGL resources. */
  destroy() {
    this.stop();
    this.hide();
    this._pipeline.destroy();
    this.input.destroy();
  }
}

export { InputSource, DCTLive as default };
