precision highp float;

#pragma glslify: rgb2ycbcr = require('../../modules/rgb2ycbcr.glsl')
#pragma glslify: rgbmEncode = require('../../modules/rgbm-encode.glsl')

uniform vec2 resolution;
uniform sampler2D inputTexture;

void main() {
  vec4 color = texture2D(inputTexture, gl_FragCoord.xy / resolution);
  color.rgb = rgb2ycbcr(color.rgb);
  gl_FragColor = rgbmEncode(color);
}
