// Meshes on the GPU and the weighted transparency that lays see-through surfaces over the picture without sorting
// them, as the mesh part and EncodeTransparent and EncodeComposite of Renderer3D in the .NET version.
import { clipWgsl, compositeWgsl, lightWgsl, meshWgsl } from '../generated/shaders';
import type { FullMaterial } from '../scene/surface';
import { meshUniformSize } from './bars';
import { transparentTargets } from './transparency';

/** @internal The bytes of one corner: place, normal, color. */
export const meshVertexStride = 28;
/** @internal The pipelines of meshes, opaque and see-through. */
export interface MeshPipelines {
  readonly opaque: GPURenderPipeline;
  readonly transparent: GPURenderPipeline;
}

/** @internal Creates the pipelines of meshes. */
export function createMeshPipelines(
  gpu: GPUDevice,
  colorFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  sampleCount: number,
): MeshPipelines {
  const module = gpu.createShaderModule({ label: 'mesh.wgsl', code: clipWgsl + lightWgsl + meshWgsl });
  const vertex: GPUVertexState = {
    module,
    entryPoint: 'vs_main',
    buffers: [
      {
        arrayStride: meshVertexStride,
        stepMode: 'vertex',
        attributes: [
          { format: 'float32x3', offset: 0, shaderLocation: 0 },
          { format: 'float32x3', offset: 12, shaderLocation: 1 },
          { format: 'unorm8x4', offset: 24, shaderLocation: 2 },
        ],
      },
    ],
  };
  const primitive: GPUPrimitiveState = { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' };
  return {
    opaque: gpu.createRenderPipeline({
      label: 'mesh 3D',
      layout: 'auto',
      vertex,
      fragment: { module, entryPoint: 'fs_opaque', targets: [{ format: colorFormat }] },
      primitive,
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
      multisample: { count: sampleCount },
    }),
    transparent: gpu.createRenderPipeline({
      label: 'mesh transparent 3D',
      layout: 'auto',
      vertex,
      fragment: { module, entryPoint: 'fs_transparent', targets: transparentTargets() },
      primitive,
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
      multisample: { count: sampleCount },
    }),
  };
}

/** @internal Creates the pipeline that lays the see-through surfaces over the picture. */
export function createCompositePipeline(gpu: GPUDevice, colorFormat: GPUTextureFormat): GPURenderPipeline {
  const module = gpu.createShaderModule({ label: 'composite.wgsl', code: compositeWgsl });
  return gpu.createRenderPipeline({
    label: 'composite 3D',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
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
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    multisample: { count: 1 },
  });
}

/** @internal The corners, triangles and uniforms of one mesh. */
export class MeshBuffers {
  private readonly vertices: GPUBuffer;
  private readonly indices: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly indexCount: number;
  private readonly data = new ArrayBuffer(meshUniformSize);
  private readonly floats = new Float32Array(this.data);

  constructor(
    private readonly gpu: GPUDevice,
    pipelines: MeshPipelines,
    private readonly material: FullMaterial,
    vertices: ArrayBuffer,
    indices: Uint32Array,
  ) {
    this.indexCount = indices.length;
    this.vertices = gpu.createBuffer({
      size: Math.max(vertices.byteLength, 16),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    gpu.queue.writeBuffer(this.vertices, 0, vertices);
    this.indices = gpu.createBuffer({
      size: Math.max(indices.byteLength, 16),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    if (indices.byteLength > 0) {
      gpu.queue.writeBuffer(this.indices, 0, indices.buffer, indices.byteOffset, indices.byteLength);
    }
    this.uniforms = gpu.createBuffer({
      size: meshUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const pipeline = material.opacity < 1 ? pipelines.transparent : pipelines.opaque;
    this.bindGroup = gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms, size: meshUniformSize } }],
    });
  }

  /** Whether the mesh lets what lies behind shine through. */
  get isTransparent(): boolean {
    return this.material.opacity < 1;
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

  /** Draws the triangles. */
  draw(pass: GPURenderPassEncoder): void {
    if (this.indexCount === 0) {
      return;
    }
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertices);
    pass.setIndexBuffer(this.indices, 'uint32');
    pass.drawIndexed(this.indexCount);
  }

  /** Lets go of the buffers. */
  dispose(): void {
    this.vertices.destroy();
    this.indices.destroy();
    this.uniforms.destroy();
  }
}
