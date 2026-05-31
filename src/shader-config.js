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
export default class ShaderConfig {
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
