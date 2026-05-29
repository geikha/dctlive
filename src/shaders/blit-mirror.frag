precision highp float;
uniform sampler2D inputTexture;
uniform vec2 resolution;
uniform vec2 uvScale;
uniform vec2 uvOffset;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  uv = uv * uvScale + uvOffset;
  vec2 t = fract(uv * 0.5) * 2.0;
  uv = 1.0 - abs(t - 1.0);
  gl_FragColor = texture2D(inputTexture, uv);
}
