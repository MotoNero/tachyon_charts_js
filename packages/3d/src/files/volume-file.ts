// Volumes from raw files and from NIfTI-1, also packed with gzip, read with code of its own, as VolumeFile of the .NET
// version. DICOM is not read here.
import { DoubleRange } from '@tachyon-charts/core';
import type { Chart3DBuilder } from '../chart3d-builder';
import { Volume3D, VolumeData } from '../scene/volume';
import { PointFileError } from './file-error';

const niftiHeader = 348;
const niftiTwoHeader = 540;
const largestCount = 2 ** 31 - 1;

/** The kind of values in a raw volume file. */
export type VolumeValueType = 'uint8' | 'uint16' | 'int16' | 'float32';

/** How a raw volume file is laid out. Raw files carry no header, so the application says it. */
export interface RawVolumeLayout {
  /** The values along the first axis. */
  readonly width: number;
  /** The values along the second axis. */
  readonly height: number;
  /** The values along the third axis. */
  readonly depth: number;
  /** The kind of values. */
  readonly type: VolumeValueType;
  /** Whether multi-byte values start with the high byte; false by default. */
  readonly isBigEndian?: boolean;
  /** The bytes before the first value; 0 by default. */
  readonly offset?: number;
  /** The distance of two values along each axis, for example in millimetres; 1 each by default. */
  readonly spacing?: readonly [number, number, number];
}

/** A volume from a file, with the distance of its values along each axis. */
export class VolumeFileData {
  /**
   * @param data - The values.
   * @param spacing - The distance of two values along each axis.
   */
  constructor(
    /** The values. */
    readonly data: VolumeData,
    /** The distance of two values along each axis. */
    readonly spacing: readonly [number, number, number],
  ) {}

  /** The size of the volume along each axis, in the unit of the spacing. */
  get extent(): [number, number, number] {
    const data = this.data;
    return [
      (data.width - 1) * this.spacing[0],
      (data.height - 1) * this.spacing[1],
      (data.depth - 1) * this.spacing[2],
    ];
  }

  /** A volume that spans its real size. */
  toVolume(): Volume3D {
    const [x, y, z] = this.extent;
    return new Volume3D(this.data, new DoubleRange(0, x), new DoubleRange(0, y), new DoubleRange(0, z));
  }

  /**
   * Adds the volume to a chart to scale: all three axes get the length of the longest side, so that uneven spacing
   * keeps the true proportions in the cube of the chart.
   */
  addToScale(chart: Chart3DBuilder, volume?: Volume3D, unit = 'mm'): Chart3DBuilder {
    const side = Math.max(...this.extent);
    return chart
      .xAxis(0, side, `x in ${unit}`)
      .yAxis(0, side, `y in ${unit}`)
      .zAxis(0, side, `z in ${unit}`)
      .addVolume(volume ?? this.toVolume());
  }
}

// Reads a stream of bytes exactly, chunk by chunk.
class ByteReader {
  private chunk: Uint8Array = new Uint8Array(0);
  private at = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Fills a target completely; false when the stream ends before. */
  async fill(target: Uint8Array): Promise<boolean> {
    let done = 0;
    while (done < target.length) {
      if (this.at >= this.chunk.length) {
        const next = await this.reader.read();
        if (next.done) {
          return false;
        }
        this.chunk = next.value;
        this.at = 0;
      }
      const take = Math.min(target.length - done, this.chunk.length - this.at);
      target.set(this.chunk.subarray(this.at, this.at + take), done);
      this.at += take;
      done += take;
    }
    return true;
  }

  /** Skips bytes; false when the stream ends before. */
  async skip(count: number): Promise<boolean> {
    const step = new Uint8Array(Math.min(count, 1 << 20));
    for (let left = count; left > 0; left -= step.length) {
      if (!(await this.fill(left >= step.length ? step : step.subarray(0, left)))) {
        return false;
      }
      if (left < step.length) {
        break;
      }
    }
    return true;
  }

  cancel(): void {
    void this.reader.cancel().catch(() => undefined);
  }
}

