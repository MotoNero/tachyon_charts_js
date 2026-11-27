// Draws the scene with WebGPU into a picture of its own, which the chart then shows as an image, as Renderer3D of the
// .NET version: four samples per pixel, a depth buffer, the pipelines of shared/shaders/3d. The elements come part by
// part; this first part draws the lines of the axis box.
import { CloudBuffer } from './clouds';
import type { PointCloud3D } from '../scene/point-cloud';
import type { GpuTexture, PixelSize, Rgba8 } from '@tachyon-charts/core';
import type { WebGpuDevice } from '@tachyon-charts/render-webgpu';
import { clipWgsl, lightWgsl, linesWgsl, surfaceWgsl } from '../generated/shaders';
import type { FullMaterial } from '../scene/surface';
import type { Line3D, Scatter3D } from '../scene/points';
import { SurfaceBuffers, type SurfacePipelines, type SurfaceShape } from './surfaces';
import { createTracePipelines, TraceBuffer, type TracePipelines } from './traces';
import { BarBuffer, createBarPipelines, type BarPipelines } from './bars';
import { createCompositePipeline, createMeshPipelines, MeshBuffers, type MeshPipelines } from './meshes';
import { accumulationFormat, revealFormat, transparentTargets } from './transparency';
import { BubbleBuffer, createBubblePipeline } from './bubbles';
import type { Bubbles3D } from '../scene/bubbles';
import type { Bars3D, GridPlace } from '../scene/bars';

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
  private readonly tracePipelines: TracePipelines;
  private readonly traces = new Map<Line3D, TraceBuffer>();
  private readonly spots = new Map<Scatter3D, TraceBuffer>();
  private readonly clouds = new Map<PointCloud3D, CloudBuffer>();
  private readonly barPipelines: BarPipelines;
  private readonly bars = new Map<Bars3D, BarBuffer>();
  private readonly bubblePipeline: GPURenderPipeline;
  private readonly bubbles = new Map<Bubbles3D, BubbleBuffer>();
  private readonly meshPipelines: MeshPipelines;
  private readonly compositePipeline: GPURenderPipeline;
  private readonly meshes = new Map<object, MeshBuffers>();
  // No plane cuts the scene: each column keeps every point (0, 0, 0, 1).
  private readonly cuts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);

  /** Sets the planes that cut the scene, up to four of normal and minus offset; the others keep every point. */
  cutWith(planes: readonly (readonly [number, number, number, number])[]): void {
    for (let i = 0; i < 4; i++) {
      this.cuts.set(planes[i] ?? [0, 0, 0, 1], i * 4);
    }
  }
  private lines: GPUBuffer | undefined;
  private lineCapacity = 0;
  private size: PixelSize = { width: 0, height: 0 };
  private msaaColor: GPUTexture | undefined;
  private depth: GPUTexture | undefined;
  private resolved: GPUTexture | undefined;
  private msaaAccumulation: GPUTexture | undefined;
  private msaaReveal: GPUTexture | undefined;
  private accumulation: GPUTexture | undefined;
  private reveal: GPUTexture | undefined;
  private compositeBindGroup: GPUBindGroup | undefined;
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
      transparent: gpu.createRenderPipeline({
        label: 'surface transparent 3D',
        layout: 'auto',
        vertex: { module: surfaceModule, entryPoint: 'vs_main' },
        fragment: { module: surfaceModule, entryPoint: 'fs_transparent', targets: transparentTargets() },
        primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
        multisample: { count: sampleCount },
      }),
      lines: gpu.createRenderPipeline({
        label: 'surface lines 3D',
        layout: 'auto',
        vertex: { module: surfaceModule, entryPoint: 'vs_main' },
        fragment: { module: surfaceModule, entryPoint: 'fs_opaque', targets: [{ format: colorFormat }] },
        primitive: { topology: 'line-list', frontFace: 'ccw', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
        multisample: { count: sampleCount },
      }),
      // Behind its own lines: the hidden surface must not swallow the curves that lie on it.
      depth: gpu.createRenderPipeline({
        label: 'surface depth 3D',
        layout: 'auto',
        vertex: { module: surfaceModule, entryPoint: 'vs_main' },
        fragment: { module: surfaceModule, entryPoint: 'fs_opaque', targets: [{ format: colorFormat, writeMask: 0 }] },
        primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
        depthStencil: {
          format: depthFormat,
          depthWriteEnabled: true,
          depthCompare: 'less-equal',
          depthBias: 6000,
          depthBiasSlopeScale: 3,
        },
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
    this.tracePipelines = createTracePipelines(gpu, colorFormat, depthFormat, sampleCount);
    this.barPipelines = createBarPipelines(gpu, colorFormat, depthFormat, sampleCount);
    this.bubblePipeline = createBubblePipeline(gpu, colorFormat, depthFormat, sampleCount);
    this.meshPipelines = createMeshPipelines(gpu, colorFormat, depthFormat, sampleCount);
    this.compositePipeline = createCompositePipeline(gpu, colorFormat);
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

  /** Uploads the columns of an element, with a new buffer when their number changed. */
  updateBars(bars: Bars3D, instances: ArrayBuffer, count: number, place: GridPlace, material: FullMaterial): void {
    let buffer = this.bars.get(bars);
    if (buffer?.count !== count) {
      buffer?.dispose();
      buffer = new BarBuffer(this.gpu, this.barPipelines, material, count);
      this.bars.set(bars, buffer);
    }
    buffer.place = place;
    buffer.write(instances);
  }

  /** Uploads a mesh: corners with normals and colors, and its triangles. */
  uploadMesh(owner: object, vertices: ArrayBuffer, indices: Uint32Array, material: FullMaterial): void {
    this.meshes.get(owner)?.dispose();
    this.meshes.set(owner, new MeshBuffers(this.gpu, this.meshPipelines, material, vertices, indices));
  }

  /** Whether the renderer holds the buffers of a mesh. */
  holdsMesh(owner: object): boolean {
    return this.meshes.has(owner);
  }

  /** Uploads bubbles, with a new buffer when there are more than it holds. */
  uploadBubbles(bubbles: Bubbles3D, instances: ArrayBuffer, count: number, material: FullMaterial): void {
    let buffer = this.bubbles.get(bubbles);
    if (!buffer || buffer.capacity < count) {
      buffer?.dispose();
      buffer = new BubbleBuffer(this.gpu, this.bubblePipeline, material, count);
      this.bubbles.set(bubbles, buffer);
    }
    buffer.write(instances, count);
  }

  /** Whether the renderer holds the buffer of bubbles. */
  holdsBubbles(bubbles: Bubbles3D): boolean {
    return this.bubbles.has(bubbles);
  }

  /** Whether the renderer holds the buffer of columns. */
  holdsBars(bars: Bars3D): boolean {
    return this.bars.has(bars);
  }

  /** The buffer of a line, made on first use. */
  traceOf(line: Line3D): TraceBuffer {
    let buffer = this.traces.get(line);
    if (!buffer) {
      buffer = new TraceBuffer(this.gpu, this.tracePipelines.trace, line.points, line.width, 0, line.drawsOnTop);
      this.traces.set(line, buffer);
    }
    return buffer;
  }

  /** The buffer of a scatter, made on first use. */
  spotsOf(scatter: Scatter3D): TraceBuffer {
    let buffer = this.spots.get(scatter);
    if (!buffer) {
      buffer = new TraceBuffer(this.gpu, this.tracePipelines.spots, scatter.points, 0, scatter.pointBudget);
      this.spots.set(scatter, buffer);
    }
    return buffer;
  }

  /** The buffer of a cloud with room for a number of points, made on first use. */
  cloudOf(cloud: PointCloud3D, capacity: number): CloudBuffer {
    let buffer = this.clouds.get(cloud);
    if (!buffer) {
      buffer = new CloudBuffer(this.gpu, this.tracePipelines, capacity, 0);
      this.clouds.set(cloud, buffer);
    }
    return buffer;
  }

  /** Writes one row of a waterfall into its slot of the ring. */
  writeRow(owner: object, slot: number, heights: Float32Array, firstRow: number): void {
    this.surfaces.get(owner)?.writeRow(slot, heights, firstRow);
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
    for (const trace of [...this.traces.values(), ...this.spots.values()]) {
      trace.writeUniforms(matrix, size.width, size.height, this.cuts);
    }
    for (const cloud of this.clouds.values()) {
      cloud.writeUniforms(matrix, size.width, size.height, this.cuts);
    }
    for (const bars of this.bars.values()) {
      bars.writeUniforms(matrix, eye, this.cuts);
    }
    const anyTransparent = (buffers: Iterable<{ readonly isTransparent: boolean }>): boolean => {
      for (const buffer of buffers) {
        if (buffer.isTransparent) {
          return true;
        }
      }
      return false;
    };
    for (const bubbles of this.bubbles.values()) {
      bubbles.writeUniforms(matrix, eye, this.cuts, size.width, size.height);
    }
    let hasTransparency = anyTransparent(this.bars.values()) || anyTransparent(this.surfaces.values());
    for (const mesh of this.meshes.values()) {
      mesh.writeUniforms(matrix, eye, this.cuts);
      hasTransparency ||= mesh.isTransparent;
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
        // See-through surfaces test against the depth of the opaque ones.
        depthStoreOp: hasTransparency ? 'store' : 'discard',
        depthClearValue: 1,
      },
    });
    if (lines.count > 0 && this.lines) {
      pass.setPipeline(this.linePipeline);
      pass.setBindGroup(0, this.lineBindGroup);
      pass.setVertexBuffer(0, this.lines, 0, lines.count * lineVertexSize);
      pass.draw(lines.count);
    }
    pass.setPipeline(this.meshPipelines.opaque);
    for (const mesh of this.meshes.values()) {
      if (!mesh.isTransparent) {
        mesh.draw(pass);
      }
    }
    pass.setPipeline(this.tracePipelines.trace);
    for (const trace of this.traces.values()) {
      if (!trace.isOnTop) {
        trace.draw(pass);
      }
    }
    if (this.spots.size > 0) {
      pass.setPipeline(this.tracePipelines.spots);
      for (const spots of this.spots.values()) {
        spots.drawSpots(pass);
      }
    }
    for (const cloud of this.clouds.values()) {
      cloud.draw(pass);
    }
    pass.setPipeline(this.barPipelines.opaque);
    for (const bars of this.bars.values()) {
      if (!bars.isTransparent) {
        bars.draw(pass, eye[1]);
      }
    }
    if (this.bubbles.size > 0) {
      pass.setPipeline(this.bubblePipeline);
      for (const bubbles of this.bubbles.values()) {
        bubbles.draw(pass);
      }
    }
    for (const surface of this.surfaces.values()) {
      if (surface.isLines) {
        pass.setPipeline(this.surfacePipelines.depth);
        surface.drawDepth(pass);
        pass.setPipeline(this.surfacePipelines.lines);
        surface.drawLines(pass);
      } else if (!surface.isTransparent) {
        pass.setPipeline(this.surfacePipelines.opaque);
        surface.draw(pass);
      }
    }
    pass.setPipeline(this.surfacePipelines.projection);
    for (const surface of this.surfaces.values()) {
      surface.drawProjection(pass);
    }
    // The lines over everything, after all that is opaque.
    pass.setPipeline(this.tracePipelines.onTop);
    for (const trace of this.traces.values()) {
      if (trace.isOnTop) {
        trace.draw(pass);
      }
    }
    pass.end();
    if (hasTransparency) {
      this.encodeTransparent(encoder, eye[1]);
    }
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
    for (const trace of [...this.traces.values(), ...this.spots.values()]) {
      trace.dispose();
    }
    this.traces.clear();
    this.spots.clear();
    for (const cloud of this.clouds.values()) {
      cloud.dispose();
    }
    this.clouds.clear();
    for (const bars of this.bars.values()) {
      bars.dispose();
    }
    this.bars.clear();
    for (const bubbles of this.bubbles.values()) {
      bubbles.dispose();
    }
    this.bubbles.clear();
    for (const mesh of this.meshes.values()) {
      mesh.dispose();
    }
    this.meshes.clear();
    this.lines?.destroy();
    this.lineUniforms.destroy();
  }

  // Weighted blended transparency: the see-through surfaces sum their colors and what still shows through, then lay
  // over the picture in one pass, so that surfaces that cut through each other need no sorting.
  private encodeTransparent(encoder: GPUCommandEncoder, eyeY: number): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: (this.msaaAccumulation as GPUTexture).createView(),
          resolveTarget: (this.accumulation as GPUTexture).createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
        {
          view: (this.msaaReveal as GPUTexture).createView(),
          resolveTarget: (this.reveal as GPUTexture).createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
        },
      ],
      depthStencilAttachment: {
        view: (this.depth as GPUTexture).createView(),
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(this.meshPipelines.transparent);
    for (const mesh of this.meshes.values()) {
      if (mesh.isTransparent) {
        mesh.draw(pass);
      }
    }
    pass.setPipeline(this.barPipelines.transparent);
    for (const bars of this.bars.values()) {
      if (bars.isTransparent) {
        bars.draw(pass, eyeY);
      }
    }
    pass.setPipeline(this.surfacePipelines.transparent);
    for (const surface of this.surfaces.values()) {
      if (surface.isTransparent && !surface.isLines) {
        surface.draw(pass);
      }
    }
    pass.end();
    const composite = encoder.beginRenderPass({
      colorAttachments: [{ view: (this.resolved as GPUTexture).createView(), loadOp: 'load', storeOp: 'store' }],
    });
    composite.setPipeline(this.compositePipeline);
    composite.setBindGroup(0, this.compositeBindGroup as GPUBindGroup);
    composite.draw(3);
    composite.end();
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
    const attachment = (format: GPUTextureFormat, samples: number): GPUTexture =>
      this.gpu.createTexture({
        size: extent,
        format,
        sampleCount: samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | (samples === 1 ? GPUTextureUsage.TEXTURE_BINDING : 0),
      });
    this.msaaAccumulation = attachment(accumulationFormat, sampleCount);
    this.msaaReveal = attachment(revealFormat, sampleCount);
    this.accumulation = attachment(accumulationFormat, 1);
    this.reveal = attachment(revealFormat, 1);
    this.compositeBindGroup = this.gpu.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.accumulation.createView() },
        { binding: 1, resource: this.reveal.createView() },
      ],
    });
  }

  private releaseAttachments(): void {
    this.msaaColor?.destroy();
    this.depth?.destroy();
    this.resolved?.destroy();
    this.shown?.dispose();
    this.msaaAccumulation?.destroy();
    this.msaaReveal?.destroy();
    this.accumulation?.destroy();
    this.reveal?.destroy();
    this.msaaAccumulation = undefined;
    this.msaaReveal = undefined;
    this.accumulation = undefined;
    this.reveal = undefined;
    this.compositeBindGroup = undefined;
    this.msaaColor = undefined;
    this.depth = undefined;
    this.resolved = undefined;
    this.shown = undefined;
  }
}
