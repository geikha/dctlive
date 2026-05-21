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

import InputSource from './input-source.js';
import RenderPipeline from './render-pipeline.js';
import DisplayController from './display-controller.js';
import ShaderConfig from './shader-config.js';

export { InputSource };

export default class DCTLive {
  /**
   * @param {Object} opts
   * @param {number}  [opts.width=256]  - Canvas / processing width
   * @param {number}  [opts.height=256] - Canvas / processing height
   * @param {boolean} [opts.loop=false] - Continuously re-run the pipeline
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

    // Auto-start loop if requested
    if (opts.loop) {
      this._autoLoop = true;
    }
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
  initImage(source, opts = {}) {
    const promise = typeof source === 'string'
      ? this.input.loadImage(source, opts)
      : Promise.resolve(this.input.setImage(source, opts));

    return promise.then(() => {
      this.run();
      if (this._autoLoop) this.start();
    });
  }

  /**
   * Load a video from a URL or set an HTMLVideoElement as dynamic input.
   * @param {string|HTMLVideoElement} source - URL string or video element
   * @param {Object} [opts] - { fit, minFilter, magFilter, wrapS, wrapT, wrap }
   * @returns {Promise<void>}
   */
  initVideo(source, opts = {}) {
    if (typeof source === 'string') {
      return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.src = source;
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.loop = true;
        video.playsInline = true;

        const onLoaded = () => {
          video.removeEventListener('loadeddata', onLoaded);
          video.removeEventListener('error', onError);
          this.input.setVideo(video, opts);
          this.run();
          if (this._autoLoop) this.start();
          video.play().catch(() => {});
          resolve();
        };

        const onError = () => {
          video.removeEventListener('loadeddata', onLoaded);
          video.removeEventListener('error', onError);
          reject(new Error('Failed to load video: ' + source));
        };

        video.addEventListener('loadeddata', onLoaded);
        video.addEventListener('error', onError);
      });
    } else {
      this.input.setVideo(source, opts);
      this.run();
      if (this._autoLoop) this.start();
      return Promise.resolve();
    }
  }

  /**
   * Set another canvas as dynamic input.
   * Accepts HTMLCanvasElement, a CanvasRenderingContext2D, or Hydra-style wrapper objects.
   * @param {HTMLCanvasElement|CanvasRenderingContext2D|Object} canvas
   * @param {Object} [opts]
   */
  initCanvas(canvas, opts = {}) {
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
      throw new Error('DCTLive.initCanvas requires an HTMLCanvasElement, CanvasRenderingContext2D, or wrapper object with a canvas source');
    }

    this.input.setCanvas(targetCanvas, opts);
    this.run();
    if (this._autoLoop) this.start();
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
   * Set the canvas display size using CSS.
   * @param {number|string} width
   * @param {number|string} height
   */
  setDisplaySize(width, height) {
    this._display.setSize(width, height);
  }

  /**
   * Set the maximum frames per second for looped rendering.
   * @param {number} fps
   */
  setFPS(fps) {
    this._config.setFPS(fps);
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
      const delta = this._lastFrameTime === null ? Infinity : timestamp - this._lastFrameTime;
      const frameInterval = this._config.frameInterval;
      if (frameInterval <= 0 || delta >= frameInterval) {
        this.run();
        this._lastFrameTime = timestamp - (frameInterval > 0 ? (delta % frameInterval) : 0);
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