// The NIfTI types this reader knows and their bytes.
const niftiTypes: Readonly<Record<number, { readonly name: string; readonly bytes: number }>> = {
  2: { name: 'uint8', bytes: 1 },
  4: { name: 'int16', bytes: 2 },
  8: { name: 'int32', bytes: 4 },
  16: { name: 'float32', bytes: 4 },
  64: { name: 'float64', bytes: 8 },
  256: { name: 'int8', bytes: 1 },
  512: { name: 'uint16', bytes: 2 },
  768: { name: 'uint32', bytes: 4 },
};

function decode(view: DataView, at: number, type: string, little: boolean): number {
  switch (type) {
    case 'uint8':
      return view.getUint8(at);
    case 'int8':
      return view.getInt8(at);
    case 'int16':
      return view.getInt16(at, little);
    case 'uint16':
      return view.getUint16(at, little);
    case 'int32':
      return view.getInt32(at, little);
    case 'uint32':
      return view.getUint32(at, little);
    case 'float32':
      return view.getFloat32(at, little);
    default:
      return view.getFloat64(at, little);
  }
}

function checkSize(width: number, height: number, depth: number): number {
  if (width < 2 || height < 2 || depth < 2) {
    throw new PointFileError(
      `A volume needs at least 2 values along each axis, the layout says ${String(width)} × ${String(height)} × ${String(depth)}.`,
    );
  }
  const count = width * height * depth;
  if (count > largestCount) {
    throw new PointFileError(`${String(count)} values are more than one list can take.`);
  }
  return count;
}

// Bytes and unsigned 16 bits stay as they are, everything else becomes floating point. A scale from the header turns
// all of them into floating point, as the stored numbers are then no measured values yet.
async function readValues(
  reader: ByteReader,
  size: [number, number, number],
  type: string,
  bytes: number,
  little: boolean,
  scale: [number, number] | undefined,
): Promise<VolumeData> {
  const count = size[0] * size[1] * size[2];
  const chunkValues = Math.max(1, Math.floor((1 << 20) / bytes));
  const buffer = new Uint8Array(chunkValues * bytes);
  const view = new DataView(buffer.buffer);
  const cut = (done: number): PointFileError =>
    new PointFileError(`The file is cut off: it holds ${String(done)} of ${String(count)} values.`);
  if (type === 'uint8' && !scale) {
    const values = new Uint8Array(count);
    if (!(await reader.fill(values))) {
      throw new PointFileError(`The file is cut off: it holds fewer than ${String(count)} values.`);
    }
    return new VolumeData(values, size[0], size[1], size[2]);
  }
  const words = type === 'uint16' && !scale ? new Uint16Array(count) : undefined;
  const floats = words ? undefined : new Float32Array(count);
  for (let done = 0; done < count;) {
    const take = Math.min(count - done, chunkValues);
    if (!(await reader.fill(buffer.subarray(0, take * bytes)))) {
      throw cut(done);
    }
    for (let i = 0; i < take; i++) {
      const value = decode(view, i * bytes, type, little);
      if (words) {
        words[done + i] = value;
      } else {
        (floats as Float32Array)[done + i] = scale ? value * scale[0] + scale[1] : value;
      }
    }
    done += take;
  }
  return new VolumeData(words ?? (floats as Float32Array), size[0], size[1], size[2]);
}

function spacingOf(value: number): number {
  return Number.isFinite(value) && value !== 0 ? Math.abs(value) : 1;
}

