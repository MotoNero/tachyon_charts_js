// Reads binary DICOM segmentation objects (DICOM-SEG), as DicomSegReader of the .NET version: one bit per pixel and
// frame, each frame a plane of one segment, stacked along the normal into one map of labels. Only the tags of the
// segments and their geometry are kept; everything else, such as data about the patient, is skipped.
import { Point3D, VolumeData } from '@tachyon-charts/3d';
import type { Rgba8 } from '@tachyon-charts/core';
import { DicomReadError, type DicomTransferSyntax } from './dicom';
import { PatientOrientation } from './medical-image';
import { MedicalSegment, MedicalSegmentation, type MedicalSegmentation3DMode } from './segmentation';

const undefinedLength = 0xffffffff;
const tag = {
  transferSyntax: 0x00020010,
  modality: 0x00080060,
  numberOfFrames: 0x00280008,
  rows: 0x00280010,
  columns: 0x00280011,
  pixelSpacing: 0x00280030,
  bitsAllocated: 0x00280100,
  pixelData: 0x7fe00010,
  segmentationType: 0x00620001,
  segmentSequence: 0x00620002,
  segmentNumber: 0x00620004,
  segmentLabel: 0x00620005,
  segmentIdentification: 0x0062000a,
  referencedSegmentNumber: 0x0062000b,
  recommendedColor: 0x0062000d,
  sharedGroups: 0x52009229,
  perFrameGroups: 0x52009230,
  pixelMeasures: 0x00289110,
  planePosition: 0x00209113,
  planeOrientation: 0x00209116,
  imagePosition: 0x00200032,
  imageOrientation: 0x00200037,
  sliceThickness: 0x00180050,
  spacingBetweenSlices: 0x00180088,
} as const;

const sequences = new Set<number>([
  tag.segmentSequence,
  tag.sharedGroups,
  tag.perFrameGroups,
  tag.pixelMeasures,
  tag.planePosition,
  tag.planeOrientation,
  tag.segmentIdentification,
]);
const kept = new Set<number>([
  tag.modality,
  tag.numberOfFrames,
  tag.rows,
  tag.columns,
  tag.pixelSpacing,
  tag.bitsAllocated,
  tag.pixelData,
  tag.segmentationType,
  tag.segmentNumber,
  tag.segmentLabel,
  tag.referencedSegmentNumber,
  tag.recommendedColor,
  tag.imagePosition,
  tag.imageOrientation,
  tag.sliceThickness,
  tag.spacingBetweenSlices,
]);
const longLengths = new Set([0x4f42, 0x4f44, 0x4f46, 0x4f4c, 0x4f56, 0x4f57, 0x5351, 0x5543, 0x554e, 0x5552, 0x5554]);
const ascii = new TextDecoder('ascii');

function broken(): DicomReadError {
  return new DicomReadError('The DICOM-SEG data set is truncated or malformed.');
}

class Reader {
  at = 0;
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  word(little: boolean): number {
    if (this.at + 2 > this.bytes.length) {
      throw broken();
    }
    const value = this.view.getUint16(this.at, little);
    this.at += 2;
    return value;
  }

  long(little: boolean): number {
    if (this.at + 4 > this.bytes.length) {
      throw broken();
    }
    const value = this.view.getUint32(this.at, little);
    this.at += 4;
    return value;
  }

  take(count: number): Uint8Array {
    if (count === undefinedLength || this.at + count > this.bytes.length) {
      throw broken();
    }
    const part = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return part;
  }

  header(syntax: DicomTransferSyntax): { group: number; element: number; vr: number; length: number; tag: number } {
    const little = syntax !== 'explicitVrBigEndian';
    const group = this.word(little);
    const element = this.word(little);
    const tagOf = ((group << 16) | element) >>> 0;
    if (group === 0xfffe || syntax === 'implicitVrLittleEndian') {
      return { group, element, vr: 0, length: this.long(little), tag: tagOf };
    }
    const pair = this.take(2);
    const vr = ((pair[0] as number) << 8) | (pair[1] as number);
    if (!longLengths.has(vr)) {
      return { group, element, vr, length: this.word(little), tag: tagOf };
    }
    this.take(2);
    return { group, element, vr, length: this.long(little), tag: tagOf };
  }
}

// The kept elements of a data set and its sequences of items.
class Dataset {
  private readonly values = new Map<number, Uint8Array>();
  private readonly lists = new Map<number, Dataset[]>();

