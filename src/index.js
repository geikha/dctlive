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

import InputSource from './input-source.js';
import RenderPipeline from './render-pipeline.js';
import RenderPipeline8bit from './render-pipeline-8bit.js';
import DisplayController from './display-controller.js';
import ShaderConfig from './shader-config.js';
import { resolveTexType } from './gl-utils.js';

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
