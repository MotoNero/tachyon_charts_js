// Buffers and textures on WebGPU.
import { BufferUsage, type GpuBuffer, type GpuTexture, type PixelSize, type TextureFormat } from '@tachyon-charts/core';
import type { DeviceContext } from './context';

const allUsages = BufferUsage.vertex | BufferUsage.uniform | BufferUsage.storage;

/** Bytes per texel of each format. */
export const bytesPerTexel: Record<TextureFormat, number> = { rgba8unorm: 4, r8unorm: 1, r32float: 4 };

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new RangeError(message);
  }
}

/** A {@link GpuBuffer} on WebGPU. Every buffer can be copied from, so that tests and compute work can read it back. */
export class WebGpuBuffer implements GpuBuffer {
  readonly buffer: GPUBuffer;
  private disposed = false;

  constructor(
    readonly device: DeviceContext,
    readonly sizeInBytes: number,
    readonly usage: number,
  ) {
    check(
      Number.isInteger(sizeInBytes) && sizeInBytes > 0 && sizeInBytes % 4 === 0,
      `A buffer needs a size above 0 and a multiple of 4, not ${String(sizeInBytes)}.`,
    );
    check(
      sizeInBytes <= device.capabilities.maxBufferSize,
      `${String(sizeInBytes)} bytes exceed the largest buffer of the device, ${String(device.capabilities.maxBufferSize)}.`,
    );
    check(
      usage !== 0 && (usage & ~allUsages) === 0,
      `The usage ${String(usage)} is no combination of BufferUsage flags.`,
    );
    let flags = GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    if (usage & BufferUsage.vertex) flags |= GPUBufferUsage.VERTEX;
    if (usage & BufferUsage.uniform) flags |= GPUBufferUsage.UNIFORM;
    if (usage & BufferUsage.storage) flags |= GPUBufferUsage.STORAGE;
    this.buffer = device.gpu.createBuffer({ size: sizeInBytes, usage: flags });
  }

  write(offsetInBytes: number, data: ArrayBufferView): void {
    this.ensureUsable();
    check(
      Number.isInteger(offsetInBytes) && offsetInBytes >= 0 && offsetInBytes % 4 === 0,
      `The offset must be a multiple of 4 from 0, not ${String(offsetInBytes)}.`,
    );
    check(data.byteLength % 4 === 0, `The data must be a multiple of 4 bytes long, not ${String(data.byteLength)}.`);
    check(
      offsetInBytes + data.byteLength <= this.sizeInBytes,
      `${String(data.byteLength)} bytes at ${String(offsetInBytes)} do not fit into ${String(this.sizeInBytes)}.`,
    );
    this.device.gpu.queue.writeBuffer(this.buffer, offsetInBytes, data.buffer, data.byteOffset, data.byteLength);
    this.device.uploadedByteCount += data.byteLength;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.buffer.destroy();
    }
  }

  /** Throws when this buffer or its device cannot be used any more. */
  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The buffer is disposed.');
    }
    this.device.ensureUsable();
  }
}

/** A {@link GpuTexture} on WebGPU. */
export class WebGpuTexture implements GpuTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  private disposed = false;

  constructor(
    readonly device: DeviceContext,
    readonly size: PixelSize,
    readonly format: TextureFormat,
  ) {
    const limit = device.capabilities.maxTextureDimension;
    check(
      Number.isInteger(size.width) &&
        Number.isInteger(size.height) &&
        size.width > 0 &&
        size.height > 0 &&
        size.width <= limit &&
        size.height <= limit,
      `A texture needs a size from 1 to ${String(limit)} on each side, not ${String(size.width)} × ${String(size.height)}.`,
    );
    check(format in bytesPerTexel, `"${format}" is no texture format.`);
    this.texture = device.gpu.createTexture({
      size: { width: size.width, height: size.height },
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    this.view = this.texture.createView();
  }

  write(pixels: ArrayBufferView): void {
    this.ensureUsable();
    const row = this.size.width * bytesPerTexel[this.format];
    check(
      pixels.byteLength === row * this.size.height,
      `The texture takes ${String(row * this.size.height)} bytes, not ${String(pixels.byteLength)}.`,
    );
    this.device.gpu.queue.writeTexture(
      { texture: this.texture },
      pixels.buffer,
      { offset: pixels.byteOffset, bytesPerRow: row, rowsPerImage: this.size.height },
      { width: this.size.width, height: this.size.height },
    );
    this.device.uploadedByteCount += pixels.byteLength;
  }

  writeRow(row: number, pixels: ArrayBufferView): void {
    this.ensureUsable();
    const length = this.size.width * bytesPerTexel[this.format];
    check(
      Number.isInteger(row) && row >= 0 && row < this.size.height,
      `Row ${String(row)} is outside of 0..${String(this.size.height - 1)}.`,
    );
    check(pixels.byteLength === length, `A row takes ${String(length)} bytes, not ${String(pixels.byteLength)}.`);
    this.device.gpu.queue.writeTexture(
      { texture: this.texture, origin: { x: 0, y: row } },
      pixels.buffer,
      { offset: pixels.byteOffset, bytesPerRow: length },
      { width: this.size.width, height: 1 },
    );
    this.device.uploadedByteCount += length;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.texture.destroy();
    }
  }

  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The texture is disposed.');
    }
    this.device.ensureUsable();
  }
}
