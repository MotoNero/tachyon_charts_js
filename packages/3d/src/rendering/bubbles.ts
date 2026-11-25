// Bubbles on the GPU: one quad per bubble that the shader shapes into a lit sphere, as the bubble part of Renderer3D
// in the .NET version.
import { bubblesWgsl, clipWgsl, lightWgsl } from '../generated/shaders';
import type { FullMaterial } from '../scene/surface';

const bubbleCorners = 6;
/** @internal The bytes of one bubble: middle in the box, size, color. */
export const bubbleStride = 20;
const uniformSize = 176;

/** @internal Creates the pipeline of bubbles. */
export function createBubblePipeline(
  gpu: GPUDevice,
  colorFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  sampleCount: number,
): GPURenderPipeline {
  const module = gpu.createShaderModule({ label: 'bubbles.wgsl', code: clipWgsl + lightWgsl + bubblesWgsl });
  return gpu.createRenderPipeline({
    label: 'bubbles 3D',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: bubbleStride,
          stepMode: 'instance',
          attributes: [
            { format: 'float32x3', offset: 0, shaderLocation: 0 },
            { format: 'float32', offset: 12, shaderLocation: 1 },
            { format: 'unorm8x4', offset: 16, shaderLocation: 2 },
          ],
        },
      ],
    },
    // The alpha of the shader only decides on the coverage of the edge. The picture stays opaque.
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [{ format: colorFormat, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE }],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
    multisample: { count: sampleCount, alphaToCoverageEnabled: true },
  });
}

/** @internal The bubbles of one element on the GPU. */
export class BubbleBuffer {
  private readonly instances: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly data = new ArrayBuffer(uniformSize);
  private readonly floats = new Float32Array(this.data);
  private count = 0;

  constructor(
    private readonly gpu: GPUDevice,
    pipeline: GPURenderPipeline,
    private readonly material: FullMaterial,
    /** The most bubbles the buffer holds. */
    readonly capacity: number,
  ) {
    this.instances = gpu.createBuffer({
      size: Math.max(capacity, 1) * bubbleStride,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.uniforms = gpu.createBuffer({ size: uniformSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bindGroup = gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms, size: uniformSize } }],
    });
  }

  /** Writes the bubbles. */
  write(instances: ArrayBuffer, count: number): void {
    this.count = count;
    if (count > 0) {
      this.gpu.queue.writeBuffer(this.instances, 0, instances, 0, count * bubbleStride);
    }
  }

  /** Writes the uniforms of the frame. */
  writeUniforms(
    matrix: Float32Array,
    eye: readonly [number, number, number],
    cuts: Float32Array,
    width: number,
    height: number,
  ): void {
    const m = this.material;
    this.floats.set(matrix, 0);
    this.floats.set([eye[0], eye[1], eye[2], 1], 16);
    this.floats.set([m.gloss, m.sharpness, 1, m.isLit ? 1 : 0], 20);
    this.floats.set(cuts, 24);
    this.floats.set([width, height, 0, 0], 40);
    this.gpu.queue.writeBuffer(this.uniforms, 0, this.data);
  }

  /** Draws the bubbles. */
  draw(pass: GPURenderPassEncoder): void {
    if (this.count === 0) {
      return;
    }
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.instances);
    pass.draw(bubbleCorners, this.count);
  }

  /** Lets go of the buffers. */
  dispose(): void {
    this.instances.destroy();
    this.uniforms.destroy();
  }
}
