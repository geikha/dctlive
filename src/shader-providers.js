import colorInFrag         from './shaders/pipeline/color-in.frag';
import colorOutFrag        from './shaders/pipeline/color-out.frag';
import forwardFrag         from './shaders/pipeline/forward.frag';
import forwardYFrag        from './shaders/pipeline/forward-y.frag';
import inverseFrag         from './shaders/pipeline/inverse.frag';
import inverseYFrag        from './shaders/pipeline/inverse-y.frag';
import quantizeFrag        from './shaders/pipeline/quantize.frag';
import quantizeYFrag       from './shaders/pipeline/quantize-y.frag';

import colorInColor        from './shaders/pipeline/8bit/color-in-color.frag';
import colorInY            from './shaders/pipeline/8bit/color-in-y.frag';
import colorOutColor       from './shaders/pipeline/8bit/color-out-color.frag';
import colorOutY           from './shaders/pipeline/8bit/color-out-y.frag';
import fwdColor            from './shaders/pipeline/8bit/forward-color.frag';
import fwdY                from './shaders/pipeline/8bit/forward-y.frag';
import invColor            from './shaders/pipeline/8bit/inverse-color.frag';
import invY                from './shaders/pipeline/8bit/inverse-y.frag';
import quantColor          from './shaders/pipeline/8bit/quantize-color.frag';
import quantY              from './shaders/pipeline/8bit/quantize-y.frag';

export class FloatShaderProvider {
  yOnly = false;

  get colorIn()   { return colorInFrag; }
  get colorOut()  { return colorOutFrag; }
  get forward()   { return forwardFrag; }
  get forwardY()  { return forwardYFrag; }
  get inverse()   { return inverseFrag; }
  get inverseY()  { return inverseYFrag; }
  get quantize()  { return quantizeFrag; }
  get quantizeY() { return quantizeYFrag; }
}

export class Bit8ShaderProvider {
  yOnly = false;

  get colorIn()   { return this.yOnly ? colorInY    : colorInColor; }
  get colorOut()  { return this.yOnly ? colorOutY   : colorOutColor; }
  get forward()   { return this.yOnly ? fwdY        : fwdColor; }
  get forwardY()  { return this.yOnly ? fwdY        : fwdColor; }
  get inverse()   { return this.yOnly ? invY        : invColor; }
  get inverseY()  { return this.yOnly ? invY        : invColor; }
  get quantize()  { return this.yOnly ? quantY      : quantColor; }
  get quantizeY() { return quantY; }
}
