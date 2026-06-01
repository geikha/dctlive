#define PI 3.14159265
// 0 = horizontal pass, 1 = vertical pass. Injected by shader provider via patchDefines.
#define DCTLIVE_IS_VERT 0

// 1D inverse DCT: reconstruct one spatial output pixel from frequency coefficients.
//
// This fragment's output position determines which spatial position it reconstructs.
// Formula: x[delta] = Σ(k=0..N-1) F[k] * wave(delta*k*π/N)
//   delta: spatial position within block (0 to N-1), read from fragment position
//   F[k]: frequency coefficient at index k (read from input texture)
//   N: effective block size (clamped to image boundary)
//   wave(angle): reconstruction basis function (normally cos for DCT-II)
//   lpf: low-pass filter limit (only sum k from 0 to min(lpf, N-1))
//
// Injected by caller:
//   readTexel(vec2 uv) -> vec4  -- read coefficient; handles any codec wrapping (see 8 bit versions)
//   wave(float angle) -> float  -- the reconstruction basis function, cos() by default
vec4 dctInverse(vec2 fragCoord, vec2 resolution, int blockSize, float lpf) {
  // Scan direction: horizontal (reconstruct spatial X) or vertical (reconstruct spatial Y)
  #if DCTLIVE_IS_VERT == 1
  vec2 direction = vec2(0.0, 1.0);
  #else
  vec2 direction = vec2(1.0, 0.0);
  #endif

  // Locate the block containing this fragment.
  // blockStride: distance (in texels) between consecutive block starts in this direction
  // blockOrigin: position of the top-left corner of this fragment's block
  // N: effective block size, clamped to image boundary (may be < blockSize at edges)
  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);
  vec2 blockOrigin = 0.5 + floor(fragCoord / blockStride) * blockStride;
  int N = int(min(float(blockSize), dot(direction, resolution - blockOrigin + 0.5)));

  // Limit reconstruction to the first `loopLimit` frequency bins (low-pass filter).
  // loopLimit = 1: DC only. loopLimit = N: full reconstruction.
  int loopLimit = int(min(float(N), lpf));

  // This fragment's spatial position within its block (0 to N-1), scaled to [0, π]
  float delta = mod(dot(direction, fragCoord), float(blockSize)) / float(N) * PI;

  vec4 sum = vec4(0.0);
  for (int k = 0; k < 1024; k++) {
    if (loopLimit <= k) break;
    vec4 coeff = readTexel((blockOrigin + direction * float(k)) / resolution);
    sum += wave(delta * float(k)) * coeff;
  }
  return sum;
}

#pragma glslify: export(dctInverse)
