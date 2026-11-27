// The volumes on the GPU, as VolumeBuffer, VolumeFit and the volume pipelines of Renderer3D in the .NET version: a 3D
// texture filled slice by slice, three slices drawn with the opaque scene, and rays through the volume in a pass of
// their own that reads the depth of the scene.
import { clipWgsl, lightWgsl, volumeWgsl } from '../generated/shaders';
import type { Volume3D, VolumeData, VolumeGpuFit } from '../scene/volume';
import { transferTableSize } from '../scene/transfer';

/** @internal The bytes of the uniforms of a volume, in the order of volume.wgsl. */
export const volumeUniformSize = 336;
const transferBytes = transferTableSize * 16;
const sliceCorners = 6;
const sliceCount = 3;

/** @internal The pipelines of volumes and their sampler. */
export interface VolumePipelines {
  readonly slices: GPURenderPipeline;
  readonly march: GPURenderPipeline;
  readonly sampler: GPUSampler;
}

/** @internal Creates the pipelines of volumes. */
export function createVolumePipelines(
  gpu: GPUDevice,
  colorFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  sampleCount: number,
): VolumePipelines {
  const module = gpu.createShaderModule({ label: 'volume.wgsl', code: clipWgsl + lightWgsl + volumeWgsl });
  return {
    slices: gpu.createRenderPipeline({
      label: 'volume slices 3D',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_slice' },
      fragment: { module, entryPoint: 'fs_slice', targets: [{ format: colorFormat }] },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
      multisample: { count: sampleCount },
    }),
    march: gpu.createRenderPipeline({
      label: 'volume march 3D',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_march' },
      fragment: {
        module,
        entryPoint: 'fs_march',
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
      multisample: { count: 1 },
    }),
    sampler: gpu.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    }),
  };
}

/** @internal The number of values left along an axis at a reduction. */
export function reduceCount(count: number, reduction: number): number {
  return Math.trunc((count + reduction - 1) / reduction);
}

function volumeBytes(data: VolumeData, reduction: number, bytesPerValue: number): number {
  return (
    reduceCount(data.width, reduction) *
    reduceCount(data.height, reduction) *
    reduceCount(data.depth, reduction) *
    bytesPerValue
  );
}

/**
 * @internal Chooses how a volume goes to the graphics card: exact first, then 16-bit floats, then every second, third …
 * value, so that it still shows instead of failing.
 */
export function chooseVolumeFit(data: VolumeData, canBeExact: boolean, maxSide: number, budget: number): VolumeGpuFit {
  const isBytes = data.isBytes;
  const full = volumeBytes(data, 1, isBytes ? 1 : 4);
  // At the largest side as reduction a single value is left, which is always taken.
  const last = Math.max(data.width, data.height, data.depth);
  for (let reduction = 1; reduction < last; reduction++) {
    const side = Math.max(
      reduceCount(data.width, reduction),
      reduceCount(data.height, reduction),
      reduceCount(data.depth, reduction),
    );
    if (side > maxSide) {
      continue;
    }
    if (isBytes || canBeExact) {
      const exact = volumeBytes(data, reduction, isBytes ? 1 : 4);
      if (exact <= budget) {
        return { reduction, isExact: true, bytes: exact, fullBytes: full, budget };
      }
    }
    const halves = volumeBytes(data, reduction, 2);
    if (!isBytes && halves <= budget) {
      return { reduction, isExact: false, bytes: halves, fullBytes: full, budget };
    }
  }
  let bytesPerValue = 4;
  if (isBytes) {
    bytesPerValue = 1;
  } else if (!canBeExact) {
    bytesPerValue = 2;
  }
  return { reduction: last, isExact: isBytes || canBeExact, bytes: bytesPerValue, fullBytes: full, budget };
}

