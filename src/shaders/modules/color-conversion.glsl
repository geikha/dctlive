// RGB ↔ YCbCr color space conversion (ITU-R BT.601)

vec3 rgb2ycbcr(vec3 rgb) {
  return vec3(
     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,
    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,
     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b
  );
}

vec3 ycbcr2rgb(vec3 yuv) {
  return vec3(
    yuv.x + 1.402    * yuv.z,
    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,
    yuv.x + 1.772    * yuv.y
  );
}
