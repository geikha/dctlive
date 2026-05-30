// Quantization function: round to nearest step, preserving symmetry around zero
// Formula: floor(value/step + 0.5) * step

float quantize(float value, float step) {
  return floor(value / step + 0.5) * step;
}
