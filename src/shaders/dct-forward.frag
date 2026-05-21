/*
  Forward DCT shader (jpeg-cosine)
  Computes 1D DCT along one axis (horizontal or vertical).
  Run twice (horizontal then vertical) for full 2D DCT.
*/

#define lofi(i,j) floor((i)/(j)+.5)*(j)
#define PI 3.14159265

precision highp float;

uniform vec2 resolution;
uniform bool isVert;
uniform int blockSize;
uniform sampler2D inputTexture;

uniform float highFreqMultiplier;
uniform float quantizeY;
uniform float quantizeYf;
uniform float quantizeC;
uniform float quantizeCf;
uniform float quantizeA;
uniform float quantizeAf;

// RGB to YCbCr conversion
vec3 rgb2ycbcr(vec3 rgb) {
  return vec3(
     0.299    * rgb.r + 0.587    * rgb.g + 0.114    * rgb.b,
    -0.148736 * rgb.r - 0.331264 * rgb.g + 0.5      * rgb.b,
     0.5      * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b
  );
}

void main() {
  // Direction vector: (1,0) for horizontal, (0,1) for vertical
  vec2 bv = isVert ? vec2(0.0, 1.0) : vec2(1.0, 0.0);

  // Block dimensions in pixel space along the processing axis
  vec2 block = bv * float(blockSize - 1) + vec2(1.0);

  // Origin of the current block (pixel coords, center-sampled)
  vec2 blockOrigin = 0.5 + floor(gl_FragCoord.xy / block) * block;

  // Actual block size (may be smaller at image edges)
  int bs = int(min(float(blockSize), dot(bv, resolution - blockOrigin + 0.5)));

  // Which frequency coefficient are we computing?
  // Position within block maps directly to frequency index
  float freq = floor(mod(dot(bv, gl_FragCoord.xy), float(blockSize))) / float(bs) * PI;

  // DCT normalization factor: 1/N for DC, 2/N for AC
  float factor = (freq == 0.0 ? 1.0 : 2.0) / float(bs);

  // Accumulate the DCT sum (always use full block for correct coefficients)
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 1024; i++) {
    if (bs <= i) break;

    // Offset within block to sample i-th pixel
    vec2 delta = float(i) * bv;

    // DCT basis function: cos((x + 0.5) * freq)
    float wave = cos((float(i) + 0.5) * freq);

    // Convert pixel coords to UV
    vec2 uv = (blockOrigin + delta) / resolution;

    // Flip Y on horizontal pass (WebGL texture coords vs image coords)
    if (!isVert) {
      uv = vec2(0.0, 1.0) + vec2(1.0, -1.0) * uv;
    }

    vec4 val = texture2D(inputTexture, uv);

    // Convert RGB -> YCbCr on first (horizontal) pass
    if (!isVert) {
      val.rgb = rgb2ycbcr(val.rgb);
    }

    sum += wave * factor * val;
  }

  // Quantization (only after vertical pass = full 2D DCT done)
  if (isVert) {
    // Distance from DC component within block (frequency magnitude)
    float len = length(floor(mod(gl_FragCoord.xy, float(blockSize))));

    // Quantize luminance (Y)
    float qY = quantizeY + quantizeYf * len;
    sum.x = qY > 0.0 ? lofi(sum.x, qY) : sum.x;

    // Quantize chrominance (Cb, Cr)
    float qC = quantizeC + quantizeCf * len;
    sum.yz = qC > 0.0 ? lofi(sum.yz, qC) : sum.yz;

    // Quantize alpha
    float qA = quantizeA + quantizeAf * len;
    sum.w = qA > 0.0 ? lofi(sum.w, qA) : sum.w;

    // High frequency boost/cut
    sum *= 1.0 + len * highFreqMultiplier;
  }

  gl_FragColor = sum;
}
