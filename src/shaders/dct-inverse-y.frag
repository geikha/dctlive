/*
  Inverse DCT shader - Y-only mode (grayscale)
  Reconstructs spatial image from DCT coefficients, luminance channel only.
  Run twice (horizontal then vertical) for full 2D IDCT.
*/

#define PI 3.14159265
#define PI2 6.28318530
#define hPI 1.57079632

precision highp float;

uniform vec2 resolution;
uniform bool isVert;
uniform int blockSize;
uniform sampler2D inputTexture;
uniform float lpf;
uniform float time;
uniform float wi;

bool validuv(vec2 v) {
  return 0.0 < v.x && v.x < 1.0 && 0.0 < v.y && v.y < 1.0;
}

// Waveform function (replaceable via JS API)
// Parameters: angle (phase angle), time (current time in ms), wi (wave input parameter)
float wave(float angle) {
  return cos(angle);
}

void main() {
  // Direction vector
  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);

  // Block dimensions
  vec2 block = bv * float(blockSize - 1) + vec2(1.0);
  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;
  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));
  int loopLimit = int(min(float(bs), lpf));

  // Spatial position within block (which pixel are we reconstructing?)
  float delta = mod(dot(bv, gl_FragCoord.xy), float(blockSize));

  // Accumulate IDCT sum
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 1024; i++) {
    if (loopLimit <= i) break;

    float fdelta = float(i);

    // Read DCT coefficient for frequency i
    vec4 val = texture2D(inputTexture, (blockOrigin + bv * fdelta) / resolution);

    // IDCT basis function
    float awave = wave(delta * fdelta / float(bs) * PI);

    sum += awave * val;
  }

  // On final (vertical) pass, output luminance as grayscale
  if (isVert) {
    sum = vec4(sum.x, sum.x, sum.x, sum.w);
  }

  gl_FragColor = sum;
}
