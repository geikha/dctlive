#define PI 3.14159265

// 1D forward DCT for one output coefficient (one fragment = one frequency bin).
// The caller injects readTexel(vec2 uv) → vec4, which handles any codec wrapping.
//
// fragCoord: gl_FragCoord.xy of the output fragment
// isVert:    true = vertical pass (down columns), false = horizontal (across rows)
// blockSize: DCT block size (e.g. 8)
//
// The fragment's position within its block determines which frequency it represents.
// Its value is the inner product of the block's input samples with the cosine basis:
//   F[k] = factor * Σ x[n] * cos((n + 0.5) * k*π/N)
// factor = 1/N for DC (k=0), 2/N otherwise — the standard orthonormal DCT-II scaling.
vec4 dctForward(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize) {
  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  vec2 block = bv * float(blockSize - 1) + vec2(1.0);
  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;
  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));

  float freq = floor(mod(dot(bv, fragCoord), float(blockSize))) / float(bs) * PI;
  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);

  vec4 sum = vec4(0.0);
  for (int i = 0; i < 1024; i++) {
    if (bs <= i) break;
    vec2 uv = (blockOrigin + float(i) * bv) / resolution;
    float w = cos((float(i) + 0.5) * freq);
    sum += w * factor * readTexel(uv);
  }
  return sum;
}

#pragma glslify: export(dctForward)
