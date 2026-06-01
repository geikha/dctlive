/**
 * DCTLive — WebGL implementation of JPEG-like DCT.
 *
 * Design & API: geikha
 * DCT shader reference: FMS-Cat (https://www.youtube.com/watch?v=xt4UFRPqX_w)
 *
 * Usage:
 *   const dct = new DCTLive({ width: 512, height: 512, loop: true });
 *   await dct.initImage('image.png');
 *   dct.show();
 *   dct.start();
 */

import InputSource from './input-source.js';
import RenderPipeline from './render-pipeline.js';
import DisplayController from './display-controller.js';
import ShaderConfig from './shader-config.js';
import { resolveTexType } from './gl-utils.js';
import { FloatShaderProvider, Bit8ShaderProvider } from './shader-providers.js';

export { InputSource };

export default class DCTLive {
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
