#define PI 3.14159265
#define DCTLIVE_IS_VERT 0

// Scalar variant of dctForward (see dct-forward.glsl for full documentation).
// Same math, outputs float instead of vec4. Cheaper for luminance-only processing.
float dctForwardY(vec2 fragCoord, vec2 resolution, int blockSize) {
  #if DCTLIVE_IS_VERT == 1
  vec2 direction = vec2(0.0, 1.0);
  #else
  vec2 direction = vec2(1.0, 0.0);
  #endif

  vec2 blockStride = direction * float(blockSize - 1) + vec2(1.0);
  vec2 blockCorner = 0.5 + floor(fragCoord / blockStride) * blockStride;
  int N = int(min(float(blockSize), dot(direction, resolution - blockCorner + 0.5)));

  float k = floor(mod(dot(direction, fragCoord), float(blockSize))) / float(N) * PI;
  float scale = (1.0 + step(0.001, abs(k))) / float(N);

  float sum = 0.0;
  for (int n = 0; n < 1024; n++) {
    if (N <= n) break;
    vec2 sampleUv = (blockCorner + float(n) * direction) / resolution;
    float basis = cos((float(n) + 0.5) * k);
    sum += basis * scale * readTexel(sampleUv);
  }
  return sum;
}

#pragma glslify: export(dctForwardY)
