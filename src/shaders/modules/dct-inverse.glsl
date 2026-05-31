#define PI 3.14159265

// 1D inverse DCT for one output pixel (one fragment = one spatial position).
// The caller injects:
//   readTexel(vec2 uv) -> vec4  -- read a coefficient; handles any codec wrapping
//   wave(float angle) -> float  -- the reconstruction basis function (normally cos)
//
// lpf: low-pass filter limit -- only the first `lpf` frequency bins are summed.
//   lpf = blockSize: full reconstruction.  lpf = 1: DC only (flat coloured blocks).
//
// The fragment's position within its block is `delta` (0 to blockSize-1).
// Each frequency bin k contributes: F[k] * wave(delta * k * PI / N)
vec4 dctInverse(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize, float lpf) {
  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  vec2 block = bv * float(blockSize - 1) + vec2(1.0);
  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;
  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));
  int loopLimit = int(min(float(bs), lpf));

  float delta = mod(dot(bv, fragCoord), float(blockSize));

  vec4 sum = vec4(0.0);
  for (int i = 0; i < 1024; i++) {
    if (loopLimit <= i) break;
    float fdelta = float(i);
    vec4 val = readTexel((blockOrigin + bv * fdelta) / resolution);
    sum += wave(delta * fdelta / float(bs) * PI) * val;
  }
  return sum;
}

#pragma glslify: export(dctInverse)
