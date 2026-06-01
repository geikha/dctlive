// Round value to the nearest multiple of stepSize.
// stepSize=0 is safe — clamped to 1e-6 to avoid division by zero.
float quantize(float value, float stepSize) {
  float s = max(stepSize, 1e-6);
  return floor(value / s + 0.5) * s;
}

#pragma glslify: export(quantize)
