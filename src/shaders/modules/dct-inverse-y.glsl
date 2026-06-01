#define PI 3.14159265
// 0 = horizontal pass, 1 = vertical pass. Injected by shader provider via patchDefines.
#define DCTLIVE_IS_VERT 0

// Scalar variant of dctInverse (see dct-inverse.glsl for full documentation).
// Same math, outputs float instead of vec4. Cheaper for luminance-only reconstruction.
float dctInverseY(vec2 fragCoord, vec2 resolution, int blockSize, float lpf) {
  #if DCTLIVE_IS_VERT == 1
  vec2 direction = vec2(0.0, 1.0);
  #else
  vec2 direction = vec2(1.0, 0.0);
  #endif

  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);
  vec2 blockOrigin = 0.5 + floor(fragCoord / blockStride) * blockStride;
  int N = int(min(float(blockSize), dot(direction, resolution - blockOrigin + 0.5)));
  int loopLimit = int(min(float(N), lpf));

  float delta = mod(dot(direction, fragCoord), float(blockSize)) / float(N) * PI;

  float sum = 0.0;
  for (int k = 0; k < 1024; k++) {
    if (loopLimit <= k) break;
    float coeff = readTexel((blockOrigin + direction * float(k)) / resolution);
    sum += wave(delta * float(k)) * coeff;
  }
  return sum;
}

#pragma glslify: export(dctInverseY)
