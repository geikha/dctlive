// YM encoding: pack a single high-range float into R+G channels of an 8-bit vec4.
// Same companding as RGBM but for one channel: R = sqrt-companded value, G = scale.
// B and A are unused (set to 1.0). Decode with ymDecode.
#define RGBM_MAX 4.0

vec4 ymEncode(float lum) {
  float mv = clamp(abs(lum), 0.01, RGBM_MAX);
  float norm = lum / mv;
  return vec4((sign(norm) * sqrt(abs(norm))) * 0.5 + 0.5, sqrt(mv / RGBM_MAX), 1.0, 1.0);
}

#pragma glslify: export(ymEncode)
