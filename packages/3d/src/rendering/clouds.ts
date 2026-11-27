// The points of a very large cloud on the GPU, as CloudBuffer of Renderer3D.Clouds in the .NET version: one buffer of
// its full size at once, so that the memory is known before the data arrive, drawn in runs as spots or single pixels.
import { cloudStride } from './cloud-work';
import { traceUniformSize, type TracePipelines } from './traces';

const spotCorners = 6;

/** @internal The points and uniforms of a cloud on the GPU. */
export class CloudBuffer {
  private readonly points: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly spotGroup: GPUBindGroup;
  private readonly pointGroup: GPUBindGroup;
  private readonly data = new ArrayBuffer(traceUniformSize);
  private readonly floats = new Float32Array(this.data);
  private firsts = new Int32Array(0);
  private counts = new Int32Array(0);
  private drawCount = 0;
  private usesSpots = true;

  /** The bytes it holds on the graphics card. */
  readonly bytes: number;

  constructor(
    private readonly gpu: GPUDevice,
    private readonly pipelines: TracePipelines,
    capacity: number,
    private readonly width: number,
  ) {
    this.bytes = Math.max(capacity, 1) * cloudStride;
    this.points = gpu.createBuffer({ size: this.bytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.uniforms = gpu.createBuffer({
      size: traceUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const entries = [{ binding: 0, resource: { buffer: this.uniforms, size: traceUniformSize } }];
    this.spotGroup = gpu.createBindGroup({ layout: pipelines.spots.getBindGroupLayout(0), entries });
    this.pointGroup = gpu.createBindGroup({ layout: pipelines.points.getBindGroupLayout(0), entries });
  }

  /** Writes a block of points at a place. */
  write(place: number, block: ArrayBuffer): void {
    if (block.byteLength > 0 && place * cloudStride + block.byteLength <= this.bytes) {
      this.gpu.queue.writeBuffer(this.points, place * cloudStride, block);
    }
  }

  /** Sets the runs to draw and whether they draw as spots or single pixels. */
  setDraws(firsts: Int32Array, counts: Int32Array, drawCount: number, usesSpots: boolean): void {
    if (this.firsts.length < drawCount) {
      this.firsts = new Int32Array(drawCount);
      this.counts = new Int32Array(drawCount);
    }
    this.firsts.set(firsts.subarray(0, drawCount));
    this.counts.set(counts.subarray(0, drawCount));
    this.drawCount = drawCount;
    this.usesSpots = usesSpots;
  }

  /** Writes the uniforms of the frame. */
  writeUniforms(matrix: Float32Array, width: number, height: number, cuts: Float32Array): void {
    const f = this.floats;
    f.set(matrix, 0);
    f[16] = width;
    f[17] = height;
    f[18] = this.width;
    f[19] = 0;
    f.set(cuts, 20);
    this.gpu.queue.writeBuffer(this.uniforms, 0, this.data);
  }

  /** Draws the runs. */
  draw(pass: GPURenderPassEncoder): void {
    if (this.drawCount === 0) {
      return;
    }
    pass.setPipeline(this.usesSpots ? this.pipelines.spots : this.pipelines.points);
    pass.setBindGroup(0, this.usesSpots ? this.spotGroup : this.pointGroup);
    pass.setVertexBuffer(0, this.points, 0, this.bytes);
    for (let i = 0; i < this.drawCount; i++) {
      const count = this.counts[i] as number;
      const first = this.firsts[i] as number;
      if (count > 0) {
        if (this.usesSpots) {
          pass.draw(spotCorners, count, 0, first);
        } else {
          pass.draw(count, 1, first, 0);
        }
      }
    }
  }

  /** Lets go of the buffers. */
  dispose(): void {
    this.points.destroy();
    this.uniforms.destroy();
  }
}
