import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import glslify from 'glslify';
import path from 'path';

const glslPlugin = {
  name: 'glslify',
  transform(src, id) {
    if (!/\.(frag|vert|glsl)$/.test(id)) return null;
    const code = glslify.compile(src, { basedir: path.dirname(id) });
    return `export default ${JSON.stringify(code)}`;
  },
};

export default {
  input: 'src/index.js',
  output: [
    {
      file: 'dist/dctlive.js',
      format: 'iife',
      name: 'DCTLiveModule',
      exports: 'named',
      footer: '/* Expose default export as global DCTLive */\nvar DCTLive = DCTLiveModule.default;\nDCTLive.InputSource = DCTLiveModule.InputSource;',
    },
    {
      file: 'dist/dctlive.esm.js',
      format: 'es',
    },
  ],
  plugins: [
    glslPlugin,
    resolve(),
    commonjs(),
  ],
};
