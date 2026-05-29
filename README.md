# DCTLive

WebGL implementation of DCT (Discrete Cosine Transform) and IDCT with real-time controls. Compress, glitch, and manipulate images and video using JPEG-like algorithms.

![](./demo/DCT-DEMO-IMG.jpg)

Design and API by geikha. DCT shader originally from [FMS-Cat](https://twitter.com/FMS_Cat) ([Testing DCT quantization shader](https://www.youtube.com/watch?v=xt4UFRPqX_w)). Thanks to [sol sarratea](https://solsarratea.world/) for the references. Implementation and documentation done using Claude Code.

## Install

```bash
npm install dctlive
```

Or use from CDN:
```html
<script src="https://unpkg.com/dctlive/dist/dctlive.js"></script>
```

## Quick Start

### Example Setup
```js
const dct = new DCTLive({ width: 512, height: 512 });
document.body.appendChild(dct.canvas);
await dct.initImage('image.png');

dct.start();

// Change parameters in real-time
dct.blockSize = 16;
dct.qY = 0.5;
dct.hfreq = 1.5;
```

### Loading Sources
```js
// Image from URL
await dct.initImage('https://example.com/image.jpg');

// Video from URL
await dct.initVideo('https://example.com/video.mp4');

// From file input
fileInput.addEventListener('change', async (e) => {
  const url = URL.createObjectURL(e.target.files[0]);
  await dct.initImage(url);
});

// From camera
await dct.initCam(0);  // First camera
await dct.initCam('Built-in Camera');  // Or by label
```

## Common Parameters

All parameters update in real-time:

```js
// Block size (larger = more blocky compression)
dct.blockSize = 16;

// Manipulate higher harmonics
dct.hfreq = 2.0;   // Sharpen-like behaviour

// Quantization (lose color/luminance like JPEG, 0–1 range with power curve)
dct.qY = 0.5;  // Reduce luminance
dct.qC = 0.8;  // Reduce color
dct.yOnly = true;  // Drop all color

// Ignore harmonics
dct.lpf = 64;

// Frame rate
dct.fps = 30;
dct.fps = 0;  // Unlimited
```

## Display & Resolution

```js
// Display size in page (CSS)
dct.resizeCanvas(800, 600);

// Render resolution (processing resolution)
dct.setResolution(1024, 1024);

// How source maps to canvas
dct.input.fit = 'stretch';  // Default
dct.input.fit = 'fit';      // Letterbox
dct.input.fit = 'fill';     // Crop
```

## DCT/IDCT Control

Enable/disable transform passes independently:

```js
// Forward DCT (spatial → frequency domain)
dct.dctHorizontal = true;
dct.dctVertical = true;

// Inverse DCT (frequency → spatial domain)
dct.rdctHorizontal = true;
dct.rdctVertical = true;

// Or use setters
dct.setDCT(true, false);    // Only horizontal
dct.setRDCT(false, true);   // Only vertical inverse
```

## Full API

### Constructor
```js
new DCTLive({
  width: 256,         // Render width (default)
  height: 256,        // Render height (default)
  loop: true,         // Auto-start loop (optional)
  canvas: canvasEl,   // Use existing canvas (optional)
  precision: '16bit'  // Texture precision: '32bit' | '16bit' | '8bit' (default '16bit')
})
```

### Source Loading (async)
- `initImage(url, opts)` — Image or HTMLImageElement
- `initVideo(url, opts)` — Video or HTMLVideoElement
- `initCanvas(canvas, opts)` — HTMLCanvasElement or context
- `initCam(selector, opts)` — Camera (index or label string)

### Rendering
- `run()` — One frame
- `start()` — Start loop
- `stop()` — Stop loop

### Display
- `show()` / `hide()` — Visibility
- `mount(element)` — Insert into DOM
- `unmount()` — Remove from DOM
- `resizeCanvas(w, h)` — Display size
- `setResolution(w, h)` — Render resolution

### Configuration
- `setFPS(fps)` — Frame rate
- `setDCT(h, v)` — Forward DCT passes
- `setRDCT(h, v)` — Inverse DCT passes
- `setUniform(name, val)` — Single uniform
- `setUniforms(obj)` — Multiple uniforms
- `setWaveFunction(glsl)` — Replace IDCT wave function
- `resetWaveFunction()` — Restore default

### Properties (Shorthand)
```js
dct.precision           // '32bit' | '16bit' | '8bit' (read-only, set at construction)
dct.blockSize           // 2–64 recommended (default 8)
dct.lpf                 // 0–128 (default 128)
dct.hfreq               // High frequency multiplier
dct.qY, dct.qC          // Luminance, chrominance quantization (0–1, power curve)
dct.qYf, dct.qCf        // Frequency-dependent quantization (0–1)
dct.qA, dct.qAf         // Alpha quantization (0–1)
dct.yOnly               // Drop color channels (bool)

dct.input.fit           // 'fit' | 'fill' | 'stretch'
dct.input.filter        // 'linear' | 'nearest' — sets both mag and min
dct.input.wrap          // 'clamp' | 'repeat' | 'mirror' | 'mask'

dct.fps                 // Get/set frame rate
dct.uniforms            // All shader parameters (object)
```

## Precision Modes

DCTLive supports three texture precision modes. The mode is set at construction and cannot be changed afterward. The library auto-detects available hardware and falls back if needed.

```js
// 32-bit float (highest precision, requires OES_texture_float)
const dct = new DCTLive({ precision: '32bit' });

// 16-bit half-float (balanced, requires OES_texture_half_float)
const dct = new DCTLive({ precision: '16bit' });  // Default

// 8-bit RGBA (smallest, widest device support)
const dct = new DCTLive({ precision: '8bit' });
```

### Mode Comparison

| Mode | Precision | Device Support | Use Case |
|------|-----------|-----------------|----------|
| **32-bit** | Highest (no loss) | Desktop/newer mobile | Professional quality, unlimited block sizes |
| **16-bit** | Very good | Most modern devices | Best balance of quality and compatibility |
| **8-bit** | Good (lossy encoding) | Older phones, budget devices | Mobile-first, constrained devices |

### How It Works

- **16-bit & 32-bit** — Direct storage, full precision at each stage
- **8-bit** — Uses RGBM encoding (per-pixel scale multiplier in alpha) + signed-sqrt companding to maximize precision within 256 levels per channel

### Fallback Chain

If requested precision unavailable:
- Request `'32bit'` → tries 32 → 16 → 8
- Request `'16bit'` → tries 16 → 8
- Request `'8bit'` → always succeeds (no extensions needed)

### Query Actual Precision

```js
dct.precision  // Returns '32bit' | '16bit' | '8bit' (actual, after fallback)
```

### URL Parameter (Demo)

For testing, use the query string:
```
?precision=8bit    // Force 8-bit
?precision=16bit   // Force 16-bit (default)
?precision=32bit   // Force 32-bit
```


## Notes

- **Loop default** — `loop: true` auto-starts rendering after any `init*` call
- **Async sources** — All `init*` calls return Promises; use `await`
- **Resolution vs display** — `setResolution()` changes processing; `resizeCanvas()` is CSS only
- **WebGL required** — No fallbacks for older browsers
- **CORS** — Loading external images/video requires CORS headers

## Development

```bash
npm install
npm run build
npm run dev     # Watch mode
npm run serve   # Dev server on port 3000
```

**License:** GPL-3.0
