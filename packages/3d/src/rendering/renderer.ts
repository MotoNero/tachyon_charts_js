// Draws the scene with WebGPU into a picture of its own, which the chart then shows as an image, as Renderer3D of the
// .NET version: four samples per pixel, a depth buffer, the pipelines of shared/shaders/3d. The elements come part by
// part; this first part draws the lines of the axis box.
import type { GpuTexture, PixelSize, Rgba8 } from '@tachyon-charts/core';
import type { WebGpuDevice } from '@tachyon-charts/render-webgpu';
import { clipWgsl, lightWgsl, linesWgsl, surfaceWgsl } from '../generated/shaders';
import type { FullMaterial } from '../scene/surface';
import { SurfaceBuffers, type SurfacePipelines, type SurfaceShape } from './surfaces';

const sampleCount = 4;
const colorFormat: GPUTextureFormat = 'rgba8unorm';
const depthFormat: GPUTextureFormat = 'depth32float';
const lineUniformSize = 64;
/** @internal The bytes of one line point: X, Y and Z as floats and the color as four bytes. */
export const lineVertexSize = 16;

/** @internal The points of the lines of a frame, pairs of points, each with its color. */
export class LineVertices {
  private buffer = new ArrayBuffer(lineVertexSize * 64);
  private floats = new Float32Array(this.buffer);
  private bytes = new Uint8Array(this.buffer);
  private used = 0;

  /** The number of points. */
  get count(): number {
    return this.used;
  }

  /** The points as bytes. */
  get data(): Uint8Array {
    return this.bytes.subarray(0, this.used * lineVertexSize);
  }

  /** Removes all points. */
  clear(): void {
    this.used = 0;
  }

  /** Adds points given as X, Y, Z triples, all in one color. */
  addAll(points: readonly number[], color: Rgba8): void {
    for (let i = 0; i + 2 < points.length; i += 3) {
      this.add(points[i] as number, points[i + 1] as number, points[i + 2] as number, color);
    }
  }

  /** Adds one point. */
  add(x: number, y: number, z: number, color: Rgba8): void {
    if ((this.used + 1) * lineVertexSize > this.buffer.byteLength) {
      const grown = new ArrayBuffer(this.buffer.byteLength * 2);
      new Uint8Array(grown).set(this.bytes);
      this.buffer = grown;
      this.floats = new Float32Array(grown);
      this.bytes = new Uint8Array(grown);
    }
    const at = this.used * (lineVertexSize / 4);
    this.floats[at] = x;
    this.floats[at + 1] = y;
    this.floats[at + 2] = z;
    const offset = this.used * lineVertexSize + 12;
    this.bytes[offset] = color.r;
    this.bytes[offset + 1] = color.g;
    this.bytes[offset + 2] = color.b;
    this.bytes[offset + 3] = color.a;
    this.used++;
  }
}

/** @internal Draws the scene into a picture on the GPU, for one device. */
export class Renderer3D {
  private readonly gpu: GPUDevice;
  private readonly lineUniforms: GPUBuffer;
  private readonly linePipeline: GPURenderPipeline;
  private readonly lineBindGroup: GPUBindGroup;
  private readonly surfacePipelines: SurfacePipelines;
  private readonly surfaces = new Map<object, SurfaceBuffers>();
  // No plane cuts the scene: each column keeps every point (0, 0, 0, 1).
  private readonly cuts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  private lines: GPUBuffer | undefined;
  private lineCapacity = 0;
  private size: PixelSize = { width: 0, height: 0 };
  private msaaColor: GPUTexture | undefined;
  private depth: GPUTexture | undefined;
  private resolved: GPUTexture | undefined;
  private shown: GpuTexture | undefined;
  private disposed = false;

