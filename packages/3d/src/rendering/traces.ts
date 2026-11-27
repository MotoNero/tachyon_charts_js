// Lines and scatters on the GPU: the points of a ring in a vertex buffer with a gap in front and three points after
// the end, so that each piece of a line reads its four neighbours from one buffer, as TraceRing and the trace part of
// Renderer3D in the .NET version.
import type { Rgba8 } from '@tachyon-charts/core';
import { clipWgsl, scatterWgsl, traceWgsl } from '../generated/shaders';
import { gapPlace, type BoxMap, type Points3D } from '../scene/points';

const traceStride = 16;
const traceCorners = 6;
const lead = 1;
const tail = 3;
const chunkSize = 1 << 20;
/** @internal The size of the uniforms of a trace: camera, size, width, cuts. */
export const traceUniformSize = 144;

const slotsOf = (capacity: number): number => capacity + 1;
const placesOf = (capacity: number): number => lead + slotsOf(capacity) + tail;

/** @internal The pipelines lines and scatters draw with. */
export interface TracePipelines {
  readonly trace: GPURenderPipeline;
  readonly onTop: GPURenderPipeline;
  readonly spots: GPURenderPipeline;
  /** Single pixels of a very large cloud. */
  readonly points: GPURenderPipeline;
}

/** @internal Creates the pipelines of lines and scatters. */
export function createTracePipelines(
  gpu: GPUDevice,
  colorFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  sampleCount: number,
): TracePipelines {
  const traceModule = gpu.createShaderModule({ label: 'trace.wgsl', code: clipWgsl + traceWgsl });
  const point = (location: number): GPUVertexAttribute => ({
    format: 'float32x3',
    offset: 0,
    shaderLocation: location,
  });
  const color = (location: number): GPUVertexAttribute => ({
    format: 'unorm8x4',
    offset: 12,
    shaderLocation: location,
  });
  // One buffer at four offsets: WebGPU forbids attributes beyond the stride, and a piece reads four points.
  const buffers: GPUVertexBufferLayout[] = [
    { arrayStride: traceStride, stepMode: 'instance', attributes: [point(0)] },
    { arrayStride: traceStride, stepMode: 'instance', attributes: [point(1), color(2)] },
    { arrayStride: traceStride, stepMode: 'instance', attributes: [point(3), color(4)] },
    { arrayStride: traceStride, stepMode: 'instance', attributes: [point(5)] },
  ];
  const layout = gpu.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });
  const pipelineLayout = gpu.createPipelineLayout({ bindGroupLayouts: [layout] });
  const traceDescriptor = (depthWrite: boolean, compare: GPUCompareFunction): GPURenderPipelineDescriptor => ({
    label: 'trace 3D',
    layout: pipelineLayout,
    vertex: { module: traceModule, entryPoint: 'vs_main', buffers },
    fragment: { module: traceModule, entryPoint: 'fs_main', targets: [{ format: colorFormat }] },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    depthStencil: { format: depthFormat, depthWriteEnabled: depthWrite, depthCompare: compare },
    multisample: { count: sampleCount },
  });
  const spotModule = gpu.createShaderModule({ label: 'scatter.wgsl', code: clipWgsl + scatterWgsl });
  return {
    trace: gpu.createRenderPipeline(traceDescriptor(true, 'less-equal')),
    // The same lines over everything: no depth test, no depth written.
    onTop: gpu.createRenderPipeline(traceDescriptor(false, 'always')),
    spots: gpu.createRenderPipeline({
      label: 'scatter 3D',
      layout: pipelineLayout,
      vertex: {
        module: spotModule,
        entryPoint: 'vs_main',
        buffers: [{ arrayStride: traceStride, stepMode: 'instance', attributes: [point(0), color(1)] }],
      },
      // The alpha of the shader only decides on the coverage. The picture stays opaque.
      fragment: {
        module: spotModule,
        entryPoint: 'fs_main',
        targets: [{ format: colorFormat, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE }],
      },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
      multisample: { count: sampleCount, alphaToCoverageEnabled: true },
    }),
    points: gpu.createRenderPipeline({
      label: 'points 3D',
      layout: pipelineLayout,
      vertex: {
        module: spotModule,
        entryPoint: 'vs_point',
        buffers: [{ arrayStride: traceStride, stepMode: 'vertex', attributes: [point(0), color(1)] }],
      },
      fragment: { module: spotModule, entryPoint: 'fs_point', targets: [{ format: colorFormat }] },
      primitive: { topology: 'point-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
      multisample: { count: sampleCount },
    }),
  };
}

