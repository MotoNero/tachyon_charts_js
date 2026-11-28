// Reads volumes of single NIfTI-1 files, packed or not, as NiftiImageReader of the .NET version: the values with their
// scale, and the geometry from the sform or qform turned from RAS into the LPS of DICOM, slices in the order of the
// normal.
import { Point3D, VolumeData } from '@tachyon-charts/3d';
import { MedicalVolume, PatientOrientation } from './medical-image';
import { MedicalSegmentation, type MedicalSegment, type MedicalSegmentation3DMode } from './segmentation';

/** A NIfTI file that cannot be read. */
export class NiftiReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NiftiReadError';
  }
}

const headerSize = 348;

interface Row {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

interface Header {
  readonly little: boolean;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly type: number;
  readonly bytes: number;
  readonly slope: number;
  readonly intercept: number;
  readonly affine: readonly [Row, Row, Row];
  readonly offset: number;
}

function positive(value: number, name: string): number {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new NiftiReadError(`The NIfTI ${name} must be finite and positive.`);
  }
  return value;
}

function bytesPerValue(type: number): number {
  switch (type) {
    case 2:
    case 256:
      return 1;
    case 4:
    case 512:
      return 2;
    case 8:
    case 768:
    case 16:
      return 4;
    case 64:
      return 8;
    default:
      throw new NiftiReadError(
        'Only 8-, 16- and 32-bit integers and 32- and 64-bit floats are supported in NIfTI files.',
      );
  }
}

function readHeader(bytes: Uint8Array): Header {
  if (bytes.length < headerSize) {
    throw new NiftiReadError('The NIfTI file is truncated or malformed.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = view.getInt32(0, true) === headerSize;
  if (!little && view.getInt32(0, false) !== headerSize) {
    throw new NiftiReadError('The stream is not a NIfTI-1 file.');
  }
  if (bytes[344] !== 0x6e || bytes[345] !== 0x2b || bytes[346] !== 0x31) {
    throw new NiftiReadError('Only single-file NIfTI-1 files are supported.');
  }
  const int16 = (at: number): number => view.getInt16(at, little);
  const single = (at: number): number => view.getFloat32(at, little);
  const dimensions = int16(40);
  if (dimensions < 3 || dimensions > 7) {
    throw new NiftiReadError('A NIfTI volume needs three dimensions.');
  }
  const width = positive(int16(42), 'width');
  const height = positive(int16(44), 'height');
  const depth = positive(int16(46), 'depth');
  for (let axis = 4; axis <= dimensions; axis++) {
    if (int16(40 + axis * 2) !== 1) {
      throw new NiftiReadError('A NIfTI file must contain one three-dimensional volume.');
    }
  }
  const type = int16(70);
  const size = bytesPerValue(type);
  const offset = Math.ceil(single(108));
  if (!(offset >= headerSize)) {
    throw new NiftiReadError('The NIfTI voxel offset is invalid.');
  }
  let slope = single(112);
  const intercept = single(116);
  if (slope === 0) {
    slope = 1;
  }
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    throw new NiftiReadError('The NIfTI scaling is not finite.');
  }
  return {
    little,
    width,
    height,
    depth,
    type,
    bytes: size,
    slope,
    intercept,
    affine: readAffine(view, little),
    offset,
  };
}

function readAffine(view: DataView, little: boolean): readonly [Row, Row, Row] {
  const int16 = (at: number): number => view.getInt16(at, little);
  const single = (at: number): number => view.getFloat32(at, little);
  const row = (at: number): Row => ({ x: single(at), y: single(at + 4), z: single(at + 8), w: single(at + 12) });
  if (int16(254) > 0) {
    return [row(280), row(296), row(312)];
  }
  if (int16(252) <= 0) {
    throw new NiftiReadError('The NIfTI file has neither an sform nor a qform transform.');
  }
  const b = single(256);
  const c = single(260);
  const d = single(264);
  const square = 1 - b * b - c * c - d * d;
  if (square < -1e-6) {
    throw new NiftiReadError('The NIfTI qform quaternion is invalid.');
  }
  const a = Math.sqrt(Math.max(0, square));
  const dx = positive(Math.abs(single(80)), 'column spacing');
  const dy = positive(Math.abs(single(84)), 'row spacing');
  const dz = positive(Math.abs(single(88)), 'slice spacing') * (single(76) < 0 ? -1 : 1);
  const scaled = (x: number, y: number, z: number, w: number): Row => ({ x: x * dx, y: y * dy, z: z * dz, w });
  return [
    scaled(a * a + b * b - c * c - d * d, 2 * (b * c + a * d), 2 * (b * d - a * c), single(268)),
    scaled(2 * (b * c - a * d), a * a + c * c - b * b - d * d, 2 * (c * d + a * b), single(272)),
    scaled(2 * (b * d + a * c), 2 * (c * d - a * b), a * a + d * d - c * c - b * b, single(276)),
  ];
}

function stored(view: DataView, at: number, type: number, little: boolean): number {
  switch (type) {
    case 2:
      return view.getUint8(at);
    case 256:
      return view.getInt8(at);
    case 4:
      return view.getInt16(at, little);
    case 512:
      return view.getUint16(at, little);
    case 8:
      return view.getInt32(at, little);
    case 768:
      return view.getUint32(at, little);
    case 16:
      return view.getFloat32(at, little);
    default:
      return view.getFloat64(at, little);
  }
}

// RAS of NIfTI to LPS of DICOM.
const toLps = (x: number, y: number, z: number): Point3D => new Point3D(-x, -y, z);

function reverseSlices(values: Uint16Array | Float32Array, width: number, height: number, depth: number): void {
  const slice = width * height;
  for (let first = 0; first < Math.floor(depth / 2); first++) {
    const last = depth - 1 - first;
    for (let i = 0; i < slice; i++) {
      const kept = values[first * slice + i] as number;
      values[first * slice + i] = values[last * slice + i] as number;
      values[last * slice + i] = kept;
    }
  }
}

async function unpacked(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return bytes;
  }
  try {
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new NiftiReadError('The NIfTI file is truncated or malformed.');
  }
}

