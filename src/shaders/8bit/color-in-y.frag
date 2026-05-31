precision highp float;

#pragma glslify: rgb2ycbcr = require('../modules/rgb2ycbcr.glsl')
#pragma glslify: ymEncode = require('../modules/ym-encode.glsl')

uniform vec2 resolution;
uniform sampler2D inputTexture;

void main() {
  vec4 color = texture2D(inputTexture, gl_FragCoord.xy / resolution);
  float y = rgb2ycbcr(color.rgb).x;
  gl_FragColor = ymEncode(y);
}
