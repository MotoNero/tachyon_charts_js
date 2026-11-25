// Columns on the GPU: one instance per cell, 36 corners of a box each, drawn row by row away from the eye, as the bar
// part of Renderer3D in the .NET version.
import { barsWgsl, clipWgsl, lightWgsl } from '../generated/shaders';
import { barStride, type GridPlace } from '../scene/bars';
import type { FullMaterial } from '../scene/surface';

const barCorners = 36;
/** @internal The size of the uniforms of meshes and bars: camera, eye, material, cuts. */
export const meshUniformSize = 160;

/** @internal Creates the pipeline of opaque columns. */
export function createBarPipeline(
  gpu: GPUDevice,
  colorFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  sampleCount: number,
): GPURenderPipeline {
  const module = gpu.createShaderModule({ label: 'bars.wgsl', code: clipWgsl + lightWgsl + barsWgsl });
  return gpu.createRenderPipeline({
    label: 'bars 3D',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: barStride,
          stepMode: 'instance',
          attributes: [
            { format: 'float32x4', offset: 0, shaderLocation: 0 },
            { format: 'float32x2', offset: 16, shaderLocation: 1 },
            { format: 'unorm8x4', offset: 24, shaderLocation: 2 },
          ],
        },
      ],
    },
    fragment: { module, entryPoint: 'fs_opaque', targets: [{ format: colorFormat }] },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
    multisample: { count: sampleCount },
  });
}

/** @internal The columns of one element on the GPU. */
export class BarBuffer {
  private readonly instances: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly data = new ArrayBuffer(meshUniformSize);
  private readonly floats = new Float32Array(this.data);
  /** The cells in the box. */
  place: GridPlace | undefined;

  constructor(
    private readonly gpu: GPUDevice,
    pipeline: GPURenderPipeline,
    private readonly material: FullMaterial,
    /** The number of columns. */
    readonly count: number,
  ) {
    this.instances = gpu.createBuffer({
      size: Math.max(count, 1) * barStride,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.uniforms = gpu.createBuffer({
      size: meshUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms, size: meshUniformSize } }],
    });
  }

  /** Whether the columns let what lies behind shine through. */
  get isTransparent(): boolean {
    return this.material.opacity < 1;
  }

  /** Writes the columns. */
  write(instances: ArrayBuffer): void {
    this.gpu.queue.writeBuffer(this.instances, 0, instances);
  }

  /** Writes the uniforms of the frame. */
  writeUniforms(matrix: Float32Array, eye: readonly [number, number, number], cuts: Float32Array): void {
    const m = this.material;
    this.floats.set(matrix, 0);
    this.floats.set([eye[0], eye[1], eye[2], 1], 16);
    this.floats.set([m.gloss, m.sharpness, m.opacity, m.isLit ? 1 : 0], 20);
    this.floats.set(cuts, 24);
    this.gpu.queue.writeBuffer(this.uniforms, 0, this.data);
  }

  /** Draws row by row away from the eye: the depth test then rejects what lies behind before any light is computed. */
  draw(pass: GPURenderPassEncoder, eyeY: number): void {
    const place = this.place;
    if (!place) {
      return;
    }
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.instances);
    const columns = place.columns - 1;
    const rows = place.rows - 1;
    const nearest = Math.min(Math.max(Math.trunc((eyeY - place.front) / place.stepY), 0), rows - 1);
    for (let row = nearest; row < rows; row++) {
      pass.draw(barCorners, columns, 0, row * columns);
    }
    for (let row = nearest - 1; row >= 0; row--) {
      pass.draw(barCorners, columns, 0, row * columns);
    }
  }

  /** Lets go of the buffers. */
  dispose(): void {
    this.instances.destroy();
    this.uniforms.destroy();
  }
}
