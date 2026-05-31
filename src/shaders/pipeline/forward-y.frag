precision highp float;

uniform vec2 resolution;
uniform bool isVert;
uniform int blockSize;
uniform sampler2D inputTexture;

float readTexel(vec2 uv) { return texture2D(inputTexture, uv).x; }

#pragma glslify: dctForwardY = require('../modules/dct-forward-y.glsl', readTexel=readTexel)

void main() {
  gl_FragColor = vec4(dctForwardY(gl_FragCoord.xy, resolution, isVert, blockSize), 0.0, 0.0, 1.0);
}
