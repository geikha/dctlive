precision highp float;

#pragma glslify: rgbmDecode = require('../../modules/rgbm-decode.glsl')
#pragma glslify: rgbmEncode = require('../../modules/rgbm-encode.glsl')

uniform vec2 resolution;
uniform int blockSize;
uniform sampler2D inputTexture;
uniform float lpf;
uniform float time;
uniform float wi;

vec4 readTexel(vec2 uv) { return rgbmDecode(texture2D(inputTexture, uv)); }

// DCTLIVE_WAVE_BODY is replaced at runtime by setWaveFunction().
#define DCTLIVE_WAVE_BODY return cos(angle);
float wave(float angle) { DCTLIVE_WAVE_BODY }

#pragma glslify: dctInverse = require('../../modules/dct-inverse.glsl', readTexel=readTexel, wave=wave)

void main() {
  gl_FragColor = rgbmEncode(dctInverse(gl_FragCoord.xy, resolution, blockSize, lpf));
}
