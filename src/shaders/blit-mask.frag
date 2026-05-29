precision highp float;
uniform sampler2D inputTexture;
uniform vec2 resolution;
uniform vec2 uvScale;
uniform vec2 uvOffset;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  uv = uv * uvScale + uvOffset;
  vec2 inBounds = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  float mask = inBounds.x * inBounds.y;
  gl_FragColor = texture2D(inputTexture, uv) * mask;
}
