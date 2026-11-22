// Buffers and textures on WebGL 2.
import { BufferUsage, type GpuBuffer, type GpuTexture, type PixelSize, type TextureFormat } from '@tachyon-charts/core';
import type { GlContext } from './context';

const allUsages = BufferUsage.vertex | BufferUsage.uniform | BufferUsage.storage;

/** Bytes per texel of each format. */
export const bytesPerTexel: Record<TextureFormat, number> = { rgba8unorm: 4, r8unorm: 1, r32float: 4 };

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new RangeError(message);
  }
}

/**
 * A {@link GpuBuffer} on WebGL 2. Vertex buffers live on the target ARRAY_BUFFER, the others on UNIFORM_BUFFER;
 * storage has no meaning without compute and is kept as a flag only.
 */
export class WebGlBuffer implements GpuBuffer {
  readonly buffer: WebGLBuffer;
  private readonly target: number;
  private disposed = false;

  constructor(
    readonly device: GlContext,
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
    const gl = device.gl;
    this.target = usage & BufferUsage.vertex ? gl.ARRAY_BUFFER : gl.UNIFORM_BUFFER;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(this.target, this.buffer);
    // Static, though it may be written again: ANGLE keeps dynamic buffers where the CPU can write them, and the GPU
    // then reads them over the bus every frame, which halved the speed of ten million markers.
    gl.bufferData(this.target, sizeInBytes, gl.STATIC_DRAW);
    gl.bindBuffer(this.target, null);
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
    const gl = this.device.gl;
    gl.bindBuffer(this.target, this.buffer);
    gl.bufferSubData(this.target, offsetInBytes, data);
    gl.bindBuffer(this.target, null);
    this.device.uploadedByteCount += data.byteLength;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.device.gl.deleteBuffer(this.buffer);
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

/** The internal format, format and type of WebGL for each texture format. */
const glFormats: Record<TextureFormat, { internal: number; format: number; type: number }> = {
  rgba8unorm: { internal: 0x8058, format: 0x1908, type: 0x1401 }, // RGBA8, RGBA, UNSIGNED_BYTE
  r8unorm: { internal: 0x8229, format: 0x1903, type: 0x1401 }, // R8, RED, UNSIGNED_BYTE
  r32float: { internal: 0x822e, format: 0x1903, type: 0x1406 }, // R32F, RED, FLOAT
};

/** A {@link GpuTexture} on WebGL 2. Shaders read it with texelFetch, so it is never filtered. */
export class WebGlTexture implements GpuTexture {
  readonly texture: WebGLTexture;
  private disposed = false;

  constructor(
    readonly device: GlContext,
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
    const gl = device.gl;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, glFormats[format].internal, size.width, size.height);
    // Float textures cannot be filtered; nearest keeps every format complete.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  write(pixels: ArrayBufferView): void {
    this.ensureUsable();
    const row = this.size.width * bytesPerTexel[this.format];
    check(
      pixels.byteLength === row * this.size.height,
      `The texture takes ${String(row * this.size.height)} bytes, not ${String(pixels.byteLength)}.`,
    );
    this.upload(0, this.size.height, pixels);
  }

  writeRow(row: number, pixels: ArrayBufferView): void {
    this.ensureUsable();
    const length = this.size.width * bytesPerTexel[this.format];
    check(
      Number.isInteger(row) && row >= 0 && row < this.size.height,
      `Row ${String(row)} is outside of 0..${String(this.size.height - 1)}.`,
    );
    check(pixels.byteLength === length, `A row takes ${String(length)} bytes, not ${String(pixels.byteLength)}.`);
    this.upload(row, 1, pixels);
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.device.gl.deleteTexture(this.texture);
    }
  }

  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The texture is disposed.');
    }
    this.device.ensureUsable();
  }

  // WebGL wants the array type that matches the texel type: bytes for the 8-bit formats, floats for r32float.
  private upload(row: number, rows: number, pixels: ArrayBufferView): void {
    const gl = this.device.gl;
    const { format, type } = glFormats[this.format];
    const data =
      type === gl.FLOAT
        ? new Float32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4)
        : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, this.size.width, rows, format, type, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.device.uploadedByteCount += pixels.byteLength;
  }
}
