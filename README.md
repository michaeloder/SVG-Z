# SVG-Z

**Declarative 3D vector graphics for the web — v1.0**

SVG-Z extends SVG with a Z axis. You write markup that looks like SVG, every shape
gets a third coordinate, and the renderer resolves depth, transparency, and
anti-aliasing automatically. No WebGL. No shader code. No scene-graph engine.

```html
<svgz width="400" height="400" background="#06060a">
  <camera fov="50" eye="0,3,12" center="0,0,0" up="0,1,0" orbit="1"/>
  <sphere3d center="0,0,0" radius="1.2" subdivisions="32"
    fill="#1144bb" stroke="#4488ff" stroke-width="2"/>
</svgz>
<script src="src/svgz.js"></script>
<script>
  new ZBufferRenderer(document.querySelector('svgz'), { aa: 'msaa4' }).render();
</script>
```

---

## Repository layout

```
SVG-Z/
├── src/
│   └── svgz.js          ← the renderer library (single file, no dependencies)
├── docs/
│   └── index.html       ← the interactive book (published as GitHub Pages)
├── examples/
│   └── examples.html    ← gallery of rendered examples
├── .gitignore
└── README.md
```

> **Note:** The `playground/` directory is a separate repository hosted on a
> LAMP server and is excluded from this repo via `.gitignore`.

---

## Getting started

1. Copy `src/svgz.js` into your project.
2. Include it with a `<script>` tag.
3. Drop an `<svgz>` element into your HTML.
4. Call `new ZBufferRenderer(el, options).render()`.

That's it — no build step, no package manager, no framework required.

---

## Primitives

| Element | Description |
|---------|-------------|
| `<polygon3d>` | Flat polygon with 3D vertices (`points3d`) |
| `<path3d>` | 3D path using extended SVG path syntax (`d3`) — M, L, C, Z |
| `<sphere3d>` | UV sphere with latitude rings and longitude lines |
| `<cylinder3d>` | Cylinder or cone between two 3D points |
| `<lathe3d>` | Surface of revolution from a 2D Bézier profile |
| `<extrude3d>` | 2D Bézier profile extruded along a direction vector |
| `<surface3d>` | Bicubic Bézier patch from a 4×4 control-point grid |
| `<group3d>` | Transform group (`transform3d` — `rotateX/Y/Z`, `translate`, `scale`) |
| `<camera>` | Perspective camera — `fov`, `eye`, `center`, `up`, `near`, `far` |

---

## Camera

```html
<camera
  fov="50"           <!-- vertical field of view in degrees -->
  eye="0,3,12"       <!-- camera position in world space -->
  center="0,0,0"     <!-- look-at target -->
  up="0,1,0"         <!-- world up vector -->
  orbit="1"          <!-- enable drag-to-orbit / scroll-to-zoom -->
  near="0.1"
  far="200"
/>
```

---

## Anti-aliasing

| Mode | How | Cost |
|------|-----|------|
| `off` | Raw rasterisation | 1× |
| `tsaa` | Temporal AA — Halton jitter + history blend | ~1× |
| `msaa4` | 4× supersampled buffer, box-filtered | 4× fill rate |

```js
new ZBufferRenderer(el, { aa: 'msaa4' }).render();   // recommended default
new ZBufferRenderer(el, { aa: 'tsaa'  }).render();   // smooth, low cost
new ZBufferRenderer(el, { aa: 'off'   }).render();   // raw
```

---

## Controls (interactive viewers)

| Input | Action |
|-------|--------|
| Left drag | Orbit |
| Right drag / two-finger drag | Pan |
| Scroll wheel / pinch | Zoom |

---

## Examples

Open [`examples/examples.html`](examples/examples.html) for a gallery of
rendered scenes — primitives, spirals, lathe surfaces, Bézier patches,
extrusions, and transparency.

---

## The Book

The interactive reference book lives in [`docs/`](docs/index.html) and is
published at:

**[michaeloder.github.io/SVG-Z](https://michaeloder.github.io/SVG-Z)**

Each chapter has a live editor — edit the markup and click **▶ RUN** to see
the result instantly.

---

## License

MIT — free to use, modify, and redistribute.
