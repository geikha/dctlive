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
      if (this._source && this.texture) {
        this._uploadTexture();
      }
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

    loadVideo(url, opts = {}) {
      if (opts) this.setOptions(opts);
      return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.src = url;
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
          this._setSource(video, true);
          video.play().catch(() => {});
          resolve(video);
        };
        const onError = (e) => {
          cleanup();
          reject(new Error(`Failed to load video: ${url} — ${e.message || 'unknown error'}`));
        };
        video.addEventListener('loadeddata', onLoaded);
        video.addEventListener('error', onError);
      });
    }

    setCanvas(canvas, opts = {}) {
      if (opts) this.setOptions(opts);
      this._setSource(_resolveCanvas(canvas), true);
    }

    async initCam(selector = 0, opts = {}) {
      if (opts) this.setOptions(opts);
      const cameras = await _enumerateCameras();
      let device;
      if (typeof selector === 'number') {
        device = cameras[selector];
      } else if (typeof selector === 'string') {
        device = cameras.find(d => d.label === selector)
          || cameras.find(d => d.label.toLowerCase().includes(selector.toLowerCase()));
      }
      const constraints = opts.constraints || {
        video: device
          ? { deviceId: { exact: device.deviceId }, width: { ideal: this.targetWidth }, height: { ideal: this.targetHeight } }
          : { width: { ideal: this.targetWidth }, height: { ideal: this.targetHeight } },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      return new Promise((resolve) => {
        const onLoaded = () => {
          video.removeEventListener('loadeddata', onLoaded);
          this._setSource(video, true);
          resolve(video);
        };
        video.addEventListener('loadeddata', onLoaded, { once: true });
        video.play().catch(() => {});
      });
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

  function _resolveCanvas(input) {
    if (input instanceof HTMLCanvasElement) return input;
    if (input instanceof CanvasRenderingContext2D) return input.canvas;
    if (input?.src instanceof HTMLCanvasElement) return input.src;
    if (input?.src instanceof CanvasRenderingContext2D) return input.src.canvas;
    if (input?.canvas instanceof HTMLCanvasElement) return input.canvas;
    if (input?.canvas instanceof CanvasRenderingContext2D) return input.canvas.canvas;
    if (typeof input?.getContext === 'function') return input;
    throw new Error('setCanvas: expected HTMLCanvasElement, CanvasRenderingContext2D, or a Hydra-style wrapper');
  }

  async function _enumerateCameras() {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let cameras = devices.filter(d => d.kind === 'videoinput');
    if (!cameras.some(d => d.deviceId)) {
      const temp = await navigator.mediaDevices.getUserMedia({ video: true });
      temp.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      cameras = devices.filter(d => d.kind === 'videoinput');
    }
    return cameras;
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

  var passthroughFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\n#define DCTLIVE_FLIP_UV 0\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  #if DCTLIVE_FLIP_UV == 1\n  uv.y = 1.0 - uv.y;\n  #endif\n  gl_FragColor = texture2D(inputTexture, uv);\n}\n";

  var blitClampFrag = "precision highp float;\n#define GLSLIFY 1\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, uv * uvScale + uvOffset);\n}\n";

  var blitRepeatFrag = "precision highp float;\n#define GLSLIFY 1\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  gl_FragColor = texture2D(inputTexture, fract(uv * uvScale + uvOffset));\n}\n";

  var blitMirrorFrag = "precision highp float;\n#define GLSLIFY 1\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  uv = uv * uvScale + uvOffset;\n  vec2 t = fract(uv * 0.5) * 2.0;\n  uv = 1.0 - abs(t - 1.0);\n  gl_FragColor = texture2D(inputTexture, uv);\n}\n";

  var blitMaskFrag = "precision highp float;\n#define GLSLIFY 1\nuniform sampler2D inputTexture;\nuniform vec2 resolution;\nuniform vec2 uvScale;\nuniform vec2 uvOffset;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  uv = uv * uvScale + uvOffset;\n  vec2 inBounds = step(vec2(0.0), uv) * step(uv, vec2(1.0));\n  float mask = inBounds.x * inBounds.y;\n  gl_FragColor = texture2D(inputTexture, uv) * mask;\n}\n";

  var colorInFrag = "precision highp float;\n#define GLSLIFY 1\n\n// ITU-R BT.601: convert linear RGB (0–1) to YCbCr.\n// Y  = luminance.  Cb = blue-difference chroma.  Cr = red-difference chroma.\n// The chroma channels are centred on zero (neutral grey = 0, not 0.5).\nvec3 rgb2ycbcr(vec3 rgb) {\n  return vec3(\n     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,\n    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,\n     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b\n  );\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec4 color = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n  color.rgb = rgb2ycbcr(color.rgb);\n  gl_FragColor = color;\n}\n";

  var colorOutFrag = "precision highp float;\n#define GLSLIFY 1\n\n// ITU-R BT.601 inverse: YCbCr → linear RGB.\n// Exact inverse of rgb2ycbcr — chroma channels are zero-centred.\nvec3 ycbcr2rgb(vec3 yuv) {\n  return vec3(\n    yuv.x + 1.402    * yuv.z,\n    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,\n    yuv.x + 1.772    * yuv.y\n  );\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\n#define DCTLIVE_FLIP_UV 0\n#define DCTLIVE_Y_ONLY 0\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  #if DCTLIVE_FLIP_UV == 1\n  uv.y = 1.0 - uv.y;\n  #endif\n  vec4 color = texture2D(inputTexture, uv);\n\n  #if DCTLIVE_Y_ONLY == 1\n  color.rgb = vec3(color.x);\n  color.a = 1.0;\n  #else\n  color.rgb = ycbcr2rgb(color.rgb);\n  #endif\n\n  gl_FragColor = color;\n}\n";

  var forwardFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nvec4 readTexel(vec2 uv) { return texture2D(inputTexture, uv); }\n\n#define PI 3.14159265\n#define DCTLIVE_IS_VERT 0\n\n// 1D forward DCT: compute one frequency coefficient F[k] for a spatial block.\n//\n// This fragment's output position determines which frequency bin it represents.\n// Formula: F[k] = scale * Σ(n=0..N-1) x[n] * cos((n+0.5)*k*π/N)\n//   k: frequency index (0=DC, 1..N-1=harmonics) within the block\n//   x[n]: input sample at spatial position n in the block\n//   N: effective block size (clamped to image boundary)\n//   scale: DCT-II orthonormal factor (1/N for DC, 2/N for harmonics)\n//\n// Injected by caller:\n//   readTexel(vec2 uv) -> vec4  -- read input sample; handles any codec wrapping (see 8 bit versions)\nvec4 dctForward(vec2 fragCoord, vec2 resolution, int blockSize) {\n  // Scan direction: horizontal (freq along x) or vertical (freq along y)\n  #if DCTLIVE_IS_VERT == 1\n  vec2 direction = vec2(0.0, 1.0);\n  #else\n  vec2 direction = vec2(1.0, 0.0);\n  #endif\n\n  // Locate the block containing this fragment.\n  // blockStride: distance (in texels) between consecutive block starts in this direction\n  // blockCorner: position of the top-left corner of this fragment's block\n  // N: effective block size, clamped to image boundary (may be < blockSize at edges)\n  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);\n  vec2 blockCorner = 0.5 + floor(fragCoord / blockStride) * blockStride;\n  int N = int(min(float(blockSize), dot(direction, resolution - blockCorner + 0.5)));\n\n  // Compute this fragment's frequency index (0 to N-1), then scale to [0, π]\n  float freq = floor(mod(dot(direction, fragCoord), float(blockSize))) / float(N) * PI;\n\n  // DCT-II orthonormal scaling: 1/N for DC (freq≈0), 2/N for harmonics.\n  // Using branchless step() to avoid GPU branch prediction penalty.\n  float scale = (1.0 + step(0.001, abs(freq))) / float(N);\n\n  vec4 sum = vec4(0.0);\n  for (int n = 0; n < 1024; n++) {\n    if (N <= n) break;\n    vec2 sampleUv = (blockCorner + float(n) * direction) / resolution;\n    float basis = cos((float(n) + 0.5) * freq);\n    sum += basis * scale * readTexel(sampleUv);\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = dctForward(gl_FragCoord.xy, resolution, blockSize);\n}\n";

  var forwardYFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nfloat readTexel(vec2 uv) { return texture2D(inputTexture, uv).x; }\n\n#define PI 3.14159265\n#define DCTLIVE_IS_VERT 0\n\n// Scalar variant of dctForward (see dct-forward.glsl for full documentation).\n// Same math, outputs float instead of vec4. Cheaper for luminance-only processing.\nfloat dctForwardY(vec2 fragCoord, vec2 resolution, int blockSize) {\n  #if DCTLIVE_IS_VERT == 1\n  vec2 direction = vec2(0.0, 1.0);\n  #else\n  vec2 direction = vec2(1.0, 0.0);\n  #endif\n\n  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);\n  vec2 blockCorner = 0.5 + floor(fragCoord / blockStride) * blockStride;\n  int N = int(min(float(blockSize), dot(direction, resolution - blockCorner + 0.5)));\n\n  float k = floor(mod(dot(direction, fragCoord), float(blockSize))) / float(N) * PI;\n  float scale = (1.0 + step(0.001, abs(k))) / float(N);\n\n  float sum = 0.0;\n  for (int n = 0; n < 1024; n++) {\n    if (N <= n) break;\n    vec2 sampleUv = (blockCorner + float(n) * direction) / resolution;\n    float basis = cos((float(n) + 0.5) * k);\n    sum += basis * scale * readTexel(sampleUv);\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = vec4(dctForwardY(gl_FragCoord.xy, resolution, blockSize), 0.0, 0.0, 1.0);\n}\n";

  var inverseFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nvec4 readTexel(vec2 uv) { return texture2D(inputTexture, uv); }\n\n// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().\n#define DCTLIVE_WAVE_BODY return cos(angle);\nfloat wave(float angle) { DCTLIVE_WAVE_BODY }\n\n#define PI 3.14159265\n// 0 = horizontal pass, 1 = vertical pass. Injected by shader provider via patchDefines.\n#define DCTLIVE_IS_VERT 0\n\n// 1D inverse DCT: reconstruct one spatial output pixel from frequency coefficients.\n//\n// This fragment's output position determines which spatial position it reconstructs.\n// Formula: x[delta] = Σ(k=0..N-1) F[k] * wave(delta*k*π/N)\n//   delta: spatial position within block (0 to N-1), read from fragment position\n//   F[k]: frequency coefficient at index k (read from input texture)\n//   N: effective block size (clamped to image boundary)\n//   wave(angle): reconstruction basis function (normally cos for DCT-II)\n//   lpf: low-pass filter limit (only sum k from 0 to min(lpf, N-1))\n//\n// Injected by caller:\n//   readTexel(vec2 uv) -> vec4  -- read coefficient; handles any codec wrapping (see 8 bit versions)\n//   wave(float angle) -> float  -- the reconstruction basis function, cos() by default\nvec4 dctInverse(vec2 fragCoord, vec2 resolution, int blockSize, float lpf) {\n  // Scan direction: horizontal (reconstruct spatial X) or vertical (reconstruct spatial Y)\n  #if DCTLIVE_IS_VERT == 1\n  vec2 direction = vec2(0.0, 1.0);\n  #else\n  vec2 direction = vec2(1.0, 0.0);\n  #endif\n\n  // Locate the block containing this fragment.\n  // blockStride: distance (in texels) between consecutive block starts in this direction\n  // blockOrigin: position of the top-left corner of this fragment's block\n  // N: effective block size, clamped to image boundary (may be < blockSize at edges)\n  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / blockStride) * blockStride;\n  int N = int(min(float(blockSize), dot(direction, resolution - blockOrigin + 0.5)));\n\n  // Limit reconstruction to the first `loopLimit` frequency bins (low-pass filter).\n  // loopLimit = 1: DC only. loopLimit = N: full reconstruction.\n  int loopLimit = int(min(float(N), lpf));\n\n  // This fragment's spatial position within its block (0 to N-1), scaled to [0, π]\n  float delta = mod(dot(direction, fragCoord), float(blockSize)) / float(N) * PI;\n\n  vec4 sum = vec4(0.0);\n  for (int k = 0; k < 1024; k++) {\n    if (loopLimit <= k) break;\n    vec4 coeff = readTexel((blockOrigin + direction * float(k)) / resolution);\n    sum += wave(delta * float(k)) * coeff;\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = dctInverse(gl_FragCoord.xy, resolution, blockSize, lpf);\n}\n";

  var inverseYFrag = "precision highp float;\n#define GLSLIFY 1\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nfloat readTexel(vec2 uv) { return texture2D(inputTexture, uv).x; }\n\n// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().\n#define DCTLIVE_WAVE_BODY return cos(angle);\nfloat wave(float angle) { DCTLIVE_WAVE_BODY }\n\n#define PI 3.14159265\n// 0 = horizontal pass, 1 = vertical pass. Injected by shader provider via patchDefines.\n#define DCTLIVE_IS_VERT 0\n\n// Scalar variant of dctInverse (see dct-inverse.glsl for full documentation).\n// Same math, outputs float instead of vec4. Cheaper for luminance-only reconstruction.\nfloat dctInverseY(vec2 fragCoord, vec2 resolution, int blockSize, float lpf) {\n  #if DCTLIVE_IS_VERT == 1\n  vec2 direction = vec2(0.0, 1.0);\n  #else\n  vec2 direction = vec2(1.0, 0.0);\n  #endif\n\n  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / blockStride) * blockStride;\n  int N = int(min(float(blockSize), dot(direction, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(N), lpf));\n\n  float delta = mod(dot(direction, fragCoord), float(blockSize)) / float(N) * PI;\n\n  float sum = 0.0;\n  for (int k = 0; k < 1024; k++) {\n    if (loopLimit <= k) break;\n    float coeff = readTexel((blockOrigin + direction * float(k)) / resolution);\n    sum += wave(delta * float(k)) * coeff;\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = vec4(dctInverseY(gl_FragCoord.xy, resolution, blockSize, lpf), 0.0, 0.0, 1.0);\n}\n";

  var quantizeFrag = "precision highp float;\n#define GLSLIFY 1\n\n// Round value to the nearest multiple of stepSize.\n// stepSize=0 is safe — clamped to 1e-6 to avoid division by zero.\nfloat quantize(float value, float stepSize) {\n  float s = max(stepSize, 1e-6);\n  return floor(value / s + 0.5) * s;\n}\n\n// Quantize a vec4 DCT coefficient (Y, Cb, Cr, A channels independently).\n// `len` is the Euclidean distance from the block's DC corner to this frequency bin —\n// used to scale the step size up for high-frequency coefficients (mimics JPEG's\n// quantization matrix). highFreqMultiplier amplifies the coefficient itself first.\nvec4 quantizeCoeff(vec4 coeff, float len, float highFreqMultiplier,\n    float qY, float qYf, float qC, float qCf, float qA, float qAf) {\n  coeff *= 1.0 + len * highFreqMultiplier;\n\n  coeff.x = quantize(coeff.x, qY + qYf * len);\n  coeff.y = quantize(coeff.y, qC + qCf * len);\n  coeff.z = quantize(coeff.z, qC + qCf * len);\n  coeff.w = quantize(coeff.w, qA + qAf * len);\n\n  return coeff;\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\nuniform float quantizeC;\nuniform float quantizeCf;\nuniform float quantizeA;\nuniform float quantizeAf;\n\nvoid main() {\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n  vec4 coeff = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n  gl_FragColor = quantizeCoeff(coeff, len, highFreqMultiplier,\n    quantizeY, quantizeYf, quantizeC, quantizeCf, quantizeA, quantizeAf);\n}\n";

  var quantizeYFrag = "precision highp float;\n#define GLSLIFY 1\n\n// Round value to the nearest multiple of stepSize.\n// stepSize=0 is safe — clamped to 1e-6 to avoid division by zero.\nfloat quantize(float value, float stepSize) {\n  float s = max(stepSize, 1e-6);\n  return floor(value / s + 0.5) * s;\n}\n\n// Quantize a single float luminance DCT coefficient.\n// Scalar version of quantizeCoeff — used in Y-only mode where chroma/alpha are absent.\nfloat quantizeCoeffY(float lum, float len, float highFreqMultiplier, float qY, float qYf) {\n  lum *= 1.0 + len * highFreqMultiplier;\n  return quantize(lum, qY + qYf * len);\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\n\nvoid main() {\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n  float lum = texture2D(inputTexture, gl_FragCoord.xy / resolution).x;\n  gl_FragColor = vec4(quantizeCoeffY(lum, len, highFreqMultiplier, quantizeY, quantizeYf), 0.0, 0.0, 1.0);\n}\n";

  var colorInColor = "precision highp float;\n#define GLSLIFY 1\n\n// ITU-R BT.601: convert linear RGB (0–1) to YCbCr.\n// Y  = luminance.  Cb = blue-difference chroma.  Cr = red-difference chroma.\n// The chroma channels are centred on zero (neutral grey = 0, not 0.5).\nvec3 rgb2ycbcr(vec3 rgb) {\n  return vec3(\n     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,\n    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,\n     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b\n  );\n}\n\n// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.\n//\n// The three colour channels are normalized by their maximum absolute value (the \"M\"),\n// then sqrt-companded to concentrate precision near zero.\n// The scale factor M is stored in alpha after its own sqrt-compand.\n//\n// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.\n// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless\n// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.\n//\n// Decode with rgbmDecode.\n#define RGBM_MAX 4.0\n\nvec4 rgbmEncode(vec4 val) {\n  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));\n  mv = clamp(mv, 0.01, RGBM_MAX);\n  vec3 nrm = val.xyz / mv;\n  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage\n  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec4 color = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n  color.rgb = rgb2ycbcr(color.rgb);\n  gl_FragColor = rgbmEncode(color);\n}\n";

  var colorInY = "precision highp float;\n#define GLSLIFY 1\n\n// ITU-R BT.601: convert linear RGB (0–1) to YCbCr.\n// Y  = luminance.  Cb = blue-difference chroma.  Cr = red-difference chroma.\n// The chroma channels are centred on zero (neutral grey = 0, not 0.5).\nvec3 rgb2ycbcr(vec3 rgb) {\n  return vec3(\n     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,\n    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,\n     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b\n  );\n}\n\n// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.\n// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.\n// B and A are unused (set to 1.0). Decode with ymDecode.\n#define RGBM_MAX 4.0\n\nvec4 ymEncode(float lum) {\n  float mv = clamp(abs(lum), 0.01, RGBM_MAX);\n  float norm = lum / mv;\n  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\nvoid main() {\n  vec4 color = texture2D(inputTexture, gl_FragCoord.xy / resolution);\n  float y = rgb2ycbcr(color.rgb).x;\n  gl_FragColor = ymEncode(y);\n}\n";

  var colorOutColor = "precision highp float;\n#define GLSLIFY 1\n\n// Decode an RGBM-encoded vec4 back to its original high-range values.\n// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.\n#define RGBM_MAX 4.0\n\nvec4 rgbmDecode(vec4 enc) {\n  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha\n  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]\n  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale\n}\n\n// ITU-R BT.601 inverse: YCbCr → linear RGB.\n// Exact inverse of rgb2ycbcr — chroma channels are zero-centred.\nvec3 ycbcr2rgb(vec3 yuv) {\n  return vec3(\n    yuv.x + 1.402    * yuv.z,\n    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,\n    yuv.x + 1.772    * yuv.y\n  );\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\n#define DCTLIVE_FLIP_UV 0\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  #if DCTLIVE_FLIP_UV == 1\n  uv.y = 1.0 - uv.y;\n  #endif\n  vec4 color = rgbmDecode(texture2D(inputTexture, uv));\n  color.rgb = ycbcr2rgb(color.rgb);\n  gl_FragColor = color;\n}\n";

  var colorOutY = "precision highp float;\n#define GLSLIFY 1\n\n// Decode a YM-encoded vec4 back to a single float.\n// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.\n#define RGBM_MAX 4.0\n\nfloat ymDecode(vec4 enc) {\n  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel\n  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]\n  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale\n}\n\nuniform vec2 resolution;\nuniform sampler2D inputTexture;\n\n#define DCTLIVE_FLIP_UV 0\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / resolution;\n  #if DCTLIVE_FLIP_UV == 1\n  uv.y = 1.0 - uv.y;\n  #endif\n  float lum = ymDecode(texture2D(inputTexture, uv));\n  gl_FragColor = vec4(lum, lum, lum, 1.0);\n}\n";

  var fwdColor = "precision highp float;\n#define GLSLIFY 1\n\n// Decode an RGBM-encoded vec4 back to its original high-range values.\n// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.\n#define RGBM_MAX 4.0\n\nvec4 rgbmDecode(vec4 enc) {\n  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha\n  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]\n  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale\n}\n\n// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.\n//\n// The three colour channels are normalized by their maximum absolute value (the \"M\"),\n// then sqrt-companded to concentrate precision near zero.\n// The scale factor M is stored in alpha after its own sqrt-compand.\n//\n// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.\n// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless\n// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.\n//\n// Decode with rgbmDecode.\n#define RGBM_MAX 4.0\n\nvec4 rgbmEncode(vec4 val) {\n  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));\n  mv = clamp(mv, 0.01, RGBM_MAX);\n  vec3 nrm = val.xyz / mv;\n  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage\n  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nvec4 readTexel(vec2 uv) { return rgbmDecode(texture2D(inputTexture, uv)); }\n\n#define PI 3.14159265\n#define DCTLIVE_IS_VERT 0\n\n// 1D forward DCT: compute one frequency coefficient F[k] for a spatial block.\n//\n// This fragment's output position determines which frequency bin it represents.\n// Formula: F[k] = scale * Σ(n=0..N-1) x[n] * cos((n+0.5)*k*π/N)\n//   k: frequency index (0=DC, 1..N-1=harmonics) within the block\n//   x[n]: input sample at spatial position n in the block\n//   N: effective block size (clamped to image boundary)\n//   scale: DCT-II orthonormal factor (1/N for DC, 2/N for harmonics)\n//\n// Injected by caller:\n//   readTexel(vec2 uv) -> vec4  -- read input sample; handles any codec wrapping (see 8 bit versions)\nvec4 dctForward(vec2 fragCoord, vec2 resolution, int blockSize) {\n  // Scan direction: horizontal (freq along x) or vertical (freq along y)\n  #if DCTLIVE_IS_VERT == 1\n  vec2 direction = vec2(0.0, 1.0);\n  #else\n  vec2 direction = vec2(1.0, 0.0);\n  #endif\n\n  // Locate the block containing this fragment.\n  // blockStride: distance (in texels) between consecutive block starts in this direction\n  // blockCorner: position of the top-left corner of this fragment's block\n  // N: effective block size, clamped to image boundary (may be < blockSize at edges)\n  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);\n  vec2 blockCorner = 0.5 + floor(fragCoord / blockStride) * blockStride;\n  int N = int(min(float(blockSize), dot(direction, resolution - blockCorner + 0.5)));\n\n  // Compute this fragment's frequency index (0 to N-1), then scale to [0, π]\n  float freq = floor(mod(dot(direction, fragCoord), float(blockSize))) / float(N) * PI;\n\n  // DCT-II orthonormal scaling: 1/N for DC (freq≈0), 2/N for harmonics.\n  // Using branchless step() to avoid GPU branch prediction penalty.\n  float scale = (1.0 + step(0.001, abs(freq))) / float(N);\n\n  vec4 sum = vec4(0.0);\n  for (int n = 0; n < 1024; n++) {\n    if (N <= n) break;\n    vec2 sampleUv = (blockCorner + float(n) * direction) / resolution;\n    float basis = cos((float(n) + 0.5) * freq);\n    sum += basis * scale * readTexel(sampleUv);\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = rgbmEncode(dctForward(gl_FragCoord.xy, resolution, blockSize));\n}\n";

  var fwdY = "precision highp float;\n#define GLSLIFY 1\n\n// Decode a YM-encoded vec4 back to a single float.\n// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.\n#define RGBM_MAX 4.0\n\nfloat ymDecode(vec4 enc) {\n  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel\n  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]\n  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale\n}\n\n// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.\n// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.\n// B and A are unused (set to 1.0). Decode with ymDecode.\n#define RGBM_MAX 4.0\n\nvec4 ymEncode(float lum) {\n  float mv = clamp(abs(lum), 0.01, RGBM_MAX);\n  float norm = lum / mv;\n  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\n\nfloat readTexel(vec2 uv) { return ymDecode(texture2D(inputTexture, uv)); }\n\n#define PI 3.14159265\n#define DCTLIVE_IS_VERT 0\n\n// Scalar variant of dctForward (see dct-forward.glsl for full documentation).\n// Same math, outputs float instead of vec4. Cheaper for luminance-only processing.\nfloat dctForwardY(vec2 fragCoord, vec2 resolution, int blockSize) {\n  #if DCTLIVE_IS_VERT == 1\n  vec2 direction = vec2(0.0, 1.0);\n  #else\n  vec2 direction = vec2(1.0, 0.0);\n  #endif\n\n  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);\n  vec2 blockCorner = 0.5 + floor(fragCoord / blockStride) * blockStride;\n  int N = int(min(float(blockSize), dot(direction, resolution - blockCorner + 0.5)));\n\n  float k = floor(mod(dot(direction, fragCoord), float(blockSize))) / float(N) * PI;\n  float scale = (1.0 + step(0.001, abs(k))) / float(N);\n\n  float sum = 0.0;\n  for (int n = 0; n < 1024; n++) {\n    if (N <= n) break;\n    vec2 sampleUv = (blockCorner + float(n) * direction) / resolution;\n    float basis = cos((float(n) + 0.5) * k);\n    sum += basis * scale * readTexel(sampleUv);\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = ymEncode(dctForwardY(gl_FragCoord.xy, resolution, blockSize));\n}\n";

  var invColor = "precision highp float;\n#define GLSLIFY 1\n\n// Decode an RGBM-encoded vec4 back to its original high-range values.\n// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.\n#define RGBM_MAX 4.0\n\nvec4 rgbmDecode(vec4 enc) {\n  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha\n  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]\n  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale\n}\n\n// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.\n//\n// The three colour channels are normalized by their maximum absolute value (the \"M\"),\n// then sqrt-companded to concentrate precision near zero.\n// The scale factor M is stored in alpha after its own sqrt-compand.\n//\n// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.\n// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless\n// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.\n//\n// Decode with rgbmDecode.\n#define RGBM_MAX 4.0\n\nvec4 rgbmEncode(vec4 val) {\n  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));\n  mv = clamp(mv, 0.01, RGBM_MAX);\n  vec3 nrm = val.xyz / mv;\n  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage\n  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nvec4 readTexel(vec2 uv) { return rgbmDecode(texture2D(inputTexture, uv)); }\n\n// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().\n#define DCTLIVE_WAVE_BODY return cos(angle);\nfloat wave(float angle) { DCTLIVE_WAVE_BODY }\n\n#define PI 3.14159265\n// 0 = horizontal pass, 1 = vertical pass. Injected by shader provider via patchDefines.\n#define DCTLIVE_IS_VERT 0\n\n// 1D inverse DCT: reconstruct one spatial output pixel from frequency coefficients.\n//\n// This fragment's output position determines which spatial position it reconstructs.\n// Formula: x[delta] = Σ(k=0..N-1) F[k] * wave(delta*k*π/N)\n//   delta: spatial position within block (0 to N-1), read from fragment position\n//   F[k]: frequency coefficient at index k (read from input texture)\n//   N: effective block size (clamped to image boundary)\n//   wave(angle): reconstruction basis function (normally cos for DCT-II)\n//   lpf: low-pass filter limit (only sum k from 0 to min(lpf, N-1))\n//\n// Injected by caller:\n//   readTexel(vec2 uv) -> vec4  -- read coefficient; handles any codec wrapping (see 8 bit versions)\n//   wave(float angle) -> float  -- the reconstruction basis function, cos() by default\nvec4 dctInverse(vec2 fragCoord, vec2 resolution, int blockSize, float lpf) {\n  // Scan direction: horizontal (reconstruct spatial X) or vertical (reconstruct spatial Y)\n  #if DCTLIVE_IS_VERT == 1\n  vec2 direction = vec2(0.0, 1.0);\n  #else\n  vec2 direction = vec2(1.0, 0.0);\n  #endif\n\n  // Locate the block containing this fragment.\n  // blockStride: distance (in texels) between consecutive block starts in this direction\n  // blockOrigin: position of the top-left corner of this fragment's block\n  // N: effective block size, clamped to image boundary (may be < blockSize at edges)\n  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / blockStride) * blockStride;\n  int N = int(min(float(blockSize), dot(direction, resolution - blockOrigin + 0.5)));\n\n  // Limit reconstruction to the first `loopLimit` frequency bins (low-pass filter).\n  // loopLimit = 1: DC only. loopLimit = N: full reconstruction.\n  int loopLimit = int(min(float(N), lpf));\n\n  // This fragment's spatial position within its block (0 to N-1), scaled to [0, π]\n  float delta = mod(dot(direction, fragCoord), float(blockSize)) / float(N) * PI;\n\n  vec4 sum = vec4(0.0);\n  for (int k = 0; k < 1024; k++) {\n    if (loopLimit <= k) break;\n    vec4 coeff = readTexel((blockOrigin + direction * float(k)) / resolution);\n    sum += wave(delta * float(k)) * coeff;\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = rgbmEncode(dctInverse(gl_FragCoord.xy, resolution, blockSize, lpf));\n}\n";

  var invY = "precision highp float;\n#define GLSLIFY 1\n\n// Decode a YM-encoded vec4 back to a single float.\n// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.\n#define RGBM_MAX 4.0\n\nfloat ymDecode(vec4 enc) {\n  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel\n  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]\n  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale\n}\n\n// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.\n// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.\n// B and A are unused (set to 1.0). Decode with ymDecode.\n#define RGBM_MAX 4.0\n\nvec4 ymEncode(float lum) {\n  float mv = clamp(abs(lum), 0.01, RGBM_MAX);\n  float norm = lum / mv;\n  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float lpf;\nuniform float time;\nuniform float wi;\n\nfloat readTexel(vec2 uv) { return ymDecode(texture2D(inputTexture, uv)); }\n\n// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().\n#define DCTLIVE_WAVE_BODY return cos(angle);\nfloat wave(float angle) { DCTLIVE_WAVE_BODY }\n\n#define PI 3.14159265\n// 0 = horizontal pass, 1 = vertical pass. Injected by shader provider via patchDefines.\n#define DCTLIVE_IS_VERT 0\n\n// Scalar variant of dctInverse (see dct-inverse.glsl for full documentation).\n// Same math, outputs float instead of vec4. Cheaper for luminance-only reconstruction.\nfloat dctInverseY(vec2 fragCoord, vec2 resolution, int blockSize, float lpf) {\n  #if DCTLIVE_IS_VERT == 1\n  vec2 direction = vec2(0.0, 1.0);\n  #else\n  vec2 direction = vec2(1.0, 0.0);\n  #endif\n\n  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);\n  vec2 blockOrigin = 0.5 + floor(fragCoord / blockStride) * blockStride;\n  int N = int(min(float(blockSize), dot(direction, resolution - blockOrigin + 0.5)));\n  int loopLimit = int(min(float(N), lpf));\n\n  float delta = mod(dot(direction, fragCoord), float(blockSize)) / float(N) * PI;\n\n  float sum = 0.0;\n  for (int k = 0; k < 1024; k++) {\n    if (loopLimit <= k) break;\n    float coeff = readTexel((blockOrigin + direction * float(k)) / resolution);\n    sum += wave(delta * float(k)) * coeff;\n  }\n  return sum;\n}\n\nvoid main() {\n  gl_FragColor = ymEncode(dctInverseY(gl_FragCoord.xy, resolution, blockSize, lpf));\n}\n";

  var quantColor = "precision highp float;\n#define GLSLIFY 1\n\n// Decode an RGBM-encoded vec4 back to its original high-range values.\n// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.\n#define RGBM_MAX 4.0\n\nvec4 rgbmDecode(vec4 enc) {\n  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha\n  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]\n  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale\n}\n\n// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.\n//\n// The three colour channels are normalized by their maximum absolute value (the \"M\"),\n// then sqrt-companded to concentrate precision near zero.\n// The scale factor M is stored in alpha after its own sqrt-compand.\n//\n// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.\n// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless\n// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.\n//\n// Decode with rgbmDecode.\n#define RGBM_MAX 4.0\n\nvec4 rgbmEncode(vec4 val) {\n  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));\n  mv = clamp(mv, 0.01, RGBM_MAX);\n  vec3 nrm = val.xyz / mv;\n  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage\n  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));\n}\n\n// Round value to the nearest multiple of stepSize.\n// stepSize=0 is safe — clamped to 1e-6 to avoid division by zero.\nfloat quantize(float value, float stepSize) {\n  float s = max(stepSize, 1e-6);\n  return floor(value / s + 0.5) * s;\n}\n\n// Quantize a vec4 DCT coefficient (Y, Cb, Cr, A channels independently).\n// `len` is the Euclidean distance from the block's DC corner to this frequency bin —\n// used to scale the step size up for high-frequency coefficients (mimics JPEG's\n// quantization matrix). highFreqMultiplier amplifies the coefficient itself first.\nvec4 quantizeCoeff(vec4 coeff, float len, float highFreqMultiplier,\n    float qY, float qYf, float qC, float qCf, float qA, float qAf) {\n  coeff *= 1.0 + len * highFreqMultiplier;\n\n  coeff.x = quantize(coeff.x, qY + qYf * len);\n  coeff.y = quantize(coeff.y, qC + qCf * len);\n  coeff.z = quantize(coeff.z, qC + qCf * len);\n  coeff.w = quantize(coeff.w, qA + qAf * len);\n\n  return coeff;\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\nuniform float quantizeC;\nuniform float quantizeCf;\nuniform float quantizeA;\nuniform float quantizeAf;\n\nvoid main() {\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n  vec4 coeff = rgbmDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));\n  gl_FragColor = rgbmEncode(quantizeCoeff(coeff, len, highFreqMultiplier,\n    quantizeY, quantizeYf, quantizeC, quantizeCf, quantizeA, quantizeAf));\n}\n";

  var quantY = "precision highp float;\n#define GLSLIFY 1\n\n// Decode a YM-encoded vec4 back to a single float.\n// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.\n#define RGBM_MAX 4.0\n\nfloat ymDecode(vec4 enc) {\n  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel\n  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]\n  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale\n}\n\n// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.\n// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.\n// B and A are unused (set to 1.0). Decode with ymDecode.\n#define RGBM_MAX 4.0\n\nvec4 ymEncode(float lum) {\n  float mv = clamp(abs(lum), 0.01, RGBM_MAX);\n  float norm = lum / mv;\n  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);\n}\n\n// Round value to the nearest multiple of stepSize.\n// stepSize=0 is safe — clamped to 1e-6 to avoid division by zero.\nfloat quantize(float value, float stepSize) {\n  float s = max(stepSize, 1e-6);\n  return floor(value / s + 0.5) * s;\n}\n\n// Quantize a single float luminance DCT coefficient.\n// Scalar version of quantizeCoeff — used in Y-only mode where chroma/alpha are absent.\nfloat quantizeCoeffY(float lum, float len, float highFreqMultiplier, float qY, float qYf) {\n  lum *= 1.0 + len * highFreqMultiplier;\n  return quantize(lum, qY + qYf * len);\n}\n\nuniform vec2 resolution;\nuniform int blockSize;\nuniform sampler2D inputTexture;\nuniform float highFreqMultiplier;\nuniform float quantizeY;\nuniform float quantizeYf;\n\nvoid main() {\n  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));\n  float lum = ymDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));\n  gl_FragColor = ymEncode(quantizeCoeffY(lum, len, highFreqMultiplier, quantizeY, quantizeYf));\n}\n";

  const DEFAULT_WAVE_BODY = 'return cos(angle);';

  function patchDefines(src, defines) {
    let result = src;
    for (const [name, value] of Object.entries(defines)) {
      result = result.replace(
        new RegExp(`#define ${name} [^\\n]*`),
        `#define ${name} ${value}`
      );
    }
    return result;
  }

  const BLIT_SOURCES = {
    clamp:  blitClampFrag,
    repeat: blitRepeatFrag,
    mirror: blitMirrorFrag,
    mask:   blitMaskFrag,
  };

  class FloatShaderProvider {
    yOnly    = false;
    waveBody = DEFAULT_WAVE_BODY;

    // Infrastructure — same for all pipelines
    get vert()             { return quadVert; }
    get blit()             { return BLIT_SOURCES; }
    get passthrough()      { return passthroughFrag; }
    get passthroughFlipY() { return patchDefines(passthroughFrag, { DCTLIVE_FLIP_UV: 1 }); }

    // Color conversion
    get colorIn()          { return colorInFrag; }
    get colorOut()         { return this.yOnly ? patchDefines(colorOutFrag, { DCTLIVE_Y_ONLY: 1 }) : colorOutFrag; }
    get colorOutFlipY()    { return patchDefines(this.colorOut, { DCTLIVE_FLIP_UV: 1 }); }

    // Forward DCT — yOnly selects scalar vs vec4 math
    get _fwdSrc()          { return this.yOnly ? forwardYFrag : forwardFrag; }
    get forwardH()         { return this._fwdSrc; }
    get forwardV()         { return patchDefines(this._fwdSrc, { DCTLIVE_IS_VERT: 1 }); }

    // Inverse DCT — yOnly selects template, waveBody is patched in
    get _invSrc()          { return this.yOnly ? inverseYFrag : inverseFrag; }
    get inverseH()         { return patchDefines(this._invSrc, { DCTLIVE_WAVE_BODY: this.waveBody }); }
    get inverseV()         { return patchDefines(this._invSrc, { DCTLIVE_WAVE_BODY: this.waveBody, DCTLIVE_IS_VERT: 1 }); }

    // Quantize
    get quantize()         { return this.yOnly ? quantizeYFrag : quantizeFrag; }
  }

  class Bit8ShaderProvider {
    yOnly    = false;
    waveBody = DEFAULT_WAVE_BODY;

    // Infrastructure — same for all pipelines
    get vert()             { return quadVert; }
    get blit()             { return BLIT_SOURCES; }
    get passthrough()      { return passthroughFrag; }
    get passthroughFlipY() { return patchDefines(passthroughFrag, { DCTLIVE_FLIP_UV: 1 }); }

    // Color conversion
    get colorIn()          { return this.yOnly ? colorInY    : colorInColor; }
    get colorOut()         { return this.yOnly ? colorOutY   : colorOutColor; }
    get colorOutFlipY()    { return patchDefines(this.colorOut, { DCTLIVE_FLIP_UV: 1 }); }

    // Forward DCT
    get _fwdSrc()          { return this.yOnly ? fwdY : fwdColor; }
    get forwardH()         { return this._fwdSrc; }
    get forwardV()         { return patchDefines(this._fwdSrc, { DCTLIVE_IS_VERT: 1 }); }

    // Inverse DCT
    get _invSrc()          { return this.yOnly ? invY : invColor; }
    get inverseH()         { return patchDefines(this._invSrc, { DCTLIVE_WAVE_BODY: this.waveBody }); }
    get inverseV()         { return patchDefines(this._invSrc, { DCTLIVE_WAVE_BODY: this.waveBody, DCTLIVE_IS_VERT: 1 }); }

    // Quantize
    get quantize()         { return this.yOnly ? quantY : quantColor; }
  }

  class RenderPipeline {
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
      const previous = this._waveBody;
      this._waveBody = normalized;
      this.shaderProvider.waveBody = normalized;
      this._deleteInversePrograms();
      try {
        this._buildInversePrograms();
      } catch (e) {
        this._waveBody = previous;
        this.shaderProvider.waveBody = previous;
        this._buildInversePrograms();
        throw e;
      }
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
     * Resolve all uniforms at once. Returns an object with all shader parameters resolved.
     * @returns {Object} { blockSize, lpf, highFreqMultiplier, quantizeY, ... }
     */
    resolveAllUniforms() {
      return {
        blockSize: this.resolveUniform('blockSize'),
        lpf: this.resolveUniform('lpf'),
        highFreqMultiplier: this.resolveUniform('highFreqMultiplier'),
        quantizeY: this.resolveUniform('quantizeY'),
        quantizeYf: this.resolveUniform('quantizeYf'),
        quantizeC: this.resolveUniform('quantizeC'),
        quantizeCf: this.resolveUniform('quantizeCf'),
        quantizeA: this.resolveUniform('quantizeA'),
        quantizeAf: this.resolveUniform('quantizeAf'),
        waveInput: this.resolveUniform('waveInput'),
      };
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

    /** Reset all uniforms to their default values. */
    reset() {
      this.uniforms = { ...DEFAULT_UNIFORMS };
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

      const shaderProvider = precision === '8bit' ? new Bit8ShaderProvider() : new FloatShaderProvider();
      this._pipeline = new RenderPipeline(gl, this.width, this.height, texType, shaderProvider);
      this._display = new DisplayController(this.canvas);
      this._config = new ShaderConfig();
      this.input = new InputSource(gl, this.width, this.height);

      // DCT/IDCT pass control
      this.dctHorizontal  = true;
      this.dctVertical    = true;
      this.idctHorizontal = true;
      this.idctVertical   = true;

      this._autoLoop = opts.loop !== false;
    }

    // ---- Resolution & display ----

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

    // ---- Source loading ----

    /**
     * Load an image from a URL or set an HTMLImageElement as input.
     * @param {string|HTMLImageElement} source - URL string or image element
     * @param {Object} [opts] - { fit, minFilter, magFilter, wrap }
     * @returns {Promise<void>}
     */
    async initImage(source, opts = {}) {
      try {
        if (typeof source === 'string') await this.input.loadImage(source, opts);
        else if (source instanceof HTMLImageElement) this.input.setImage(source, opts);
        else throw new Error('source must be a URL string or HTMLImageElement');
        this._afterLoad();
      } catch (err) { console.error('DCTLive.initImage failed:', err); }
    }

    /**
     * Load a video from a URL or set an HTMLVideoElement as dynamic input.
     * @param {string|HTMLVideoElement} source - URL string or video element
     * @param {Object} [opts] - { fit, minFilter, magFilter, wrap }
     * @returns {Promise<void>}
     */
    async initVideo(source, opts = {}) {
      try {
        if (typeof source === 'string') await this.input.loadVideo(source, opts);
        else if (source instanceof HTMLVideoElement) this.input.setVideo(source, opts);
        else throw new Error('source must be a URL string or HTMLVideoElement');
        this._afterLoad();
      } catch (err) { console.error('DCTLive.initVideo failed:', err); }
    }

    /**
     * Set another canvas as dynamic input.
     * Accepts HTMLCanvasElement, a CanvasRenderingContext2D, or Hydra-style wrapper objects.
     * @param {HTMLCanvasElement|CanvasRenderingContext2D|Object} canvas
     * @param {Object} [opts]
     */
    async initCanvas(canvas, opts = {}) {
      try {
        this.input.setCanvas(canvas, opts);
        this._afterLoad();
      } catch (err) { console.error('DCTLive.initCanvas failed:', err); }
    }

    /**
     * Initialize camera input from device camera(s).
     * @param {number|string} [selector=0] - Camera index (number) or label (string)
     * @param {Object} [opts] - { constraints }
     * @returns {Promise<HTMLVideoElement>}
     */
    async initCam(selector = 0, opts = {}) {
      try {
        const video = await this.input.initCam(selector, opts);
        this._afterLoad();
        return video;
      } catch (err) {
        console.error('DCTLive.initCam:', `Camera error: ${err.name || 'unknown'} - ${err.message || err}`);
        throw err;
      }
    }

    _afterLoad() {
      this.run();
      if (this._autoLoop) this.start();
    }

    // ---- DCT pass control ----

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

    // ---- Uniforms ----

    setUniform(name, value) { this._config.setUniform(name, value); }
    setUniforms(obj)        { this._config.setUniforms(obj); }

    // Uniform shorthands — quantize values (qY, qC, etc.) are squared before reaching the shader
    // (user input 0–1 maps to a quadratic curve for perceptual control).
    get qY()        { return this._config.uniforms.quantizeY; }
    set qY(v)       { this._config.uniforms.quantizeY = v; }
    get qYf()       { return this._config.uniforms.quantizeYf; }
    set qYf(v)      { this._config.uniforms.quantizeYf = v; }
    get qC()        { return this._config.uniforms.quantizeC; }
    set qC(v)       { this._config.uniforms.quantizeC = v; }
    get qCf()       { return this._config.uniforms.quantizeCf; }
    set qCf(v)      { this._config.uniforms.quantizeCf = v; }
    get qA()        { return this._config.uniforms.quantizeA; }
    set qA(v)       { this._config.uniforms.quantizeA = v; }
    get qAf()       { return this._config.uniforms.quantizeAf; }
    set qAf(v)      { this._config.uniforms.quantizeAf = v; }
    get hfreq()     { return this._config.uniforms.highFreqMultiplier; }
    set hfreq(v)    { this._config.uniforms.highFreqMultiplier = v; }
    get blockSize() { return this._config.uniforms.blockSize; }
    set blockSize(v){ this._config.uniforms.blockSize = v; }
    get lpf()       { return this._config.uniforms.lpf; }
    set lpf(v)      { this._config.uniforms.lpf = v; }
    get waveInput() { return this._config.uniforms.waveInput; }
    set waveInput(v){ this._config.uniforms.waveInput = v; }

    // ---- Global state ----

    get uniforms()   { return this._config.uniforms; }
    get precision()  { return this._precision; }

    get fps()        { return this._config.fps; }
    set fps(value)   { this._config.fps = value; }

    get flipY()      { return this._display.flipY; }
    set flipY(value) { this._display.flipY = value; this.input.flipY = value; }

    // yOnly swaps shader programs in the pipeline in addition to storing the value
    get yOnly()     { return this._config.uniforms.yOnly; }
    set yOnly(v)    { this._config.uniforms.yOnly = v; this._pipeline.setYOnly(v); }

    /**
     * Reset to initial configuration: all uniforms to defaults, wave function to cosine, all passes enabled.
     */
    reset() {
      this._config.reset();
      this.yOnly = false;
      this.resetWaveFunction();
      this.dctHorizontal = this.dctVertical = this.idctHorizontal = this.idctVertical = true;
    }

    // ---- Render loop ----

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
        uniforms:       this._config.resolveAllUniforms(),
      });
    }

    /** Start the render loop. */
    start() {
      if (this._looping) return;
      this._looping = true;
      this._lastFrameTime = null;
      const loop = (timestamp) => {
        if (!this._looping) return;
        const frameInterval = this._config.frameInterval;
        if (this._lastFrameTime === null) {
          try { this.run(); } catch (e) { console.error(e); }
          this._lastFrameTime = timestamp;
        } else {
          const delta = timestamp - this._lastFrameTime;
          if (frameInterval <= 0 || delta >= frameInterval) {
            try { this.run(); } catch (e) { console.error(e); }
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

    // ---- Lifecycle ----

    /** Clean up WebGL resources. */
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
