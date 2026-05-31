precision highp float;

#pragma glslify: quantizeCoeff = require('./modules/quantize-coeff.glsl')

uniform vec2 resolution;
uniform int blockSize;
uniform sampler2D inputTexture;
uniform float highFreqMultiplier;
uniform float quantizeY;
uniform float quantizeYf;
uniform float quantizeC;
uniform float quantizeCf;
uniform float quantizeA;
uniform float quantizeAf;

void main() {
  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));
  vec4 coeff = texture2D(inputTexture, gl_FragCoord.xy / resolution);
  gl_FragColor = quantizeCoeff(coeff, len, highFreqMultiplier,
    quantizeY, quantizeYf, quantizeC, quantizeCf, quantizeA, quantizeAf);
}