  static parse(reader: Reader, syntax: DicomTransferSyntax, end: number, delimiter: number): Dataset {
    const data = new Dataset();
    while (reader.at < end) {
      const header = reader.header(syntax);
      if (header.group === 0xfffe && header.element === delimiter) {
        reader.take(header.length);
        break;
      }
      if (header.group === 0xfffe) {
        throw new DicomReadError('The DICOM-SEG sequence structure is invalid.');
      }
      if (header.vr === 0x5351 || sequences.has(header.tag)) {
        data.lists.set(header.tag, Dataset.items(reader, syntax, header.length));
      } else if (kept.has(header.tag)) {
        if (header.length === undefinedLength) {
          throw new DicomReadError('A required DICOM-SEG value has an invalid length.');
        }
        data.values.set(header.tag, reader.take(header.length));
      } else {
        reader.take(header.length);
      }
    }
    return data;
  }

  private static items(reader: Reader, syntax: DicomTransferSyntax, length: number): Dataset[] {
    const items: Dataset[] = [];
    const end = length === undefinedLength ? Number.MAX_SAFE_INTEGER : reader.at + length;
    while (reader.at < end) {
      const item = reader.header(syntax);
      if (item.group === 0xfffe && item.element === 0xe0dd) {
        reader.take(item.length);
        break;
      }
      if (item.group !== 0xfffe || item.element !== 0xe000) {
        throw new DicomReadError('A DICOM-SEG sequence item is invalid.');
      }
      items.push(
        Dataset.parse(
          reader,
          syntax,
          item.length === undefinedLength ? Number.MAX_SAFE_INTEGER : reader.at + item.length,
          0xe00d,
        ),
      );
    }
    return items;
  }

  bytes(of: number): Uint8Array {
    const value = this.values.get(of);
    if (!value) {
      throw new DicomReadError('A required DICOM-SEG tag is missing.');
    }
    return value;
  }

  optionalBytes(of: number): Uint8Array | undefined {
    return this.values.get(of);
  }

  text(of: number): string {
    return ascii.decode(this.bytes(of)).replace(/[\0 ]+$/u, '');
  }

  optionalText(of: number): string | undefined {
    const value = this.values.get(of);
    return value ? ascii.decode(value).replace(/[\0 ]+$/u, '') : undefined;
  }

  items(of: number): readonly Dataset[] {
    return this.lists.get(of) ?? [];
  }

  number(of: number, syntax: DicomTransferSyntax): number {
    const bytes = this.bytes(of);
    if (bytes.length !== 2) {
      throw new DicomReadError('A required numeric DICOM-SEG tag has an invalid length.');
    }
    return new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, syntax !== 'explicitVrBigEndian');
  }
}

function decimals(text: string, count: number, name: string): number[] {
  const parts = text.split('\\');
  if (parts.length < count) {
    throw new DicomReadError(`The ${name} is incomplete.`);
  }
  return parts.slice(0, count).map((part) => {
    const trimmed = part.trim();
    const value = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new DicomReadError(`The ${name} is invalid.`);
    }
    return value;
  });
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-5;

function single(items: readonly Dataset[]): Dataset | undefined {
  return items.length === 1 ? items[0] : undefined;
}

function nested(shared: Dataset, frame: Dataset, of: number): Dataset {
  const own = frame.items(of);
  const found = single(own.length > 0 ? own : shared.items(of));
  if (!found) {
    throw new DicomReadError('A required DICOM-SEG functional group is missing.');
  }
  return found;
}

// The recommended colour in CIELab, scaled to 16 bits, to sRGB as the .NET version turns it.
function labToRgb(l: number, a: number, b: number): Rgba8 {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const pivot = (value: number): number => (value ** 3 > 0.008856 ? value ** 3 : (value - 16 / 116) / 7.787);
  const x = 0.95047 * pivot(fx);
  const y = pivot(fy);
  const z = 1.08883 * pivot(fz);
  const gamma = (value: number): number => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
  const channel = (value: number): number => {
    const scaled = Math.min(Math.max(gamma(value), 0), 1) * 255;
    const floor = Math.floor(scaled);
    return scaled - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled);
  };
  return {
    r: channel(3.2406 * x - 1.5372 * y - 0.4986 * z),
    g: channel(-0.9689 * x + 1.8758 * y + 0.0415 * z),
    b: channel(0.0557 * x - 0.204 * y + 1.057 * z),
    a: 255,
  };
}

const fallbackColors: readonly Rgba8[] = [
  { r: 230, g: 75, b: 90, a: 255 },
  { r: 55, g: 180, b: 110, a: 255 },
  { r: 60, g: 130, b: 235, a: 255 },
  { r: 245, g: 175, b: 55, a: 255 },
];

