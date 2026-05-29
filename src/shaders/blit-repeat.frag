precision highp float;
uniform sampler2D inputTexture;
uniform vec2 resolution;
uniform vec2 uvScale;
uniform vec2 uvOffset;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  gl_FragColor = texture2D(inputTexture, fract(uv * uvScale + uvOffset));
}
