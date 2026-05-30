/*
  Quantization shader - applies lofi quantization to DCT coefficients
  Input: raw DCT coefficients (from Forward H or V pass)
  Output: quantized coefficients ready for inverse
  Runs between forward and inverse when any DCT pass is enabled
*/

precision highp float;

uniform vec2 resolution;
uniform int blockSize;
uniform sampler2D inputTexture;

uniform float quantizeY;
uniform float quantizeYf;
uniform float quantizeC;
uniform float quantizeCf;
uniform float quantizeA;
uniform float quantizeAf;
uniform bool isColorMode;

// Quantization: round to nearest step, preserving symmetry around zero
float quantize(float value, float step) {
  return floor(value / step + 0.5) * step;
}

void main() {
  // Read DCT coefficient at this fragment
  vec4 coeff = texture2D(inputTexture, gl_FragCoord.xy / resolution);

  // Distance from DC component within block (frequency magnitude)
  float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));

  // Quantize luminance (Y) - always present
  float qY = quantizeY + quantizeYf * len;
  coeff.x = qY > 0.0 ? quantize(coeff.x, qY) : coeff.x;

  // Quantize chrominance (Cb, Cr) and alpha in color mode
  if (isColorMode) {
    float qC = quantizeC + quantizeCf * len;
    coeff.y = qC > 0.0 ? quantize(coeff.y, qC) : coeff.y;
    coeff.z = qC > 0.0 ? quantize(coeff.z, qC) : coeff.z;

    float qA = quantizeA + quantizeAf * len;
    coeff.w = qA > 0.0 ? quantize(coeff.w, qA) : coeff.w;
  }

  gl_FragColor = coeff;
}
