// Decode a YM-encoded vec4 back to a single float.
// Reverses ymEncode: read R (companded value) and G (scale), reconstruct the original.
#define RGBM_MAX 4.0

float ymDecode(vec4 enc) {
  float mv = enc.y * enc.y * RGBM_MAX;  // recover scale from G channel
  float cmp = enc.x * 2.0 - 1.0;       // undo [0,1] remap → [-1,1]
  return (cmp * abs(cmp)) * mv;         // undo sqrt-compand, rescale
}

#pragma glslify: export(ymDecode)
