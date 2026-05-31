precision highp float;

#pragma glslify: ycbcr2rgb = require('../modules/ycbcr2rgb.glsl')

uniform vec2 resolution;
uniform sampler2D inputTexture;
uniform bool yOnlyMode;

#define DCTLIVE_FLIP_UV 0

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  #if DCTLIVE_FLIP_UV == 1
  uv.y = 1.0 - uv.y;
  #endif
  vec4 color = texture2D(inputTexture, uv);

  if (yOnlyMode) {
    color.rgb = vec3(color.x);
    color.a = 1.0;
  } else {
    color.rgb = ycbcr2rgb(color.rgb);
  }

  gl_FragColor = color;
}
