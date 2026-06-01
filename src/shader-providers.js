import quadVert         from './shaders/vert/quad.vert';
import passthroughFrag  from './shaders/pipeline/passthrough.frag';

import blitClampFrag    from './shaders/blit/blit-clamp.frag';
import blitRepeatFrag   from './shaders/blit/blit-repeat.frag';
import blitMirrorFrag   from './shaders/blit/blit-mirror.frag';
import blitMaskFrag     from './shaders/blit/blit-mask.frag';

import colorInFrag      from './shaders/pipeline/color-in.frag';
import colorOutFrag     from './shaders/pipeline/color-out.frag';
import forwardFrag      from './shaders/pipeline/forward.frag';
import forwardYFrag     from './shaders/pipeline/forward-y.frag';
import inverseFrag      from './shaders/pipeline/inverse.frag';
import inverseYFrag     from './shaders/pipeline/inverse-y.frag';
import quantizeFrag     from './shaders/pipeline/quantize.frag';
import quantizeYFrag    from './shaders/pipeline/quantize-y.frag';

import colorInColor     from './shaders/pipeline/8bit/color-in-color.frag';
import colorInY         from './shaders/pipeline/8bit/color-in-y.frag';
import colorOutColor    from './shaders/pipeline/8bit/color-out-color.frag';
import colorOutY        from './shaders/pipeline/8bit/color-out-y.frag';
import fwdColor         from './shaders/pipeline/8bit/forward-color.frag';
import fwdY             from './shaders/pipeline/8bit/forward-y.frag';
import invColor         from './shaders/pipeline/8bit/inverse-color.frag';
import invY             from './shaders/pipeline/8bit/inverse-y.frag';
import quantColor       from './shaders/pipeline/8bit/quantize-color.frag';
import quantY           from './shaders/pipeline/8bit/quantize-y.frag';

export const DEFAULT_WAVE_BODY = 'return cos(angle);';

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

export class FloatShaderProvider {
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

export class Bit8ShaderProvider {
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
