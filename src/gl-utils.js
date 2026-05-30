/**
 * WebGL helper utilities for DCTLive.
 * Handles shader compilation, program linking, framebuffer creation,
 * and uniform/attribute helpers.
 */

/**
 * Compile a WebGL shader from source.
 * @param {WebGLRenderingContext} gl
 * @param {number} type - gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
 * @param {string} source
 * @returns {WebGLShader}
 */
export function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile error:\n' + info);
  }
  return shader;
}

/**
 * Link a vertex and fragment shader into a program.
 * @param {WebGLRenderingContext} gl
 * @param {WebGLShader} vert
 * @param {WebGLShader} frag
 * @returns {WebGLProgram}
 */
export function createProgram(gl, vert, frag) {
  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Program link error:\n' + info);
  }
  return program;
}

/**
 * Build a complete shader program from source strings.
 * @param {WebGLRenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 * @returns {WebGLProgram}
 */
export function buildProgram(gl, vertSrc, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  return createProgram(gl, vert, frag);
}

/**
 * Build a program with preprocessor defines injected into the fragment shader.
 * @param {WebGLRenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 * @param {Object} defines - e.g. { COLOR_ENABLED: 1, SOME_FLAG: 0 }
 * @returns {WebGLProgram}
 */
export function buildProgramWithDefines(gl, vertSrc, fragSrc, defines) {
  // Inject #define statements at the beginning of fragment shader
  let defineStr = '';
  for (const [key, value] of Object.entries(defines)) {
    defineStr += `#define ${key} ${value}\n`;
  }
  const fragWithDefines = defineStr + fragSrc;

  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragWithDefines);
  return createProgram(gl, vert, frag);
}

/**
 * Create a framebuffer with the given texture type.
 * @param {WebGLRenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @param {number} texType - gl.FLOAT, HALF_FLOAT_OES, or gl.UNSIGNED_BYTE
 * @returns {{ framebuffer: WebGLFramebuffer, texture: WebGLTexture }}
 */
export function createFramebuffer(gl, width, height, texType) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, texType, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { framebuffer, texture };
}

/**
 * Resolve the best available texture type for the requested precision.
 * Fallback chain: '32bit' → float → half-float → UNSIGNED_BYTE
 *                 '16bit' → half-float → UNSIGNED_BYTE
 *                 '8bit'  → UNSIGNED_BYTE (always)
 * @param {WebGLRenderingContext} gl
 * @param {'32bit'|'16bit'|'8bit'} [requested='16bit']
 * @returns {{ type: number, actual: '32bit'|'16bit'|'8bit' }}
 */
export function resolveTexType(gl, requested = '16bit') {
  if (requested !== '8bit') {
    if (requested === '32bit') {
      const extFloat = gl.getExtension('OES_texture_float');
      if (extFloat) {
        gl.getExtension('OES_texture_float_linear');
        return { type: gl.FLOAT, actual: '32bit' };
      }
    }
    const extHalf = gl.getExtension('OES_texture_half_float');
    if (extHalf) {
      gl.getExtension('OES_texture_half_float_linear');
      return { type: extHalf.HALF_FLOAT_OES, actual: '16bit' };
    }
  }
  if (requested !== '8bit') {
    console.warn('DCTLive: float/half-float textures unavailable, falling back to 8-bit precision');
  }
  return { type: gl.UNSIGNED_BYTE, actual: '8bit' };
}

export const createFloatFramebuffer = (gl, w, h) => createFramebuffer(gl, w, h, gl.FLOAT);

/**
 * Create a texture from an HTMLImageElement.
 * @param {WebGLRenderingContext} gl
 * @param {HTMLImageElement} image
 * @returns {WebGLTexture}
 */
export function createTextureFromImage(gl, image) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