/** @internal The points of one line or scatter on the GPU. */
export class TraceBuffer {
  private readonly points: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly size: number;
  private readonly data = new ArrayBuffer(traceUniformSize);
  private readonly floats = new Float32Array(this.data);
  private uploaded = 0;
  private uploadKey = '';

  constructor(
    private readonly gpu: GPUDevice,
    pipeline: GPURenderPipeline,
    private readonly source: Points3D,
    private readonly width: number,
    private readonly budget = 0,
    /** Whether the line lies over everything else. */
    readonly isOnTop = false,
  ) {
    this.size = placesOf(source.capacity) * traceStride;
    this.points = gpu.createBuffer({ size: this.size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.uniforms = gpu.createBuffer({
      size: traceUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms, size: traceUniformSize } }],
    });
    this.writeGap(0);
  }

  /**
   * Uploads the points appended since the last upload, all of them again when the key (ranges and color) changed.
   */
  upload(map: BoxMap, color: Rgba8, key: string, sizeCode = 255): void {
    if (key !== this.uploadKey) {
      this.uploadKey = key;
      this.uploaded = 0;
    }
    const points = this.source;
    const total = points.total;
    const slots = slotsOf(points.capacity);
    let row = Math.max(this.uploaded, total - points.capacity);
    if (row >= total) {
      return;
    }
    const size = Math.min(total - row, chunkSize);
    const chunk = new ArrayBuffer(size * traceStride);
    const floats = new Float32Array(chunk);
    const words = new Uint32Array(chunk);
    while (row < total) {
      const slot = row % slots;
      const count = Math.min(total - row, slots - slot, size);
      points.copyTo(row, floats, words, count, map, color, sizeCode);
      this.write(slot, new Uint8Array(chunk, 0, count * traceStride), slots);
      row += count;
    }
    this.writeGapAt(total % slots, slots);
    this.uploaded = total;
  }

  /** Writes the uniforms of the frame. */
  writeUniforms(matrix: Float32Array, width: number, height: number, cuts: Float32Array): void {
    const f = this.floats;
    f.set(matrix, 0);
    f.set([width, height, this.width, 0], 16);
    f.set(cuts, 20);
    this.gpu.queue.writeBuffer(this.uniforms, 0, this.data);
  }

  /** Draws the line: one instance of six corners per piece. */
  draw(pass: GPURenderPassEncoder): void {
    const pieces = Math.min(this.source.total, slotsOf(this.source.capacity));
    pass.setBindGroup(0, this.bindGroup);
    for (let buffer = 0; buffer < 4; buffer++) {
      const offset = buffer * traceStride;
      pass.setVertexBuffer(buffer, this.points, offset, this.size - offset);
    }
    pass.draw(traceCorners, pieces);
  }

  /** Draws the newest points within the budget as spots. */
  drawSpots(pass: GPURenderPassEncoder): void {
    const capacity = this.source.capacity;
    const total = this.source.total;
    const slots = slotsOf(capacity);
    const count = Math.min(total, capacity, this.budget);
    const head = total % slots;
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.points, 0, this.size);
    if (head >= count) {
      this.drawRun(pass, head - count, count);
    } else {
      this.drawRun(pass, 0, head);
      this.drawRun(pass, slots - (count - head), count - head);
    }
  }

  /** Lets go of the buffers. */
  dispose(): void {
    this.points.destroy();
    this.uniforms.destroy();
  }

  private drawRun(pass: GPURenderPassEncoder, first: number, count: number): void {
    if (count > 0) {
      pass.draw(traceCorners, count, 0, first + lead);
    }
  }

  private writeBytes(place: number, bytes: Uint8Array): void {
    this.gpu.queue.writeBuffer(this.points, place * traceStride, bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // A slot of the ring lands after the lead; the first slots also after the end, so that the last pieces read on.
  private write(slot: number, bytes: Uint8Array, slots: number): void {
    const count = bytes.byteLength / traceStride;
    this.writeBytes(slot + lead, bytes);
    if (slot < tail) {
      this.writeBytes(slots + lead + slot, bytes.subarray(0, Math.min(tail - slot, count) * traceStride));
    }
    if (slot + count === slots) {
      this.writeBytes(0, bytes.subarray((count - 1) * traceStride));
    }
  }

  private writeGapAt(slot: number, slots: number): void {
    const gap = new ArrayBuffer(traceStride);
    new Float32Array(gap)[0] = gapPlace;
    this.write(slot, new Uint8Array(gap), slots);
  }

  private writeGap(place: number): void {
    const gap = new ArrayBuffer(traceStride);
    new Float32Array(gap)[0] = gapPlace;
    this.writeBytes(place, new Uint8Array(gap));
  }
}
