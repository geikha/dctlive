precision highp float;

#pragma glslify: ycbcr2rgb = require('./modules/ycbcr2rgb.glsl')

uniform vec2 resolution;
uniform sampler2D inputTexture;
uniform bool yOnlyMode;
uniform bool flipY;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  if (flipY) uv.y = 1.0 - uv.y;
  vec4 color = texture2D(inputTexture, uv);

  if (yOnlyMode) {
    color.rgb = vec3(color.x);
    color.a = 1.0;
  } else {
    color.rgb = ycbcr2rgb(color.rgb);
  }

  gl_FragColor = color;
}
