#define PI 3.14159265
#define DCTLIVE_IS_VERT 0

// 1D forward DCT: compute one frequency coefficient F[k] for a spatial block.
//
// This fragment's output position determines which frequency bin it represents.
// Formula: F[k] = scale * Σ(n=0..N-1) x[n] * cos((n+0.5)*k*π/N)
//   k: frequency index (0=DC, 1..N-1=harmonics) within the block
//   x[n]: input sample at spatial position n in the block
//   N: effective block size (clamped to image boundary)
//   scale: DCT-II orthonormal factor (1/N for DC, 2/N for harmonics)
//
// Injected by caller:
//   readTexel(vec2 uv) -> vec4  -- read input sample; handles any codec wrapping (see 8 bit versions)
vec4 dctForward(vec2 fragCoord, vec2 resolution, int blockSize) {
  // Scan direction: horizontal (freq along x) or vertical (freq along y)
  #if DCTLIVE_IS_VERT == 1
  vec2 direction = vec2(0.0, 1.0);
  #else
  vec2 direction = vec2(1.0, 0.0);
  #endif

  // Locate the block containing this fragment.
  // blockStride: distance (in texels) between consecutive block starts in this direction
  // blockCorner: position of the top-left corner of this fragment's block
  // N: effective block size, clamped to image boundary (may be < blockSize at edges)
  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);
  vec2 blockCorner = 0.5 + floor(fragCoord / blockStride) * blockStride;
  int N = int(min(float(blockSize), dot(direction, resolution - blockCorner + 0.5)));

  // Compute this fragment's frequency index (0 to N-1), then scale to [0, π]
  float freq = floor(mod(dot(direction, fragCoord), float(blockSize))) / float(N) * PI;

  // DCT-II orthonormal scaling: 1/N for DC (freq≈0), 2/N for harmonics.
  // Using branchless step() to avoid GPU branch prediction penalty.
  float scale = (1.0 + step(0.001, abs(freq))) / float(N);

  vec4 sum = vec4(0.0);
  for (int n = 0; n < 1024; n++) {
    if (N <= n) break;
    vec2 sampleUv = (blockCorner + float(n) * direction) / resolution;
    float basis = cos((float(n) + 0.5) * freq);
    sum += basis * scale * readTexel(sampleUv);
  }
  return sum;
}

#pragma glslify: export(dctForward)
