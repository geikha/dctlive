precision highp float;

#pragma glslify: rgbmDecode = require('../../modules/rgbm-decode.glsl')
#pragma glslify: ycbcr2rgb = require('../../modules/ycbcr2rgb.glsl')

uniform vec2 resolution;
uniform sampler2D inputTexture;

#define DCTLIVE_FLIP_UV 0

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  #if DCTLIVE_FLIP_UV == 1
  uv.y = 1.0 - uv.y;
  #endif
  vec4 color = rgbmDecode(texture2D(inputTexture, uv));
  color.rgb = ycbcr2rgb(color.rgb);
  gl_FragColor = color;
}
