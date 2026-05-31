// Round `value` to the nearest multiple of `step`.
// step=0 means no quantization (caller should guard against this).
float quantize(float value, float step) {
  return floor(value / step + 0.5) * step;
}

#pragma glslify: export(quantize)
