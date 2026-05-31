precision highp float;

#pragma glslify: quantizeCoeffY = require('./modules/quantize-coeff-y.glsl')

uniform vec2 resolution;
uniform int blockSize;
uniform sampler2D inputTexture;
uniform float highFreqMultiplier;
uniform float quantizeY;
uniform float quantizeYf;

void main() {
  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));
  float lum = texture2D(inputTexture, gl_FragCoord.xy / resolution).x;
  gl_FragColor = vec4(quantizeCoeffY(lum, len, highFreqMultiplier, quantizeY, quantizeYf), 0.0, 0.0, 1.0);
}
