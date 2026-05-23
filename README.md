# dctlive

WebGL implementation of JPEG-like DCT (Discrete Cosine Transform) with real-time controls.

## Usage

```js
import DCTLive from 'dctlive';

const dct = new DCTLive({ width: 512, height: 512 });

await dct.initImage('path/to/image.png');
dct.show();
dct.start();
```

## API

### `new DCTLive(options)`

| Option   | Type    | Default | Description                          |
|----------|---------|---------|--------------------------------------|
| `width`  | number  | 256     | Canvas width                         |
| `height` | number  | 256     | Canvas height                        |
| `loop`   | boolean | **true**| Auto-run shader each frame           |
| `canvas` | HTMLCanvasElement | auto | Provide your own canvas element |

### Methods

#### Input & Rendering
- **`initImage(url, opts)`** — Load an image URL or HTMLImageElement. Options: `{ fit, minFilter, magFilter, wrap }`. Returns a Promise.
- **`initVideo(video, opts)`** — Load a video URL or HTMLVideoElement as dynamic input. Same options. Returns a Promise.
- **`initCanvas(canvas, opts)`** — Use another canvas as input. Accepts HTMLCanvasElement, CanvasRenderingContext2D, or Hydra-style wrappers. Returns a Promise.
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
- **`setUniform(name, value)`** — Set a shader uniform by name.
- **`setUniforms(obj)`** — Batch-set multiple uniforms.
- **`setWaveFunction(glslBody)`** — Replace the wave function in the inverse DCT shader.
- **`setResolution(width, height)`** — Change the WebGL processing resolution (does not affect CSS display size).
- **`resizeCanvas(width, height)`** — Change the canvas CSS display size only (number treated as `px`, or any CSS string).

#### FPS / Frame Rate
Control frame rate via the `fps` getter/setter:
```js
dct.fps = 30;   // limit to 30 fps
dct.fps = 0;    // unlimited (default)
console.log(dct.fps); // read current value
```

### Uniforms

Uniforms can be set via `setUniform` / `setUniforms`, or directly as shorthand properties on the instance:

```js
dct.blockSize = 16;
dct.lpf = 64;
dct.qY = 0.5;          // shorthand for quantizeY
dct.hfreq = 0.3;       // shorthand for highFreqMultiplier
```

| Property / Uniform   | Shorthand | Type  | Default | Description                             |
|----------------------|-----------|-------|---------|-----------------------------------------|
| `blockSize`          | `blockSize` | int | 8       | DCT block size (2–64, like JPEG 8×8)   |
| `lpf`                | `lpf`     | float | 128.0   | Low-pass filter cutoff                  |
| `highFreqMultiplier` | `hfreq`   | float | 0.0     | Boost/cut high-frequency coefficients   |
| `quantizeY`          | `qY`      | float | 0.0     | Luminance quantization (0–100)          |
| `quantizeYf`         | `qYf`     | float | 0.0     | Luminance quantization freq-dependent   |
| `quantizeC`          | `qC`      | float | 0.0     | Chrominance quantization (0–100)        |
| `quantizeCf`         | `qCf`     | float | 0.0     | Chrominance quantization freq-dependent |
| `quantizeA`          | `qA`      | float | 0.0     | Alpha quantization (0–100)              |
| `quantizeAf`         | `qAf`     | float | 0.0     | Alpha quantization freq-dependent       |
| `bypassDCT`          | `bypassDCT` | bool | false | Skip forward DCT (treat input as raw coefficients) |
| `bypassRDCT`         | `bypassRDCT` | bool | false | Skip inverse DCT (output raw coefficients) |
| `yOnly`              | `yOnly`   | bool  | false   | Process luminance channel only          |

Quantize values above 1 are treated as percentages (0–100) and normalized automatically.

## Examples

### Basic setup
```js
const dct = new DCTLive({ width: 512, height: 512 });
await dct.initImage('image.png');
dct.mount(document.body);
dct.show();
// loop: true by default, so rendering starts immediately after initImage
```

### Disable auto-loop
```js
const dct = new DCTLive({ width: 512, height: 512, loop: false });
await dct.initImage('image.png');
dct.run(); // manual single render
```

### Granular pass control
```js
// Show only DCT coefficients (skip inverse DCT)
dct.setDCT(true, true);    // both horizontal and vertical forward passes
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
// Via shorthand properties (recommended for livecoding)
dct.blockSize = 16;
dct.qY = 0.5;
dct.hfreq = 0.3;
dct.lpf = 64;

// Via setUniform / setUniforms
dct.setUniform('blockSize', 16);
dct.setUniforms({
  blockSize: 8,
  lpf: 100,
  highFreqMultiplier: 0.5
});
```

### CSS display size vs. processing resolution
```js
// Render at 256×256 but display at 512×512 (upscaled via CSS)
const dct = new DCTLive({ width: 256, height: 256 });
dct.resizeCanvas(512, 512);    // CSS size only — no re-allocation

// Change actual WebGL resolution (re-allocates framebuffers)
dct.setResolution(512, 512);
```

## Usage Notes

- `loop` defaults to `true` — rendering starts automatically once any `init*` call completes.
- All `init*` functions are async and return Promises. Use `await` or `.then()` to sequence work after load.
- The render loop can be started before an input source is ready via `start()`; it will render once `initImage()`, `initVideo()`, or `initCanvas()` supplies a texture.
- `setResolution()` changes processing dimensions and re-allocates WebGL framebuffers. It does **not** change CSS display size.
- `resizeCanvas()` only sets CSS `width`/`height` on the canvas — no framebuffer reallocation.
- Pass control (`setDCT()`, `setRDCT()`) takes effect on the next `run()` call. Default is all passes enabled (full DCT→IDCT pipeline).
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
