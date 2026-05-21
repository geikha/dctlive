/*
  Inverse DCT shader (jpeg-render)
  Reconstructs spatial image from DCT coefficients.
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

bool validuv(vec2 v) {
  return 0.0 < v.x && v.x < 1.0 && 0.0 < v.y && v.y < 1.0;
}

// YCbCr to RGB conversion
vec3 ycbcr2rgb(vec3 yuv) {
  return vec3(
    yuv.x + 1.402    * yuv.z,
    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,
    yuv.x + 1.772    * yuv.y
  );
}

// Waveform function (replaceable via JS API)
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

  // On final (vertical) pass, convert back to RGB
  if (isVert) {
    sum.rgb = ycbcr2rgb(sum.rgb);
  }

  gl_FragColor = sum;
}
