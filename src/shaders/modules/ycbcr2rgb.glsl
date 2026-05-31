// ITU-R BT.601 inverse: YCbCr → linear RGB.
// Exact inverse of rgb2ycbcr — chroma channels are zero-centred.
vec3 ycbcr2rgb(vec3 yuv) {
  return vec3(
    yuv.x + 1.402    * yuv.z,
    yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z,
    yuv.x + 1.772    * yuv.y
  );
}

#pragma glslify: export(ycbcr2rgb)
