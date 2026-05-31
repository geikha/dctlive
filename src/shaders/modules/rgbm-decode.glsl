// Decode an RGBM-encoded vec4 back to its original high-range values.
// Reverses rgbmEncode: undo the [0,1] remap, undo sqrt-companding, rescale by M.
#define RGBM_MAX 4.0

vec4 rgbmDecode(vec4 enc) {
  float mv = enc.w * enc.w * RGBM_MAX;      // recover scale from alpha
  vec3 cmp = enc.xyz * 2.0 - 1.0;           // undo [0,1] remap → [-1,1]
  return vec4((cmp * abs(cmp)) * mv, 1.0);  // undo sqrt-compand, rescale
}

#pragma glslify: export(rgbmDecode)
