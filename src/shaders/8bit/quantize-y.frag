precision highp float;

#pragma glslify: ymDecode = require('../modules/ym-decode.glsl')
#pragma glslify: ymEncode = require('../modules/ym-encode.glsl')
#pragma glslify: quantizeCoeffY = require('../modules/quantize-coeff-y.glsl')

uniform vec2 resolution;
uniform int blockSize;
uniform sampler2D inputTexture;
uniform float highFreqMultiplier;
uniform float quantizeY;
uniform float quantizeYf;

void main() {
  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));
  float lum = ymDecode(texture2D(inputTexture, gl_FragCoord.xy / resolution));
  gl_FragColor = ymEncode(quantizeCoeffY(lum, len, highFreqMultiplier, quantizeY, quantizeYf));
}
