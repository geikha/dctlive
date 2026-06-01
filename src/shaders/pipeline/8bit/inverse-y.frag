precision highp float;

#pragma glslify: ymDecode = require('../../modules/ym-decode.glsl')
#pragma glslify: ymEncode = require('../../modules/ym-encode.glsl')

uniform vec2 resolution;
uniform int blockSize;
uniform sampler2D inputTexture;
uniform float lpf;
uniform float time;
uniform float wi;

float readTexel(vec2 uv) { return ymDecode(texture2D(inputTexture, uv)); }

// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().
#define DCTLIVE_WAVE_BODY return cos(angle);
float wave(float angle) { DCTLIVE_WAVE_BODY }

#pragma glslify: dctInverseY = require('../../modules/dct-inverse-y.glsl', readTexel=readTexel, wave=wave)

void main() {
  gl_FragColor = ymEncode(dctInverseY(gl_FragCoord.xy, resolution, blockSize, lpf));
}
