precision highp float;

#pragma glslify: rgbmDecode = require('../modules/rgbm-decode.glsl')
#pragma glslify: ycbcr2rgb = require('../modules/ycbcr2rgb.glsl')

uniform vec2 resolution;
uniform sampler2D inputTexture;

void main() {
  vec4 color = rgbmDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));
  color.rgb = ycbcr2rgb(color.rgb);
  gl_FragColor = color;
}