function readSyntax(reader: Reader): DicomTransferSyntax {
  let uid: string | undefined;
  for (;;) {
    const at = reader.at;
    const header = reader.header('explicitVrLittleEndian');
    if (header.group !== 2) {
      reader.at = at;
      break;
    }
    const value = reader.take(header.length);
    if (header.tag === tag.transferSyntax) {
      uid = ascii.decode(value).replace(/[\0 ]+$/u, '');
    }
  }
  switch (uid) {
    case '1.2.840.10008.1.2':
      return 'implicitVrLittleEndian';
    case '1.2.840.10008.1.2.1':
      return 'explicitVrLittleEndian';
    case '1.2.840.10008.1.2.2':
      return 'explicitVrBigEndian';
    default:
      throw new DicomReadError('The DICOM-SEG transfer syntax is compressed or unsupported.');
  }
}

function readSegmentation(bytes: Uint8Array, threeDMode: MedicalSegmentation3DMode): MedicalSegmentation {
  if (bytes.length < 132 || ascii.decode(bytes.subarray(128, 132)) !== 'DICM') {
    throw new DicomReadError('The DICOM Part 10 marker is missing.');
  }
  const reader = new Reader(bytes);
  reader.at = 132;
  const syntax = readSyntax(reader);
  const root = Dataset.parse(reader, syntax, bytes.length, 0);
  if (root.optionalText(tag.modality) !== 'SEG') {
    throw new DicomReadError('The DICOM object is not a segmentation.');
  }
  if (root.optionalText(tag.segmentationType) !== 'BINARY') {
    throw new DicomReadError(
      'Only binary DICOM-SEG objects are supported; fractional segmentation is not losslessly categorical.',
    );
  }
  if (root.number(tag.bitsAllocated, syntax) !== 1) {
    throw new DicomReadError('A binary DICOM-SEG object must allocate one bit per pixel.');
  }
  const rows = root.number(tag.rows, syntax);
  const columns = root.number(tag.columns, syntax);
  const countText = root.text(tag.numberOfFrames);
  const frameCount = /^\d+$/u.test(countText) ? Number(countText) : 0;
  if (!(frameCount > 0)) {
    throw new DicomReadError('The frame count is invalid.');
  }
  const frames = root.items(tag.perFrameGroups);
  if (frames.length !== frameCount) {
    throw new DicomReadError('The per-frame geometry does not match the frame count.');
  }
  const shared = single(root.items(tag.sharedGroups));
  if (!shared) {
    throw new DicomReadError('The shared functional groups are missing.');
  }
  const measures = single(shared.items(tag.pixelMeasures));
  if (!measures) {
    throw new DicomReadError('The pixel measures are missing.');
  }
  const spacing = decimals(measures.text(tag.pixelSpacing), 2, 'pixel spacing');
  if (!((spacing[0] as number) > 0 && (spacing[1] as number) > 0)) {
    throw new DicomReadError('The pixel spacing must be positive.');
  }
  const orientationValues = decimals(
    nested(shared, frames[0] as Dataset, tag.planeOrientation).text(tag.imageOrientation),
    6,
    'image orientation',
  );
  const v = orientationValues as [number, number, number, number, number, number];
  const raw = new PatientOrientation(new Point3D(v[0], v[1], v[2]), new Point3D(v[3], v[4], v[5]));
  if (raw.across.length < 0.5 || raw.down.length < 0.5 || Point3D.cross(raw.across, raw.down).length < 0.5) {
    throw new DicomReadError('The image orientation is invalid.');
  }
  const orientation = new PatientOrientation(raw.across.normalized(), raw.down.normalized());
  const normal = orientation.normal;

  const definitions = new Map<number, MedicalSegment>();
  for (const item of root.items(tag.segmentSequence)) {
    const number = item.number(tag.segmentNumber, syntax);
    if (number === 0 || definitions.has(number)) {
      throw new DicomReadError('Segment numbers must be unique and positive.');
    }
    const color = item.optionalBytes(tag.recommendedColor);
    let rgb: Rgba8;
    if (color?.length === 6) {
      const view = new DataView(color.buffer, color.byteOffset, 6);
      const little = syntax !== 'explicitVrBigEndian';
      rgb = labToRgb(
        (view.getUint16(0, little) * 100) / 65535,
        ((view.getUint16(2, little) - 32768) * 255) / 65535,
        ((view.getUint16(4, little) - 32768) * 255) / 65535,
      );
    } else {
      rgb = fallbackColors[(number - 1) % fallbackColors.length] as Rgba8;
    }
    definitions.set(number, new MedicalSegment(number, item.optionalText(tag.segmentLabel) ?? '', rgb));
  }
  if (definitions.size === 0) {
    throw new DicomReadError('The segment sequence is empty.');
  }

  const planes: { along: number; position: Point3D }[] = [];
  const info = frames.map((frame) => {
    const p = decimals(nested(shared, frame, tag.planePosition).text(tag.imagePosition), 3, 'image position');
    const position = new Point3D(p[0] as number, p[1] as number, p[2] as number);
    const segment = nested(shared, frame, tag.segmentIdentification).number(tag.referencedSegmentNumber, syntax);
    if (!definitions.has(segment)) {
      throw new DicomReadError('A frame references an undefined segment.');
    }
    const along = Point3D.dot(position, normal);
    if (!planes.some((plane) => near(plane.along, along))) {
      planes.push({ along, position });
    }
    return { segment, along };
  });
  planes.sort((a, b) => a.along - b.along);
  let sliceSpacing: number;
  if (planes.length < 2) {
    const text = measures.optionalText(tag.spacingBetweenSlices) ?? measures.optionalText(tag.sliceThickness);
    sliceSpacing = text === undefined ? 1 : (decimals(text, 1, 'slice spacing')[0] as number);
    if (!(sliceSpacing > 0)) {
      throw new DicomReadError('The slice spacing must be positive.');
    }
  } else {
    sliceSpacing = (planes[1] as { along: number }).along - (planes[0] as { along: number }).along;
    for (let i = 2; i < planes.length; i++) {
      if (!near((planes[i] as { along: number }).along - (planes[i - 1] as { along: number }).along, sliceSpacing)) {
        throw new DicomReadError('The DICOM-SEG slices are not regularly spaced.');
      }
    }
  }
  const size = rows * columns;
  const labels = new Uint16Array(size * planes.length);
  const pixels = root.bytes(tag.pixelData);
  const bytesPerFrame = Math.ceil(size / 8);
  if (pixels.length < bytesPerFrame * frameCount) {
    throw new DicomReadError('The binary pixel data is shorter than the declared frames.');
  }
  info.forEach((frame, index) => {
    const z = planes.findIndex((plane) => near(plane.along, frame.along));
    const bits = pixels.subarray(index * bytesPerFrame, (index + 1) * bytesPerFrame);
    const first = z * size;
    for (let pixel = 0; pixel < size; pixel++) {
      if (((bits[pixel >> 3] as number) & (1 << (pixel & 7))) === 0) {
        continue;
      }
      const at = first + pixel;
      const label = labels[at] as number;
      if (label !== 0 && label !== frame.segment) {
        throw new DicomReadError('Overlapping DICOM-SEG segments cannot be represented by one integer label map.');
      }
      labels[at] = frame.segment;
    }
  });
  return new MedicalSegmentation(
    new VolumeData(labels, columns, rows, planes.length),
    { row: spacing[0] as number, column: spacing[1] as number },
    sliceSpacing,
    (planes[0] as { position: Point3D }).position,
    orientation,
    [...definitions.values()],
    threeDMode,
  );
}

/** Reads binary DICOM segmentation objects (DICOM-SEG) into a map of labels. */
export const DicomSegReader = {
  /**
   * Reads a segmentation from the bytes of a DICOM-SEG file.
   * @param threeDMode - How the segmentation shows in 3D.
   * @throws DicomReadError when the file is no binary DICOM-SEG object, its segments overlap, or it is damaged.
   */
  read(bytes: Uint8Array | ArrayBuffer, threeDMode: MedicalSegmentation3DMode = 'volume'): MedicalSegmentation {
    try {
      return readSegmentation(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), threeDMode);
    } catch (error) {
      if (error instanceof DicomReadError) {
        throw error;
      }
      throw new DicomReadError('The DICOM-SEG data set is truncated or malformed.');
    }
  },

  /**
   * Reads a segmentation from a file, such as one a person drops on the page.
   * @throws DicomReadError when the file is no binary DICOM-SEG object, its segments overlap, or it is damaged.
   */
  async readFile(file: Blob, threeDMode: MedicalSegmentation3DMode = 'volume'): Promise<MedicalSegmentation> {
    return DicomSegReader.read(new Uint8Array(await file.arrayBuffer()), threeDMode);
  },
};
