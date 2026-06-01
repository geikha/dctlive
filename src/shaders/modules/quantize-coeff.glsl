#pragma glslify: quantize = require('./quantize.glsl')

// Quantize a vec4 DCT coefficient (Y, Cb, Cr, A channels independently).
// `len` is the Euclidean distance from the block's DC corner to this frequency bin —
// used to scale the step size up for high-frequency coefficients (mimics JPEG's
// quantization matrix). highFreqMultiplier amplifies the coefficient itself first.
vec4 quantizeCoeff(vec4 coeff, float len, float highFreqMultiplier,
    float qY, float qYf, float qC, float qCf, float qA, float qAf) {
  coeff *= 1.0 + len * highFreqMultiplier;

  coeff.x = quantize(coeff.x, qY + qYf * len);
  coeff.y = quantize(coeff.y, qC + qCf * len);
  coeff.z = quantize(coeff.z, qC + qCf * len);
  coeff.w = quantize(coeff.w, qA + qAf * len);

  return coeff;
}

#pragma glslify: export(quantizeCoeff)
