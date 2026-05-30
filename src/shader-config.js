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

export default class ShaderConfig {
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
