precision highp float;

#pragma glslify: ymDecode = require('../modules/ym-decode.glsl')

uniform vec2 resolution;
uniform sampler2D inputTexture;

void main() {
  float lum = ymDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));
  gl_FragColor = vec4(lum, lum, lum, 1.0);
}
