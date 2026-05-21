import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { string } from 'rollup-plugin-string';

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
    string({ include: ['**/*.vert', '**/*.frag', '**/*.glsl'] }),
    resolve(),
    commonjs(),
  ],
};
