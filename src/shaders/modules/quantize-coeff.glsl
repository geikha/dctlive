#pragma glslify: quantize = require('./quantize.glsl')

// Quantize a vec4 DCT coefficient (Y, Cb, Cr, A channels independently).
// `len` is the Euclidean distance from the block's DC corner to this frequency bin —
// used to scale the step size up for high-frequency coefficients (mimics JPEG's
// quantization matrix). highFreqMultiplier amplifies the coefficient itself first.
vec4 quantizeCoeff(vec4 coeff, float len, float highFreqMultiplier,
    float qY, float qYf, float qC, float qCf, float qA, float qAf) {
  coeff *= 1.0 + len * highFreqMultiplier;

  float stepY = qY + qYf * len;
  coeff.x = stepY > 0.0 ? quantize(coeff.x, stepY) : coeff.x;

  float stepC = qC + qCf * len;
  coeff.y = stepC > 0.0 ? quantize(coeff.y, stepC) : coeff.y;
  coeff.z = stepC > 0.0 ? quantize(coeff.z, stepC) : coeff.z;

  float stepA = qA + qAf * len;
  coeff.w = stepA > 0.0 ? quantize(coeff.w, stepA) : coeff.w;

  return coeff;
}

#pragma glslify: export(quantizeCoeff)
