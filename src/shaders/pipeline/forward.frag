precision highp float;

uniform vec2 resolution;
uniform bool isVert;
uniform int blockSize;
uniform sampler2D inputTexture;

vec4 readTexel(vec2 uv) { return texture2D(inputTexture, uv); }

#pragma glslify: dctForward = require('../modules/dct-forward.glsl', readTexel=readTexel)

void main() {
  gl_FragColor = dctForward(gl_FragCoord.xy, resolution, isVert, blockSize);
}
