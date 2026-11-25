// The GPU side of height fields: heights in a storage buffer, the colormap as a table, the triangles of the grid as
// indices, as SurfaceBuffers of Renderer3D in the .NET version.
import type { FullMaterial } from '../scene/surface';
import { wallDistance, type Contours3D } from '../scene/surface';

/** @internal The size of the uniforms of a surface: camera, eye, material, grid, origin, colors, contour, planes, cuts. */
export const surfaceUniformSize = 256;

/** @internal The shape of a surface in the box. */
export interface SurfaceShape {
  readonly columns: number;
  readonly rows: number;
  /** Left and front edge in the box, then the step per column and row. */
  readonly origin: readonly [number, number, number, number];
  /** The heights in the box that match the ends of the colormap. */
  readonly colors: readonly [number, number];
  readonly firstRow: number;
  readonly levels: Float32Array;
  readonly contours: Contours3D | undefined;
}

/** @internal The pipelines surfaces draw with. */
export interface SurfacePipelines {
  readonly opaque: GPURenderPipeline;
  readonly projection: GPURenderPipeline;
}

/** @internal The buffers of one surface. */
export class SurfaceBuffers {
  private readonly heights: GPUBuffer;
  private readonly colors: GPUBuffer;
  private readonly indices: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly levels: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly projectionBindGroup: GPUBindGroup | undefined;
  private readonly indexCount: number;
  private readonly data = new ArrayBuffer(surfaceUniformSize);
  private readonly floats = new Float32Array(this.data);
  private readonly words = new Uint32Array(this.data);
  private shape: SurfaceShape;

  constructor(
    private readonly gpu: GPUDevice,
    pipelines: SurfacePipelines,
    private readonly material: FullMaterial,
    shape: SurfaceShape,
    colors: Float32Array,
  ) {
    this.shape = shape;
    const values = shape.columns * shape.rows;
    const storage = (size: number, usage: number): GPUBuffer =>
      gpu.createBuffer({ size: Math.max(size, 16), usage: usage | GPUBufferUsage.COPY_DST });
    this.heights = storage(values * 4, GPUBufferUsage.STORAGE);
    this.colors = storage(colors.byteLength, GPUBufferUsage.STORAGE);
    gpu.queue.writeBuffer(this.colors, 0, colors.buffer, colors.byteOffset, colors.byteLength);
    this.indexCount = (shape.columns - 1) * (shape.rows - 1) * 6;
    this.indices = storage(this.indexCount * 4, GPUBufferUsage.INDEX);
    this.writeIndices(shape.columns, shape.rows);
    this.uniforms = gpu.createBuffer({
      size: surfaceUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const levels = shape.levels;
    this.levels = storage(Math.max(levels.length, 4) * 4, GPUBufferUsage.STORAGE);
    if (levels.length > 0) {
      gpu.queue.writeBuffer(this.levels, 0, levels.buffer, levels.byteOffset, levels.byteLength);
    }
    this.bindGroup = gpu.createBindGroup({
      layout: pipelines.opaque.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniforms, size: surfaceUniformSize } },
        { binding: 1, resource: { buffer: this.heights, size: values * 4 } },
        { binding: 2, resource: { buffer: this.colors, size: colors.byteLength } },
        { binding: 3, resource: { buffer: this.levels, size: Math.max(levels.length, 4) * 4 } },
      ],
    });
    if (shape.contours) {
      this.projectionBindGroup = gpu.createBindGroup({
        layout: pipelines.projection.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniforms, size: surfaceUniformSize } },
          { binding: 1, resource: { buffer: this.heights, size: values * 4 } },
          { binding: 3, resource: { buffer: this.levels, size: Math.max(levels.length, 4) * 4 } },
        ],
      });
    }
  }

  /** Whether the surface lets what lies behind shine through. */
  get isTransparent(): boolean {
    return this.material.opacity < 1;
  }

  /** Whether a new shape fits these buffers. */
  fits(shape: SurfaceShape): boolean {
    return shape.columns === this.shape.columns && shape.rows === this.shape.rows;
  }

  /** Writes new heights. */
  write(shape: SurfaceShape, heights: Float32Array): void {
    this.shape = shape;
    this.gpu.queue.writeBuffer(this.heights, 0, heights.buffer, heights.byteOffset, heights.byteLength);
  }

  /** Writes the uniforms of the frame. */
  writeUniforms(
    matrix: Float32Array,
    eye: readonly [number, number, number],
    planes: readonly number[],
    cuts: Float32Array,
  ): void {
    const f = this.floats;
    const shape = this.shape;
    const material = this.material;
    const contours = shape.contours;
    f.set(matrix, 0);
    f.set([eye[0], eye[1], eye[2], 1], 16);
    f.set([material.gloss, material.sharpness, material.opacity, material.isLit ? 1 : 0], 20);
    this.words.set([shape.columns, shape.rows, shape.firstRow, 0], 24);
    f.set(shape.origin, 28);
    f.set([shape.colors[0], shape.colors[1], 0, 0], 32);
    f.set([shape.levels.length, contours?.width ?? (contours ? 1.25 : 0), wallDistance, 0], 36);
    const color = contours ? (contours.color ?? { r: 255, g: 255, b: 255, a: 200 }) : undefined;
    f.set(color ? [color.r / 255, color.g / 255, color.b / 255, color.a / 255] : [0, 0, 0, 0], 40);
    f.set(planes, 44);
    f.set(cuts, 48);
    this.gpu.queue.writeBuffer(this.uniforms, 0, this.data);
  }

  /** Draws the surface. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, this.bindGroup);
    pass.setIndexBuffer(this.indices, 'uint32', 0, this.indexCount * 4);
    pass.drawIndexed(this.indexCount);
  }

  /** Draws the height lines on the floor and the cuts on the walls. */
  drawProjection(pass: GPURenderPassEncoder): void {
    const contours = this.shape.contours;
    const onFloor = contours?.onFloor ?? true;
    const onWalls = contours?.onWalls ?? false;
    if (!contours || !this.projectionBindGroup || (!onFloor && !onWalls)) {
      return;
    }
    const first = onFloor ? 0 : 1;
    const count = (onFloor ? 1 : 0) + (onWalls ? 2 : 0);
    pass.setBindGroup(0, this.projectionBindGroup);
    pass.setIndexBuffer(this.indices, 'uint32', 0, this.indexCount * 4);
    pass.drawIndexed(this.indexCount, count, 0, 0, first);
  }

  /** Lets go of the buffers. */
  dispose(): void {
    this.heights.destroy();
    this.colors.destroy();
    this.indices.destroy();
    this.uniforms.destroy();
    this.levels.destroy();
  }

  private writeIndices(columns: number, rows: number): void {
    const quads = new Uint32Array((columns - 1) * 6);
    for (let row = 0; row < rows - 1; row++) {
      for (let column = 0; column < columns - 1; column++) {
        const corner = row * columns + column;
        const at = column * 6;
        quads[at] = corner;
        quads[at + 1] = corner + 1;
        quads[at + 2] = corner + columns;
        quads[at + 3] = corner + 1;
        quads[at + 4] = corner + columns + 1;
        quads[at + 5] = corner + columns;
      }
      this.gpu.queue.writeBuffer(this.indices, row * quads.byteLength, quads);
    }
  }
}