// The bits of a 16-bit float, rounded to the nearest even as the conversion of .NET.
const halfScratch = new Float32Array(1);
const halfBits = new Uint32Array(halfScratch.buffer);
function toHalf(value: number): number {
  halfScratch[0] = value;
  const bits = halfBits[0] as number;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) {
    return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
  }
  const half = exponent - 127 + 15;
  if (half >= 0x1f) {
    return sign | 0x7c00;
  }
  if (half <= 0) {
    if (half < -10) {
      return sign;
    }
    const full = mantissa | 0x800000;
    const shift = 14 - half;
    const rounded = full >>> shift;
    const rest = full & ((1 << shift) - 1);
    const middle = 1 << (shift - 1);
    return sign | (rounded + (rest > middle || (rest === middle && (rounded & 1) === 1) ? 1 : 0));
  }
  const rounded = (half << 10) | (mantissa >>> 13);
  const rest = mantissa & 0x1fff;
  return sign | (rounded + (rest > 0x1000 || (rest === 0x1000 && (rounded & 1) === 1) ? 1 : 0));
}

/** @internal The texture, colors and uniforms of a volume on the GPU. */
export class VolumeBuffer {
  private readonly texture: GPUTexture;
  private readonly colors: GPUBuffer;
  private readonly transfer: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly sliceGroup: GPUBindGroup;
  private marchGroup: GPUBindGroup | undefined;
  private marchDepth: GPUTextureView | undefined;
  private readonly format: GPUTextureFormat;
  private readonly reduction: number;
  private readonly width: number;
  private readonly height: number;
  private readonly depth: number;
  private readonly data = new ArrayBuffer(volumeUniformSize);
  private readonly floats = new Float32Array(this.data);
  private reduced = new Float32Array(0);
  private halves = new Uint16Array(0);
  /** Whether the slices show. */
  showsSlices = true;
  /** Whether rays run through the volume. */
  marches = false;
  /** How the volume fits. */
  readonly fit: VolumeGpuFit;

