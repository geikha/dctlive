#define PI 3.14159265

// 1D forward DCT, scalar (Y-only) variant. Same math as dct-forward.glsl but
// operates on a single float channel — cheaper inner loop for luminance-only processing.
// The caller injects readTexel(vec2 uv) → float.
float dctForwardY(vec2 fragCoord, vec2 resolution, bool isVert, int blockSize) {
  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  vec2 block = bv * float(blockSize - 1) + vec2(1.0);
  vec2 blockOrigin = 0.5 + floor(fragCoord / block) * block;
  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));

  float freq = floor(mod(dot(bv, fragCoord), float(blockSize))) / float(bs) * PI;
  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);

  float sum = 0.0;
  for (int i = 0; i < 1024; i++) {
    if (bs <= i) break;
    vec2 uv = (blockOrigin + float(i) * bv) / resolution;
    float w = cos((float(i) + 0.5) * freq);
    sum += w * factor * readTexel(uv);
  }
  return sum;
}

#pragma glslify: export(dctForwardY)
