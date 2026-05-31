// ITU-R BT.601: convert linear RGB (0–1) to YCbCr.
// Y  = luminance.  Cb = blue-difference chroma.  Cr = red-difference chroma.
// The chroma channels are centred on zero (neutral grey = 0, not 0.5).
vec3 rgb2ycbcr(vec3 rgb) {
  return vec3(
     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,
    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,
     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b
  );
}

#pragma glslify: export(rgb2ycbcr)
