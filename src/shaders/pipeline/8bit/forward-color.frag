precision highp float;

#pragma glslify: rgbmDecode = require('../../modules/rgbm-decode.glsl')
#pragma glslify: rgbmEncode = require('../../modules/rgbm-encode.glsl')

uniform vec2 resolution;
uniform bool isVert;
uniform int blockSize;
uniform sampler2D inputTexture;

vec4 readTexel(vec2 uv) { return rgbmDecode(texture2D(inputTexture, uv)); }

#pragma glslify: dctForward = require('../../modules/dct-forward.glsl', readTexel=readTexel)

void main() {
  gl_FragColor = rgbmEncode(dctForward(gl_FragCoord.xy, resolution, isVert, blockSize));
}
