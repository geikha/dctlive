precision highp float;

uniform vec2 resolution;
uniform sampler2D inputTexture;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  gl_FragColor = texture2D(inputTexture, uv);
}