  constructor(
    private readonly gpu: GPUDevice,
    private readonly pipelines: VolumePipelines,
    private readonly volume: Volume3D,
    colors: Float32Array,
  ) {
    const data = volume.data;
    const canBeExact = gpu.features.has('float32-filterable');
    this.fit = chooseVolumeFit(data, canBeExact, gpu.limits.maxTextureDimension3D, volume.gpuMemoryLimit);
    this.reduction = this.fit.reduction;
    if (data.isBytes) {
      this.format = 'r8unorm';
    } else {
      this.format = this.fit.isExact ? 'r32float' : 'r16float';
    }
    this.width = reduceCount(data.width, this.reduction);
    this.height = reduceCount(data.height, this.reduction);
    this.depth = reduceCount(data.depth, this.reduction);
    this.texture = gpu.createTexture({
      label: 'volume 3D',
      dimension: '3d',
      size: [this.width, this.height, this.depth],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.colors = gpu.createBuffer({
      size: colors.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    gpu.queue.writeBuffer(this.colors, 0, colors.buffer, colors.byteOffset, colors.byteLength);
    this.transfer = gpu.createBuffer({ size: transferBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uniforms = gpu.createBuffer({
      size: volumeUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sliceGroup = gpu.createBindGroup({
      layout: pipelines.slices.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniforms, size: volumeUniformSize } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: pipelines.sampler },
        { binding: 3, resource: { buffer: this.colors } },
      ],
    });
  }

  /** Whether the texture keeps a slice; a reduced volume keeps every n-th. */
  keeps(z: number): boolean {
    return z % this.reduction === 0;
  }

  /** Writes a slice of shares from 0 to 1. */
  writeShares(z: number, shares: Float32Array): void {
    const values = this.reduction > 1 ? this.reduce(shares) : shares;
    const target = Math.trunc(z / this.reduction);
    if (this.format === 'r32float') {
      this.writeSlice(target, values, 4);
      return;
    }
    if (this.halves.length < values.length) {
      this.halves = new Uint16Array(values.length);
    }
    for (let i = 0; i < values.length; i++) {
      this.halves[i] = toHalf(values[i] as number);
    }
    this.writeSlice(target, this.halves.subarray(0, values.length), 2);
  }

  /** Writes a slice of bytes. */
  writeBytes(z: number, bytes: Uint8Array): void {
    let values = bytes;
    if (this.reduction > 1) {
      const means = this.reduce(Float32Array.from(bytes));
      values = Uint8Array.from(means, (mean) => Math.round(mean));
    }
    this.writeSlice(Math.trunc(z / this.reduction), values, 1);
  }

  /** Sets the uniforms of the place, the slices and the color range. */
  setPlace(
    low: readonly number[],
    high: readonly number[],
    slices: readonly number[],
    colorRange: readonly number[],
  ): void {
    const f = this.floats;
    f.set([...low, 0], 32);
    f.set([...high, 0], 36);
    f.set(slices, 40);
    f[50] = colorRange[0] as number;
    f[51] = colorRange[1] as number;
  }

  /** Sets how a frame looks through the volume: march, look, eye, material, the corners and the transfer table. */
  setMarch(
    march: readonly number[],
    look: readonly number[],
    eye: readonly number[],
    material: readonly number[],
    corners: Float32Array,
    table: Float32Array,
  ): void {
    this.marches = true;
    const f = this.floats;
    f.set(march, 44);
    f[48] = look[0] as number;
    f[49] = look[1] as number;
    f.set(eye, 52);
    f.set(material, 56);
    f.set(corners, 60);
    this.gpu.queue.writeBuffer(this.transfer, 0, table.buffer, table.byteOffset, transferBytes);
  }

  /** Writes the colormap again. */
  setColors(colors: Float32Array): void {
    this.gpu.queue.writeBuffer(this.colors, 0, colors.buffer, colors.byteOffset, colors.byteLength);
  }

  /** Writes the uniforms of the frame. */
  writeUniforms(matrix: Float32Array, cuts: Float32Array): void {
    this.floats.set(matrix, 0);
    this.floats.set(cuts, 16);
    this.gpu.queue.writeBuffer(this.uniforms, 0, this.data);
  }

  /** Draws the three slices. */
  drawSlices(pass: GPURenderPassEncoder): void {
    if (this.showsSlices) {
      pass.setBindGroup(0, this.sliceGroup);
      pass.draw(sliceCorners, sliceCount);
    }
  }

  /** Draws the rays: one triangle over the picture. */
  drawMarch(pass: GPURenderPassEncoder, depth: GPUTextureView): void {
    if (!this.marches) {
      return;
    }
    if (!this.marchGroup || this.marchDepth !== depth) {
      this.marchDepth = depth;
      this.marchGroup = this.gpu.createBindGroup({
        layout: this.pipelines.march.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniforms, size: volumeUniformSize } },
          { binding: 1, resource: this.texture.createView() },
          { binding: 2, resource: this.pipelines.sampler },
          { binding: 3, resource: { buffer: this.colors } },
          { binding: 4, resource: { buffer: this.transfer } },
          { binding: 5, resource: depth },
        ],
      });
    }
    pass.setBindGroup(0, this.marchGroup);
    pass.draw(3);
  }

  /** Lets go of the texture and buffers. */
  dispose(): void {
    this.texture.destroy();
    this.colors.destroy();
    this.transfer.destroy();
    this.uniforms.destroy();
  }

  private writeSlice(z: number, values: ArrayBufferView, bytesPerValue: number): void {
    if (z >= this.depth) {
      return;
    }
    this.gpu.queue.writeTexture(
      { texture: this.texture, origin: [0, 0, z] },
      values as GPUAllowSharedBufferSource,
      { bytesPerRow: this.width * bytesPerValue, rowsPerImage: this.height },
      [this.width, this.height, 1],
    );
  }

  // The mean of each square of reduction × reduction values in the slice; the slices between are left out.
  private reduce(slice: Float32Array): Float32Array {
    const data = this.volume.data;
    const count = this.width * this.height;
    if (this.reduced.length < count) {
      this.reduced = new Float32Array(count);
    }
    const r = this.reduction;
    for (let row = 0; row < this.height; row++) {
      for (let column = 0; column < this.width; column++) {
        let sum = 0;
        let n = 0;
        for (let y = row * r; y < Math.min((row + 1) * r, data.height); y++) {
          for (let x = column * r; x < Math.min((column + 1) * r, data.width); x++) {
            sum += slice[y * data.width + x] as number;
            n++;
          }
        }
        this.reduced[row * this.width + column] = sum / n;
      }
    }
    return this.reduced.subarray(0, count);
  }
}