function readVolume(bytes: Uint8Array, asLabels = false): MedicalVolume {
  const header = readHeader(bytes);
  const { width, height, depth } = header;
  const count = width * height * depth;
  if (header.offset + count * header.bytes > bytes.length) {
    throw new NiftiReadError('The NIfTI file is truncated or malformed.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + header.offset, count * header.bytes);
  const [ax, ay, az] = header.affine;
  let across = toLps(ax.x, ay.x, az.x);
  let down = toLps(ax.y, ay.y, az.y);
  let slices = toLps(ax.z, ay.z, az.z);
  let origin = toLps(ax.w, ay.w, az.w);
  const columnSpacing = across.length;
  const rowSpacing = down.length;
  const sliceSpacing = slices.length;
  if (!(columnSpacing > 0 && rowSpacing > 0 && sliceSpacing > 0)) {
    throw new NiftiReadError('The NIfTI affine has a zero-length voxel axis.');
  }
  across = across.normalized();
  down = down.normalized();
  slices = slices.normalized();
  if (
    Math.abs(Point3D.dot(across, down)) > 1e-5 ||
    Math.abs(Point3D.dot(across, slices)) > 1e-5 ||
    Math.abs(Point3D.dot(down, slices)) > 1e-5
  ) {
    throw new NiftiReadError('Sheared NIfTI volumes are not supported.');
  }
  const reversed = Point3D.dot(Point3D.cross(across, down).normalized(), slices) < 0;
  if (reversed) {
    origin = origin.plus(slices.times((depth - 1) * sliceSpacing));
  }
  let data: VolumeData;
  if (asLabels) {
    if (header.type === 16 || header.type === 64) {
      throw new NiftiReadError('The NIfTI datatype is not an integer label type.');
    }
    const labels = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      const value = stored(view, i * header.bytes, header.type, header.little) * header.slope + header.intercept;
      if (!(Number.isFinite(value) && value >= 0 && value <= 65535 && value === Math.trunc(value))) {
        throw new NiftiReadError('The scaled NIfTI values are not integer labels from zero through 65,535.');
      }
      labels[i] = value;
    }
    if (reversed) {
      reverseSlices(labels, width, height, depth);
    }
    data = new VolumeData(labels, width, height, depth);
  } else if (header.type === 2 || header.type === 256 || header.type === 4 || header.type === 512) {
    // Integers of up to 16 bits stay two bytes each with their scale; signed ones move up by 32768.
    const lift = header.type === 256 || header.type === 4 ? 32768 : 0;
    const words = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      words[i] = stored(view, i * header.bytes, header.type, header.little) + lift;
    }
    if (reversed) {
      reverseSlices(words, width, height, depth);
    }
    data = new VolumeData(words, width, height, depth, header.slope, header.intercept - lift * header.slope);
  } else {
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = stored(view, i * header.bytes, header.type, header.little) * header.slope + header.intercept;
    }
    if (reversed) {
      reverseSlices(values, width, height, depth);
    }
    data = new VolumeData(values, width, height, depth);
  }
  return new MedicalVolume(
    data,
    { row: rowSpacing, column: columnSpacing },
    sliceSpacing,
    origin,
    new PatientOrientation(across, down),
  );
}

