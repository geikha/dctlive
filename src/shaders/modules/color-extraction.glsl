// Extract luminance (Y) from RGBA using ITU-R BT.601 weights

float extractLuminance(vec4 rgba) {
  return dot(rgba.rgb, vec3(0.299, 0.587, 0.114));
}
