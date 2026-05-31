precision highp float;

uniform vec2 resolution;
uniform sampler2D inputTexture;

#define DCTLIVE_FLIP_UV 0

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  #if DCTLIVE_FLIP_UV == 1
  uv.y = 1.0 - uv.y;
  #endif
  gl_FragColor = texture2D(inputTexture, uv);
}
