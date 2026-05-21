# dctlive

WebGL implementation of JPEG-like DCT (Discrete Cosine Transform) with real-time controls.

## Usage

```js
import DCTLive from 'dctlive';

const dct = new DCTLive({
  width: 512,
  height: 512,
  loop: true
});

dct.initImage('path/to/image.png').then(() => {
  dct.show();
  dct.start();
});
```

## API

### `new DCTLive(options)`

| Option   | Type    | Default | Description                          |
|----------|---------|---------|--------------------------------------|
| `width`  | number  | 256     | Canvas width                         |
| `height` | number  | 256     | Canvas height                        |
| `loop`   | boolean | false   | Auto-run shader each frame           |
| `canvas` | HTMLCanvasElement | auto | Provide your own canvas element |

### Methods

#### Input & Rendering
- **`initImage(url, opts)`** — Load an image. Options: `{ fit, minFilter, magFilter, wrap }`.
- **`initVideo(video, opts)`** — Use an HTMLVideoElement as input. Same options as `initImage()`.
- **`initCanvas(canvas, opts)`** — Use another canvas as input.
- **`run()`** — Execute the DCT/IDCT pipeline once.
- **`start()`** — Begin the render loop.
- **`stop()`** — Stop the render loop.

#### Display
- **`show()`** — Make the canvas visible.
- **`hide()`** — Hide the canvas.
- **`mount(parent)`** — Append the canvas to a DOM element (default: `document.body`).
- **`unmount()`** — Remove the canvas from the DOM.

#### Pass Control
- **`setDCT(horizontal, vertical)`** — Control which forward DCT passes run. `vertical` defaults to `horizontal` if not specified.
- **`setRDCT(horizontal, vertical)`** — Control which inverse DCT passes run. `vertical` defaults to `horizontal` if not specified.

**Note:** When all passes are disabled, the input texture is copied directly to the output canvas without any shader transforms (via passthrough).

#### Configuration
- **`setUniform(name, value)`** — Set a shader uniform.
- **`setUniforms(obj)`** — Batch-set multiple uniforms.
- **`setWaveFunction(glslBody)`** — Replace the wave function in the inverse DCT shader.
- **`setResolution(width, height)`** — Change the processing resolution.
- **`setDisplaySize(width, height)`** — Change the canvas display size.
- **`setFPS(fps)`** — Limit render frame rate (0 = unlimited).

### Uniforms

| Uniform             | Type  | Default | Description                             |
|---------------------|-------|---------|-----------------------------------------|
| `blockSize`         | int   | 8       | DCT block size (2–64, like JPEG 8×8)    |
| `lpf`               | float | 128.0   | Low-pass filter cutoff                  |
| `highFreqMultiplier`| float | 0.0     | Boost/cut high-frequency coefficients   |
| `quantizeY`         | float | 0.0     | Luminance quantization (0–100)          |
| `quantizeYf`        | float | 0.0     | Luminance quantization freq-dependent   |
| `quantizeC`         | float | 0.0     | Chrominance quantization (0–100)        |
| `quantizeCf`        | float | 0.0     | Chrominance quantization freq-dependent |
| `quantizeA`         | float | 0.0     | Alpha quantization (0–100)              |
| `quantizeAf`        | float | 0.0     | Alpha quantization freq-dependent       |

## Examples

### Basic setup with loop
```js
const dct = new DCTLive({ width: 512, height: 512, loop: true });
dct.initImage('image.png');
dct.mount(document.body);
dct.show();
```

### Granular pass control
```js
// Show only DCT coefficients (skip inverse DCT)
dct.setDCT(true, true);   // both horizontal and vertical
dct.setRDCT(false, false); // disable all inverse passes
dct.run();

// Apply only horizontal inverse DCT
dct.setDCT(true, true);
dct.setRDCT(true, false);
dct.run();

// Skip all transforms (output input directly)
dct.setDCT(false, false);
dct.setRDCT(false, false);
dct.run(); // canvas shows raw input image
```

### Dynamic parameter control
```js
dct.setUniform('blockSize', 16);
dct.setUniform('quantizeY', 0.5);
dct.setUniforms({
  blockSize: 8,
  lpf: 100,
  highFreqMultiplier: 0.5
});
```

## Usage Notes

- The render loop (`start()`) can begin before an input source is loaded. It will activate once `initImage()`, `initVideo()`, or `initCanvas()` supplies content.
- `initImage(url)` returns a promise but doesn't require `await` if the loop is already running.
- Pass control (`setDCT()`, `setRDCT()`) affects the next call to `run()`. Default is all passes enabled (full DCT→IDCT pipeline).
- `setDisplaySize()` only affects canvas CSS display size; use `setResolution()` to change processing dimensions.
- When all passes are disabled, the library uses a fast passthrough shader instead of running transforms.

## Development

```bash
npm install
npm run build
npm run serve   # serves /demo on localhost
```

## Credits & Acknowledgments

**Design & API:** geikha
**DCT shader reference:** [FMS-Cat](https://twitter.com/FMS_Cat) — [Testing DCT quantization shader](https://www.youtube.com/watch?v=xt4UFRPqX_w)  
**Guidance:** [sol sarratea](https://solsarratea.world/)

The heavy lifting of coding with WebGL (the API, not the shaders) in this library was done using Claude Code. It also helped documenting, adding comments, and separating the codebase into different files.
