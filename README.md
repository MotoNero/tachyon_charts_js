# Tachyon Charts for JavaScript

Fast charts for the browser, drawn on the GPU with WebGPU, with fallbacks to WebGL 2 and Canvas 2D. Made for large
data: millions of points in real time and files larger than memory.

**Status:** early development. There is no release yet and the API will change. The packages will appear on npm under
`@tachyon-charts/…`.

## Packages

| Package | Content |
|---|---|
| `@tachyon-charts/core` | Charts, axes, data, interaction, layout and themes |
| `@tachyon-charts/render-webgpu` | WebGPU backend |
| `@tachyon-charts/render-webgl` | WebGL 2 fallback |
| `@tachyon-charts/render-canvas` | Canvas 2D fallback and export |
| `@tachyon-charts/element` | The web component `<tachyon-chart>` |
| `@tachyon-charts/large-data` | Column files, pyramids, OPFS, HTTP range requests, workers |
| `@tachyon-charts/3d` | 3D charts |
| `@tachyon-charts/geo` | Maps |
| `@tachyon-charts/medical` | DICOM and NIfTI images |
| `@tachyon-charts/configurator` | The configurator as a web app |

## Documentation

- [File formats](docs/guide/file-formats.md): column files, pyramids, point tiles, rasters and maps

## Build from source

Requires Node.js 22.12 or later. pnpm comes with Node.js through Corepack.

```bash
corepack pnpm install
corepack pnpm build
```

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
