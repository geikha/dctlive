precision highp float;

#pragma glslify: ymDecode = require('../../modules/ym-decode.glsl')

uniform vec2 resolution;
uniform sampler2D inputTexture;

#define DCTLIVE_FLIP_UV 0

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  #if DCTLIVE_FLIP_UV == 1
  uv.y = 1.0 - uv.y;
  #endif
  float lum = ymDecode(texture2D(inputTexture, uv));
  gl_FragColor = vec4(lum, lum, lum, 1.0);
}
