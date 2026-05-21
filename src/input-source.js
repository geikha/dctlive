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

export default class InputSource {
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
