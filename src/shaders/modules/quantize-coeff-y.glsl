#pragma glslify: quantize = require('./quantize.glsl')

// Quantize a single float luminance DCT coefficient.
// Scalar version of quantizeCoeff — used in Y-only mode where chroma/alpha are absent.
float quantizeCoeffY(float lum, float len, float highFreqMultiplier, float qY, float qYf) {
  lum *= 1.0 + len * highFreqMultiplier;
  return quantize(lum, qY + qYf * len);
}

#pragma glslify: export(quantizeCoeffY)
