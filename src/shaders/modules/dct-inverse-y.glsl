#define PI 3.14159265

// 1D inverse DCT, scalar (Y-only) variant. Same math as dct-inverse.glsl but
// accumulates a single float -- cheaper inner loop for luminance-only reconstruction.
// The caller injects readTexel(vec2 uv) -> float and wave(float) -> float.
float dctInverseY(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize, float lpf) {
  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  vec2 block = bv * float(blockSize - 1) + vec2(1.0);
  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;
  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));
  int loopLimit = int(min(float(bs), lpf));

  float delta = mod(dot(bv, fragCoord), float(blockSize));

  float sum = 0.0;
  for (int i = 0; i < 1024; i++) {
    if (loopLimit <= i) break;
    float fdelta = float(i);
    float lum = readTexel((blockOrigin + bv * fdelta) / resolution);
    sum += wave(delta * fdelta / float(bs) * PI) * lum;
  }
  return sum;
}

#pragma glslify: export(dctInverseY)
