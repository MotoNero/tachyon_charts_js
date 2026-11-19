// GPU resources: blocks of memory and images. Both the device and the command list refer to them.
import type { PixelSize, TextureFormat } from './types';

/** Something that holds GPU memory or other resources until it is disposed. Disposing twice does nothing. */
export interface Disposable {
  /** Frees what it holds; using it afterwards throws. */
  dispose(): void;
}

/** A block of GPU memory. */
export interface GpuBuffer extends Disposable {
  /** The size in bytes. */
  readonly sizeInBytes: number;
  /** The {@link BufferUsage} flags. */
  readonly usage: number;
  /**
   * Copies data into the buffer.
   * @param offsetInBytes - Where to start, a multiple of 4.
   * @param data - The data; its byte length must be a multiple of 4 and fit behind the offset.
   */
  write(offsetInBytes: number, data: ArrayBufferView): void;
}

/** A two-dimensional image in GPU memory. */
export interface GpuTexture extends Disposable {
  /** The size in texels. */
  readonly size: PixelSize;
  /** The format of a texel. */
  readonly format: TextureFormat;
  /** Replaces the whole content; rows tightly packed, top row first. */
  write(pixels: ArrayBufferView): void;
  /** Replaces one row. */
  writeRow(row: number, pixels: ArrayBufferView): void;
}
