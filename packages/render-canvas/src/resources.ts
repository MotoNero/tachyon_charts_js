// Buffers and textures of Canvas 2D: memory of the CPU, as the Skia backend of the .NET version keeps them.
import { BufferUsage, type GpuBuffer, type GpuTexture, type PixelSize, type TextureFormat } from '@tachyon-charts/core';

/** What buffers, textures, targets and frames need of their device. */
export interface CanvasContext {
  readonly capabilities: { readonly maxBufferSize: number; readonly maxTextureDimension: number };
  /** Draw calls issued so far. */
  drawCallCount: number;
  /** Bytes written to buffers and textures so far. */
  uploadedByteCount: number;
  /** Throws when the device is disposed or lost. */
  ensureUsable(): void;
}

const allUsages = BufferUsage.vertex | BufferUsage.uniform | BufferUsage.storage;

/** Bytes per texel of each format. */
export const bytesPerTexel: Record<TextureFormat, number> = { rgba8unorm: 4, r8unorm: 1, r32float: 4 };

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new RangeError(message);
  }
}

/** A {@link GpuBuffer} in the memory of the CPU. */
export class CanvasBuffer implements GpuBuffer {
  /** The content as bytes. */
  readonly bytes: Uint8Array;
  /** The content as floats. */
  readonly floats: Float32Array;
  /** The content as words, for packed colors. */
  readonly words: Uint32Array;
  private disposed = false;

  constructor(
    readonly device: CanvasContext,
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
    const memory = new ArrayBuffer(sizeInBytes);
    this.bytes = new Uint8Array(memory);
    this.floats = new Float32Array(memory);
    this.words = new Uint32Array(memory);
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
    this.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offsetInBytes);
    this.device.uploadedByteCount += data.byteLength;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Throws when this buffer or its device cannot be used any more. */
  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The buffer is disposed.');
    }
    this.device.ensureUsable();
  }
}

/** A {@link GpuTexture} in the memory of the CPU. */
export class CanvasTexture implements GpuTexture {
  /** The texels as bytes, rows tightly packed, top row first. */
  readonly bytes: Uint8Array;
  /** The texels as floats, for r32float. */
  readonly floats: Float32Array;
  private disposed = false;

  constructor(
    readonly device: CanvasContext,
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
    const memory = new ArrayBuffer(size.width * size.height * Math.max(bytesPerTexel[format], 4));
    this.bytes = new Uint8Array(memory, 0, size.width * size.height * bytesPerTexel[format]);
    this.floats = new Float32Array(memory, 0, Math.floor(memory.byteLength / 4));
  }

  write(pixels: ArrayBufferView): void {
    this.ensureUsable();
    const row = this.size.width * bytesPerTexel[this.format];
    check(
      pixels.byteLength === row * this.size.height,
      `The texture takes ${String(row * this.size.height)} bytes, not ${String(pixels.byteLength)}.`,
    );
    this.bytes.set(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
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
    this.bytes.set(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), row * length);
    this.device.uploadedByteCount += length;
  }

  dispose(): void {
    this.disposed = true;
  }

  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The texture is disposed.');
    }
    this.device.ensureUsable();
  }
}