async function readNiftiBody(reader: ByteReader, length: number | undefined): Promise<VolumeFileData> {
  const header = new Uint8Array(niftiHeader);
  if (!(await reader.fill(header))) {
    throw new PointFileError('The file is shorter than a NIfTI header.');
  }
  const view = new DataView(header.buffer);
  const size = view.getInt32(0, true);
  const little = size === niftiHeader;
  const swapped = view.getInt32(0, false);
  if (!little && swapped !== niftiHeader) {
    throw new PointFileError(
      size === niftiTwoHeader || swapped === niftiTwoHeader
        ? 'NIfTI-2 files are not supported, only NIfTI-1.'
        : 'This is no NIfTI file: the header does not start with 348.',
    );
  }
  const magic = String.fromCharCode(...header.subarray(344, 347));
  if (magic === 'ni1') {
    throw new PointFileError('A NIfTI pair of .hdr and .img is not supported. Join it into one .nii file.');
  }
  if (magic !== 'n+1') {
    throw new PointFileError("This is no NIfTI-1 file: the mark 'n+1' is missing.");
  }
  const dims = Array.from({ length: 8 }, (_, i) => view.getInt16(40 + 2 * i, little));
  const [rank = 0, width = 0, height = 0, depth = 0] = dims;
  if (rank < 3 || rank > 7 || width < 2 || height < 2 || depth < 2) {
    throw new PointFileError(
      `A volume needs three sizes of at least 2, the header says ${String(rank)} sizes: ${String(width)} × ${String(height)} × ${String(depth)}.`,
    );
  }
  const code = view.getInt16(70, little);
  const kind = niftiTypes[code];
  if (!kind) {
    throw new PointFileError(
      `The NIfTI type ${String(code)} is not supported. Known are 8, 16 and 32 bits and floating point.`,
    );
  }
  const offset = Math.trunc(view.getFloat32(108, little));
  const count = checkSize(width, height, depth);
  if (offset < niftiHeader || (length !== undefined && offset + count * kind.bytes > length)) {
    throw new PointFileError(
      `The file is cut off: the values start at byte ${String(offset)} and need ${String(count * kind.bytes)} bytes.`,
    );
  }
  if (!(await reader.skip(offset - niftiHeader))) {
    throw new PointFileError('The file ends before its values.');
  }
  const slope = view.getFloat32(112, little);
  const intercept = view.getFloat32(116, little);
  const scale: [number, number] | undefined =
    Number.isFinite(slope) && slope !== 0 && (slope !== 1 || intercept !== 0) ? [slope, intercept] : undefined;
  const spacing: [number, number, number] = [
    spacingOf(view.getFloat32(80, little)),
    spacingOf(view.getFloat32(84, little)),
    spacingOf(view.getFloat32(88, little)),
  ];
  const data = await readValues(reader, [width, height, depth], kind.name, kind.bytes, little, scale);
  return new VolumeFileData(data, spacing);
}

/** Reads volumes from raw files and from NIfTI-1 files. */
export interface VolumeFileReaders {
  /**
   * Reads a NIfTI-1 file, packed with gzip or not, which the content tells. Of several volumes in time, the first is
   * read.
   * @throws {@link PointFileError} for a damaged file or one of an unknown kind.
   */
  readNifti(file: Blob): Promise<VolumeFileData>;
  /**
   * Reads a raw volume. The layout comes from the application, as the file has no header.
   * @throws {@link PointFileError} for a file shorter than its layout.
   */
  readRaw(file: Blob, layout: RawVolumeLayout): Promise<VolumeFileData>;
}

/** Reads volumes from raw files and from NIfTI-1, also packed with gzip. */
export const VolumeFile: VolumeFileReaders = {
  async readNifti(file: Blob): Promise<VolumeFileData> {
    const start = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const isPacked = start[0] === 0x1f && start[1] === 0x8b;
    const stream = isPacked ? file.stream().pipeThrough(new DecompressionStream('gzip')) : file.stream();
    const reader = new ByteReader(stream.getReader());
    try {
      return await readNiftiBody(reader, isPacked ? undefined : file.size);
    } catch (error) {
      if (error instanceof PointFileError) {
        throw error;
      }
      throw new PointFileError('The packed file is damaged.', { cause: error });
    } finally {
      reader.cancel();
    }
  },

  async readRaw(file: Blob, layout: RawVolumeLayout): Promise<VolumeFileData> {
    const bytes = layout.type === 'uint8' ? 1 : layout.type === 'float32' ? 4 : 2;
    const count = checkSize(layout.width, layout.height, layout.depth);
    const offset = layout.offset ?? 0;
    if (offset + count * bytes > file.size) {
      throw new PointFileError(
        `The file holds ${String(file.size)} bytes, the layout needs ${String(offset + count * bytes)}.`,
      );
    }
    const spacing = layout.spacing ?? [1, 1, 1];
    if (!spacing.every((value) => Number.isFinite(value) && value > 0)) {
      throw new PointFileError('The spacing must be positive.');
    }
    const reader = new ByteReader(file.slice(offset).stream().getReader());
    try {
      const data = await readValues(
        reader,
        [layout.width, layout.height, layout.depth],
        layout.type,
        bytes,
        !(layout.isBigEndian ?? false),
        undefined,
      );
      return new VolumeFileData(data, [spacing[0], spacing[1], spacing[2]]);
    } finally {
      reader.cancel();
    }
  },
};
