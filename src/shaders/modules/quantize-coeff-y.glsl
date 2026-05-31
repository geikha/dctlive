#pragma glslify: quantize = require('./quantize.glsl')

// Quantize a single float luminance DCT coefficient.
// Scalar version of quantizeCoeff — used in Y-only mode where chroma/alpha are absent.
float quantizeCoeffY(float lum, float len, float highFreqMultiplier, float qY, float qYf) {
  lum *= 1.0 + len * highFreqMultiplier;
  float stepY = qY + qYf * len;
  return stepY > 0.0 ? quantize(lum, stepY) : lum;
}

#pragma glslify: export(quantizeCoeffY)
