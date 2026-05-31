// RGBM encoding: pack a high-range vec4 into 8-bit RGBA.
//
// The three colour channels are normalized by their maximum absolute value (the "M"),
// then sqrt-companded to concentrate precision near zero.
// The scale factor M is stored in alpha after its own sqrt-compand.
//
// RGBM_MAX is the assumed coefficient ceiling — values above it clamp.
// The DCT normalization factor (2/blockSize) keeps coefficients bounded regardless
// of block size, so RGBM_MAX = 4.0 is safe across all block sizes.
//
// Decode with rgbmDecode.
#define RGBM_MAX 4.0

vec4 rgbmEncode(vec4 val) {
  float mv = max(max(abs(val.x), abs(val.y)), abs(val.z));
  mv = clamp(mv, 0.01, RGBM_MAX);
  vec3 nrm = val.xyz / mv;
  // sqrt-compand + remap to [0,1] for unsigned 8-bit storage
  return vec4((sign(nrm) * sqrt(abs(nrm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX));
}

#pragma glslify: export(rgbmEncode)