  constructor(private readonly device: WebGpuDevice) {
    const gpu = device.gpu;
    this.gpu = gpu;
    this.lineUniforms = gpu.createBuffer({
      size: lineUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const module = gpu.createShaderModule({ label: 'lines.wgsl', code: linesWgsl });
    this.linePipeline = gpu.createRenderPipeline({
      label: 'lines 3D',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: lineVertexSize,
            stepMode: 'vertex',
            attributes: [
              { format: 'float32x3', offset: 0, shaderLocation: 0 },
              { format: 'unorm8x4', offset: 12, shaderLocation: 1 },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'line-list', frontFace: 'ccw', cullMode: 'none' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
      multisample: { count: sampleCount },
    });
    const surfaceModule = gpu.createShaderModule({ label: 'surface.wgsl', code: clipWgsl + lightWgsl + surfaceWgsl });
    this.surfacePipelines = {
      opaque: gpu.createRenderPipeline({
        label: 'surface 3D',
        layout: 'auto',
        vertex: { module: surfaceModule, entryPoint: 'vs_main' },
        fragment: { module: surfaceModule, entryPoint: 'fs_opaque', targets: [{ format: colorFormat }] },
        primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
        multisample: { count: sampleCount },
      }),
      projection: gpu.createRenderPipeline({
        label: 'surface projection 3D',
        layout: 'auto',
        vertex: { module: surfaceModule, entryPoint: 'vs_projected' },
        fragment: {
          module: surfaceModule,
          entryPoint: 'fs_projected',
          targets: [
            {
              format: colorFormat,
              blend: {
                color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
        multisample: { count: sampleCount },
      }),
    };
    this.lineBindGroup = gpu.createBindGroup({
      layout: this.linePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.lineUniforms, size: lineUniformSize } }],
    });
  }

  /** Uploads the heights of a surface, with new buffers when its grid changed. */
  updateSurface(
    owner: object,
    shape: SurfaceShape,
    heights: Float32Array,
    colors: Float32Array,
    material: FullMaterial,
  ): void {
    let buffers = this.surfaces.get(owner);
    if (!buffers?.fits(shape)) {
      buffers?.dispose();
      buffers = new SurfaceBuffers(this.gpu, this.surfacePipelines, material, shape, colors);
      this.surfaces.set(owner, buffers);
    }
    buffers.write(shape, heights);
  }

  /** Whether the renderer holds the buffers of a surface. */
  holdsSurface(owner: object): boolean {
    return this.surfaces.has(owner);
  }

  /** The picture of the last render, on the device of the chart; none before. */
  get picture(): GpuTexture | undefined {
    return this.shown;
  }

  /**
   * Draws a picture of the scene.
   * @param size - The size of the picture in pixels.
   * @param matrix - The projection and view, 16 floats in the column order of WGSL.
   * @param background - The color behind the scene.
   * @param lines - The lines of the box and the elements.
   */
  render(
    size: PixelSize,
    matrix: Float32Array,
    eye: readonly [number, number, number],
    background: Rgba8,
    lines: LineVertices,
    planes: readonly number[],
  ): void {
    if (this.disposed) {
      throw new Error('The renderer is disposed.');
    }
    this.ensureSize(size);
    this.writeLines(lines);
    this.gpu.queue.writeBuffer(this.lineUniforms, 0, matrix.buffer, matrix.byteOffset, lineUniformSize);
    for (const surface of this.surfaces.values()) {
      surface.writeUniforms(matrix, eye, planes, this.cuts);
    }
    const encoder = this.gpu.createCommandEncoder({ label: 'scene 3D' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: (this.msaaColor as GPUTexture).createView(),
          resolveTarget: (this.resolved as GPUTexture).createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: background.r / 255, g: background.g / 255, b: background.b / 255, a: 1 },
        },
      ],
      depthStencilAttachment: {
        view: (this.depth as GPUTexture).createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        depthClearValue: 1,
      },
    });
    if (lines.count > 0 && this.lines) {
      pass.setPipeline(this.linePipeline);
      pass.setBindGroup(0, this.lineBindGroup);
      pass.setVertexBuffer(0, this.lines, 0, lines.count * lineVertexSize);
      pass.draw(lines.count);
    }
    for (const surface of this.surfaces.values()) {
      if (!surface.isTransparent) {
        pass.setPipeline(this.surfacePipelines.opaque);
        surface.draw(pass);
      }
    }
    pass.setPipeline(this.surfacePipelines.projection);
    for (const surface of this.surfaces.values()) {
      surface.drawProjection(pass);
    }
    pass.end();
    // The picture reaches a texture of the chart's device, which the chart draws like any image.
    const shown = this.shown as GpuTexture & { texture: GPUTexture };
    encoder.copyTextureToTexture(
      { texture: this.resolved as GPUTexture },
      { texture: shown.texture },
      { width: size.width, height: size.height },
    );
    this.gpu.queue.submit([encoder.finish()]);
  }

  /** Lets go of all GPU resources. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseAttachments();
    for (const surface of this.surfaces.values()) {
      surface.dispose();
    }
    this.surfaces.clear();
    this.lines?.destroy();
    this.lineUniforms.destroy();
  }

  private writeLines(lines: LineVertices): void {
    const bytes = lines.count * lineVertexSize;
    if (bytes > this.lineCapacity) {
      this.lines?.destroy();
      this.lineCapacity = bytes * 2;
      this.lines = this.gpu.createBuffer({
        size: this.lineCapacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (bytes > 0 && this.lines) {
      const data = lines.data;
      this.gpu.queue.writeBuffer(this.lines, 0, data.buffer, data.byteOffset, bytes);
    }
  }

  private ensureSize(size: PixelSize): void {
    if (this.shown && this.size.width === size.width && this.size.height === size.height) {
      return;
    }
    this.releaseAttachments();
    this.size = size;
    const extent = { width: size.width, height: size.height };
    this.msaaColor = this.gpu.createTexture({
      size: extent,
      format: colorFormat,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depth = this.gpu.createTexture({
      size: extent,
      format: depthFormat,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.resolved = this.gpu.createTexture({
      size: extent,
      format: colorFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.shown = this.device.createTexture({ size, format: 'rgba8unorm' });
  }

  private releaseAttachments(): void {
    this.msaaColor?.destroy();
    this.depth?.destroy();
    this.resolved?.destroy();
    this.shown?.dispose();
    this.msaaColor = undefined;
    this.depth = undefined;
    this.resolved = undefined;
    this.shown = undefined;
  }
}