/** Reads volumes of single NIfTI-1 files, `.nii` or `.nii.gz`. */
export const NiftiImageReader = {
  /**
   * Reads a volume from the bytes of a file, packed with gzip or not.
   * @throws NiftiReadError when the file is no single NIfTI-1 file of one volume or is damaged.
   */
  async read(bytes: Uint8Array | ArrayBuffer): Promise<MedicalVolume> {
    return readVolume(await unpacked(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  },

  /**
   * Reads a volume from a file, such as one a person drops on the page.
   * @throws NiftiReadError when the file is no single NIfTI-1 file of one volume or is damaged.
   */
  async readFile(file: Blob): Promise<MedicalVolume> {
    return NiftiImageReader.read(new Uint8Array(await file.arrayBuffer()));
  },
};

/** Reads segmentations of single NIfTI-1 files: whole numbers from 0 (none) to 65 535, each a label. */
export const NiftiSegmentationReader = {
  /**
   * Reads the labels of a file, packed with gzip or not, with their geometry in the patient.
   * @param segments - Descriptions of labels; the others get a name and a colour.
   * @param threeDMode - How the segmentation shows in 3D.
   * @throws NiftiReadError when the file is no NIfTI-1 file of whole-numbered labels or is damaged.
   */
  async read(
    bytes: Uint8Array | ArrayBuffer,
    segments: readonly MedicalSegment[] = [],
    threeDMode: MedicalSegmentation3DMode = 'volume',
  ): Promise<MedicalSegmentation> {
    const volume = readVolume(await unpacked(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)), true);
    const spacing = volume.voxelSpacing;
    return new MedicalSegmentation(
      volume.data,
      { row: spacing.y, column: spacing.x },
      spacing.z,
      volume.origin,
      volume.orientation,
      segments,
      threeDMode,
    );
  },

  /**
   * Reads the labels of a file, such as one a person drops on the page.
   * @throws NiftiReadError when the file is no NIfTI-1 file of whole-numbered labels or is damaged.
   */
  async readFile(
    file: Blob,
    segments: readonly MedicalSegment[] = [],
    threeDMode: MedicalSegmentation3DMode = 'volume',
  ): Promise<MedicalSegmentation> {
    return NiftiSegmentationReader.read(new Uint8Array(await file.arrayBuffer()), segments, threeDMode);
  },
};
