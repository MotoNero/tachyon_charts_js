// The render pipelines of the 2D shaders, made once per texture format, as in the .NET version.
import { flatWgsl, markerWgsl, polylineWgsl } from './generated/shaders';

/** Bytes of the uniforms of one command: the Params of the shaders, the quarter turn at 128 included. */
export const paramsSize = 144;

/** Bytes of one corner of a flat triangle: x, y as floats and the color as four bytes. */
export const flatVertexSize = 12;

/** Bytes of one point of a line. */
export const pointSize = 8;

/** Bytes of one marker: x, y, size as floats and the color as four bytes. */
export const markerSize = 16;

export interface Pipelines {
  readonly flat: GPURenderPipeline;
  readonly polyline: GPURenderPipeline;
  readonly glow: GPURenderPipeline;
  readonly marker: GPURenderPipeline;
}

const blend: GPUBlendState = {
  color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

// The glow of neighboring segments overlaps; the maximum keeps it from adding up.
const maximum: GPUBlendComponent = { operation: 'max', srcFactor: 'one', dstFactor: 'one' };
const glowBlend: GPUBlendState = { color: maximum, alpha: maximum };

/** The shader modules and the layout all 2D pipelines share; the pipelines themselves per format. */
export class PipelineCache {
  readonly uniformLayout: GPUBindGroupLayout;
  private readonly layout: GPUPipelineLayout;
  private readonly flatShader: GPUShaderModule;
  private readonly polylineShader: GPUShaderModule;
  private readonly markerShader: GPUShaderModule;
  private readonly byFormat = new Map<GPUTextureFormat, Pipelines>();

  constructor(private readonly gpu: GPUDevice) {
    this.uniformLayout = gpu.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: paramsSize },
        },
      ],
    });
    this.layout = gpu.createPipelineLayout({ bindGroupLayouts: [this.uniformLayout] });
    this.flatShader = gpu.createShaderModule({ label: 'flat.wgsl', code: flatWgsl });
    this.polylineShader = gpu.createShaderModule({ label: 'polyline.wgsl', code: polylineWgsl });
    this.markerShader = gpu.createShaderModule({ label: 'marker.wgsl', code: markerWgsl });
  }

  /** The pipelines for a target format, made on first use. */
  get(format: GPUTextureFormat): Pipelines {
    let pipelines = this.byFormat.get(format);
    if (!pipelines) {
      const flat = this.pipeline(this.flatShader, format, blend, 'fs_main', [
        {
          arrayStride: flatVertexSize,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'unorm8x4' },
          ],
        },
      ]);
      // Two views of the same points: the start and the end of each segment. An attribute may not reach beyond the
      // stride, so the end cannot be a second attribute of one view.
      const segments: GPUVertexBufferLayout[] = [
        {
          arrayStride: pointSize,
          stepMode: 'instance',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        },
        {
          arrayStride: pointSize,
          stepMode: 'instance',
          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }],
        },
      ];
      const polyline = this.pipeline(this.polylineShader, format, blend, 'fs_main', segments);
      const glow = this.pipeline(this.polylineShader, format, glowBlend, 'fs_glow', segments);
      const marker = this.pipeline(this.markerShader, format, blend, 'fs_main', [
        {
          arrayStride: markerSize,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32' },
            { shaderLocation: 2, offset: 12, format: 'unorm8x4' },
          ],
        },
      ]);
      pipelines = { flat, polyline, glow, marker };
      this.byFormat.set(format, pipelines);
    }
    return pipelines;
  }

  private pipeline(
    module: GPUShaderModule,
    format: GPUTextureFormat,
    blendState: GPUBlendState,
    fragmentEntry: string,
    buffers: GPUVertexBufferLayout[],
  ): GPURenderPipeline {
    return this.gpu.createRenderPipeline({
      layout: this.layout,
      vertex: { module, entryPoint: 'vs_main', buffers },
      fragment: { module, entryPoint: fragmentEntry, targets: [{ format, blend: blendState }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
  }
}
