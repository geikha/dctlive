const FILTER_MAP = {
  linear: 'LINEAR',
  nearest: 'NEAREST',
};

const FIT_MODES = ['stretch', 'fill', 'fit'];
const WRAP_MODES = ['clamp', 'repeat', 'mirror', 'mask'];

export default class InputSource {
  constructor(gl, targetWidth, targetHeight) {
    this.gl = gl;
    this.targetWidth = targetWidth;
    this.targetHeight = targetHeight;

    this.texture = null;

    this._minFilter = 'linear';
    this._magFilter = 'linear';
    this._wrap = 'mask';
    this._fit = 'stretch';

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

    let sx, sy, ox, oy;

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
