precision highp float;

#pragma glslify: ymDecode = require('../../modules/ym-decode.glsl')
#pragma glslify: ymEncode = require('../../modules/ym-encode.glsl')

uniform vec2 resolution;
uniform bool isVert;
uniform int blockSize;
uniform sampler2D inputTexture;

float readTexel(vec2 uv) { return ymDecode(texture2D(inputTexture, uv)); }

#pragma glslify: dctForwardY = require('../../modules/dct-forward-y.glsl', readTexel=readTexel)

void main() {
  gl_FragColor = ymEncode(dctForwardY(gl_FragCoord.xy, resolution, isVert, blockSize));
}
