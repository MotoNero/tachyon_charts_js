// Reads uncompressed DICOM images and series of them, as DicomReader and DicomSeriesReader of the .NET version. Only
// the values of the image and its geometry are kept; every other tag, such as data about the patient, is skipped.
import { Point3D, VolumeData } from '@tachyon-charts/3d';
import { MedicalVolume, PatientOrientation, type ImageSpacing } from './medical-image';

/** A DICOM file that cannot be read. */
export class DicomReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DicomReadError';
  }
}

/** How the values of a DICOM file are stored. */
export type DicomTransferSyntax = 'implicitVrLittleEndian' | 'explicitVrLittleEndian' | 'explicitVrBigEndian';

/** Whether the lowest value of a monochrome image is black (2) or white (1). */
export type DicomPhotometricInterpretation = 'monochrome2' | 'monochrome1';

type Pixels =
  | { readonly kind: 'byte'; readonly values: Uint8Array }
  | { readonly kind: 'word'; readonly values: Uint16Array; readonly slope: number; readonly intercept: number }
  | { readonly kind: 'float'; readonly values: Float32Array };

interface Metadata {
  width: number;
  height: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  isSigned: boolean;
  samplesPerPixel: number;
  numberOfFrames: number;
  transferSyntax: DicomTransferSyntax;
  photometricInterpretation: DicomPhotometricInterpretation;
  spacing?: ImageSpacing;
  position?: Point3D;
  orientation?: PatientOrientation;
  sliceThickness?: number;
  spacingBetweenSlices?: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  windowCenter?: number;
  windowWidth?: number;
  modality?: string;
  seriesInstanceUid?: string;
}

// The stored values of each image, kept beside it so that they stay out of its public form.
const storedPixels = new WeakMap<MedicalImage, Pixels>();
let createImage: (metadata: Metadata, pixels: Pixels) => MedicalImage;

function pixelsOf(image: MedicalImage): Pixels {
  return storedPixels.get(image) as Pixels;
}

/** An image of a DICOM file: its values, their scale and its geometry, without data about the patient. */
export class MedicalImage {
  /** The columns. */
  readonly width: number;
  /** The rows. */
  readonly height: number;
  /** The bits of a stored value: 8 or 16. */
  readonly bitsAllocated: number;
  /** Whether stored values have a sign. */
  readonly isSigned: boolean;
  /** How the values were stored. */
  readonly transferSyntax: DicomTransferSyntax;
  /** Whether the lowest value is black or white. */
  readonly photometricInterpretation: DicomPhotometricInterpretation;
  /** The spacing of the pixels in millimetres, if given. */
  readonly spacing: ImageSpacing | undefined;
  /** The place of the first pixel in the patient in millimetres, if given. */
  readonly position: Point3D | undefined;
  /** The directions of the image in the patient, if given. */
  readonly orientation: PatientOrientation | undefined;
  /** The thickness of the slice in millimetres, if given. */
  readonly sliceThickness: number | undefined;
  /** The distance to the next slice in millimetres, if given. */
  readonly spacingBetweenSlices: number | undefined;
  /** The factor from stored values to real ones. */
  readonly rescaleSlope: number;
  /** The offset from stored values to real ones. */
  readonly rescaleIntercept: number;
  /** The centre of the window the file suggests, if any. */
  readonly windowCenter: number | undefined;
  /** The width of the window the file suggests, if any. */
  readonly windowWidth: number | undefined;
  /** The kind of scanner, such as CT, if given. */
  readonly modality: string | undefined;
  /** @internal The series the image belongs to. */
  readonly seriesInstanceUid: string | undefined;

  static {
    createImage = (metadata, pixels) => new MedicalImage(metadata, pixels);
  }

  private constructor(metadata: Metadata, pixels: Pixels) {
    this.width = metadata.width;
    this.height = metadata.height;
    this.bitsAllocated = metadata.bitsAllocated;
    this.isSigned = metadata.isSigned;
    this.transferSyntax = metadata.transferSyntax;
    this.photometricInterpretation = metadata.photometricInterpretation;
    this.spacing = metadata.spacing;
    this.position = metadata.position;
    this.orientation = metadata.orientation;
    this.sliceThickness = metadata.sliceThickness;
    this.spacingBetweenSlices = metadata.spacingBetweenSlices;
    this.rescaleSlope = metadata.rescaleSlope;
    this.rescaleIntercept = metadata.rescaleIntercept;
    this.windowCenter = metadata.windowCenter;
    this.windowWidth = metadata.windowWidth;
    this.modality = metadata.modality;
    this.seriesInstanceUid = metadata.seriesInstanceUid;
    storedPixels.set(this, pixels);
  }

  /**
   * The real value of a pixel, its scale applied.
   * @throws RangeError outside the image.
   */
  at(column: number, row: number): number {
    if (!(column >= 0 && column < this.width && row >= 0 && row < this.height)) {
      throw new RangeError('The pixel lies outside the image.');
    }
    return valueOf(pixelsOf(this), row * this.width + column);
  }

  /** The real values, row after row from the top. */
  values(): Float32Array {
    const pixels = pixelsOf(this);
    if (pixels.kind === 'float') {
      return pixels.values.slice();
    }
    const values = new Float32Array(pixels.values.length);
    for (let i = 0; i < values.length; i++) {
      values[i] = valueOf(pixels, i);
    }
    return values;
  }
}

function valueOf(pixels: Pixels, index: number): number {
  const stored = pixels.values[index] as number;
  return pixels.kind === 'word' ? stored * pixels.slope + pixels.intercept : stored;
}

const implicitLittle = '1.2.840.10008.1.2';
const explicitLittle = '1.2.840.10008.1.2.1';
const explicitBig = '1.2.840.10008.1.2.2';
const undefinedLength = 0xffffffff;
const tags = {
  transferSyntax: 0x00020010,
  modality: 0x00080060,
  sliceThickness: 0x00180050,
  spacingBetweenSlices: 0x00180088,
  seriesInstanceUid: 0x0020000e,
  imagePosition: 0x00200032,
  imageOrientation: 0x00200037,
  samplesPerPixel: 0x00280002,
  photometric: 0x00280004,
  numberOfFrames: 0x00280008,
  rows: 0x00280010,
  columns: 0x00280011,
  pixelSpacing: 0x00280030,
  windowCenter: 0x00281050,
  windowWidth: 0x00281051,
  rescaleIntercept: 0x00281052,
  rescaleSlope: 0x00281053,
  bitsAllocated: 0x00280100,
  bitsStored: 0x00280101,
  highBit: 0x00280102,
  pixelRepresentation: 0x00280103,
  pixelData: 0x7fe00010,
} as const;

interface Header {
  readonly group: number;
  readonly element: number;
  readonly vr: number;
  readonly length: number;
}

class Cursor {
  at = 0;
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get left(): number {
    return this.bytes.length - this.at;
  }

  take(count: number): Uint8Array {
    if (count > this.left) {
      throw new DicomReadError('The DICOM data set is truncated or malformed.');
    }
    const part = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return part;
  }

  skip(count: number): void {
    this.take(count);
  }

  word(little: boolean): number {
    if (this.left < 2) {
      throw new DicomReadError('The DICOM data set is truncated or malformed.');
    }
    const value = this.view.getUint16(this.at, little);
    this.at += 2;
    return value;
  }

  long(little: boolean): number {
    if (this.left < 4) {
      throw new DicomReadError('The DICOM data set is truncated or malformed.');
    }
    const value = this.view.getUint32(this.at, little);
    this.at += 4;
    return value;
  }
}

const longLengths = new Set([0x4f42, 0x4f44, 0x4f46, 0x4f4c, 0x4f56, 0x4f57, 0x5351, 0x5543, 0x554e, 0x5552, 0x5554]);

function readHeader(cursor: Cursor, syntax: DicomTransferSyntax): Header {
  const little = syntax !== 'explicitVrBigEndian';
  const group = cursor.word(little);
  const element = cursor.word(little);
  if (group === 0xfffe || syntax === 'implicitVrLittleEndian') {
    return { group, element, vr: 0, length: cursor.long(little) };
  }
  const pair = cursor.take(2);
  const vr = ((pair[0] as number) << 8) | (pair[1] as number);
  if (!longLengths.has(vr)) {
    return { group, element, vr, length: cursor.word(little) };
  }
  cursor.skip(2);
  return { group, element, vr, length: cursor.long(little) };
}

function tagOf(header: Header): number {
  return ((header.group << 16) | header.element) >>> 0;
}

function skipValue(cursor: Cursor, header: Header, syntax: DicomTransferSyntax): void {
  if (header.length !== undefinedLength) {
    cursor.skip(header.length);
    return;
  }
  skipContainer(cursor, syntax, 0xe0dd);
}

function skipContainer(cursor: Cursor, syntax: DicomTransferSyntax, delimiter: number): void {
  for (;;) {
    const header = readHeader(cursor, syntax);
    if (header.group === 0xfffe && header.element === delimiter) {
      cursor.skip(header.length);
      return;
    }
    if (header.group === 0xfffe && header.element === 0xe000 && header.length === undefinedLength) {
      skipContainer(cursor, syntax, 0xe00d);
    } else if (header.length === undefinedLength) {
      skipContainer(cursor, syntax, 0xe0dd);
    } else {
      cursor.skip(header.length);
    }
  }
}

const ascii = new TextDecoder('ascii');

function readText(cursor: Cursor, length: number, maximum: number): string {
  if (length === undefinedLength || length > maximum) {
    throw new DicomReadError('A required image tag has an invalid length.');
  }
  return ascii.decode(cursor.take(length)).replace(/[\0 ]+$/u, '');
}

function readDecimals(cursor: Cursor, length: number, count: number, name: string): number[] {
  const parts = readText(cursor, length, 256).split('\\');
  if (parts.length < count) {
    throw new DicomReadError(`The ${name} is incomplete.`);
  }
  return parts.slice(0, count).map((part) => {
    const text = part.trim();
    const value = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/u.test(text) ? Number(text) : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new DicomReadError(`The ${name} is invalid.`);
    }
    return value;
  });
}

function readDecimal(cursor: Cursor, length: number, name: string): number {
  return readDecimals(cursor, length, 1, name)[0] as number;
}

function readPositive(cursor: Cursor, length: number, name: string): number {
  const value = readDecimal(cursor, length, name);
  if (!(value > 0)) {
    throw new DicomReadError(`The ${name} must be positive.`);
  }
  return value;
}

function readShort(cursor: Cursor, header: Header, syntax: DicomTransferSyntax): number {
  if (header.length !== 2) {
    throw new DicomReadError('A required numeric image tag has an invalid length.');
  }
  return cursor.word(syntax !== 'explicitVrBigEndian');
}

function readOrientation(cursor: Cursor, length: number): PatientOrientation {
  const v = readDecimals(cursor, length, 6, 'image orientation');
  const across = new Point3D(v[0] as number, v[1] as number, v[2] as number);
  const down = new Point3D(v[3] as number, v[4] as number, v[5] as number);
  const orientation = new PatientOrientation(across, down);
  if (across.length < 0.5 || down.length < 0.5 || Point3D.cross(across, down).length < 0.5) {
    throw new DicomReadError('The image orientation is invalid.');
  }
  return new PatientOrientation(orientation.across.normalized(), orientation.down.normalized());
}

function parseSyntax(uid: string | undefined): DicomTransferSyntax {
  switch (uid) {
    case implicitLittle:
      return 'implicitVrLittleEndian';
    case explicitLittle:
      return 'explicitVrLittleEndian';
    case explicitBig:
      return 'explicitVrBigEndian';
    case undefined:
    case '':
      throw new DicomReadError('The transfer syntax is missing.');
    default:
      throw new DicomReadError(
        'The transfer syntax is compressed or unsupported. Only uncompressed implicit or explicit VR data is supported.',
      );
  }
}

function checkShape(metadata: Metadata): void {
  if (metadata.width <= 0 || metadata.height <= 0) {
    throw new DicomReadError('The image dimensions are missing or invalid.');
  }
  if (metadata.samplesPerPixel !== 1) {
    throw new DicomReadError('Only single-sample grayscale images are supported.');
  }
  if (metadata.numberOfFrames !== 1) {
    throw new DicomReadError('Only single-frame images are supported.');
  }
  if (
    (metadata.bitsAllocated !== 8 && metadata.bitsAllocated !== 16) ||
    metadata.bitsStored <= 0 ||
    metadata.bitsStored > metadata.bitsAllocated ||
    metadata.highBit < metadata.bitsStored - 1 ||
    metadata.highBit >= metadata.bitsAllocated
  ) {
    throw new DicomReadError('The pixel bit layout is missing or invalid.');
  }
}

function readPixels(cursor: Cursor, header: Header, syntax: DicomTransferSyntax, metadata: Metadata): Pixels {
  if (header.length === undefinedLength) {
    throw new DicomReadError('Encapsulated or compressed pixel data is not supported.');
  }
  checkShape(metadata);
  const count = metadata.width * metadata.height;
  const expected = count * (metadata.bitsAllocated / 8);
  // Without the padding byte an odd length gets.
  if (header.length !== expected && header.length !== expected + (expected & 1)) {
    throw new DicomReadError('The pixel-data length does not match the image dimensions.');
  }
  const raw = cursor.take(expected);
  cursor.skip(header.length - expected);
  return convert(raw, count, syntax, metadata);
}

// Keeps bytes and words as they are where possible, 16-bit values with their scale, and the rest as floats.
function convert(raw: Uint8Array, count: number, syntax: DicomTransferSyntax, metadata: Metadata): Pixels {
  const shift = metadata.highBit - metadata.bitsStored + 1;
  const fullUnsigned =
    !metadata.isSigned &&
    metadata.rescaleSlope === 1 &&
    metadata.rescaleIntercept === 0 &&
    shift === 0 &&
    metadata.bitsStored === metadata.bitsAllocated;
  if (fullUnsigned && metadata.bitsAllocated === 8) {
    return { kind: 'byte', values: raw.slice() };
  }
  const little = syntax !== 'explicitVrBigEndian';
  const words = readWords(raw, count, little);
  if (fullUnsigned) {
    return { kind: 'word', values: words, slope: 1, intercept: 0 };
  }
  const mask = metadata.bitsStored === 16 ? 0xffff : (1 << metadata.bitsStored) - 1;
  const sign = 1 << (metadata.bitsStored - 1);
  const full = 1 << metadata.bitsStored;
  const isSigned = metadata.isSigned;
  // 16-bit images keep two bytes per value with the scale beside them; signed values move up by 32768.
  if (metadata.bitsAllocated === 16) {
    const lift = isSigned ? 32768 : 0;
    for (let i = 0; i < count; i++) {
      const bits = ((words[i] as number) >>> shift) & mask;
      words[i] = (isSigned && (bits & sign) !== 0 ? bits - full : bits) + lift;
    }
    return {
      kind: 'word',
      values: words,
      slope: metadata.rescaleSlope,
      intercept: metadata.rescaleIntercept - lift * metadata.rescaleSlope,
    };
  }
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const bits = ((raw[i] as number) >>> shift) & mask;
    values[i] =
      (isSigned && (bits & sign) !== 0 ? bits - full : bits) * metadata.rescaleSlope + metadata.rescaleIntercept;
  }
  return { kind: 'float', values };
}

// The words of 16-bit values, copied whole in the byte order of the machine and turned only where it differs.
function readWords(raw: Uint8Array, count: number, little: boolean): Uint16Array {
  if (raw.length < count * 2) {
    return new Uint16Array(count);
  }
  const words = new Uint16Array(raw.slice(0, count * 2).buffer);
  if (little !== machineLittle) {
    for (let i = 0; i < count; i++) {
      const value = words[i] as number;
      words[i] = ((value & 0xff) << 8) | (value >>> 8);
    }
  }
  return words;
}

const machineLittle = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

function readImage(bytes: Uint8Array): MedicalImage {
  const cursor = new Cursor(bytes);
  if (bytes.length < 132 || ascii.decode(bytes.subarray(128, 132)) !== 'DICM') {
    throw new DicomReadError('The DICOM Part 10 marker is missing.');
  }
  cursor.at = 132;
  let transferUid: string | undefined;
  for (;;) {
    const at = cursor.at;
    const header = readHeader(cursor, 'explicitVrLittleEndian');
    if (header.group !== 0x0002) {
      cursor.at = at;
      break;
    }
    if (tagOf(header) === tags.transferSyntax) {
      transferUid = readText(cursor, header.length, 128);
    } else {
      skipValue(cursor, header, 'explicitVrLittleEndian');
    }
  }
  const syntax = parseSyntax(transferUid);
  const metadata: Metadata = {
    width: 0,
    height: 0,
    bitsAllocated: 0,
    bitsStored: 0,
    highBit: 0,
    isSigned: false,
    samplesPerPixel: 1,
    numberOfFrames: 1,
    transferSyntax: syntax,
    photometricInterpretation: 'monochrome2',
    rescaleSlope: 1,
    rescaleIntercept: 0,
  };
  let pixels: Pixels | undefined;
  while (cursor.left > 0) {
    const header = readHeader(cursor, syntax);
    switch (tagOf(header)) {
      case tags.modality:
        metadata.modality = readText(cursor, header.length, 64);
        break;
      case tags.sliceThickness:
        metadata.sliceThickness = readPositive(cursor, header.length, 'slice thickness');
        break;
      case tags.spacingBetweenSlices:
        metadata.spacingBetweenSlices = Math.abs(readDecimal(cursor, header.length, 'slice spacing'));
        break;
      case tags.seriesInstanceUid:
        metadata.seriesInstanceUid = readText(cursor, header.length, 128);
        break;
      case tags.imagePosition: {
        const v = readDecimals(cursor, header.length, 3, 'image position');
        metadata.position = new Point3D(v[0] as number, v[1] as number, v[2] as number);
        break;
      }
      case tags.imageOrientation:
        metadata.orientation = readOrientation(cursor, header.length);
        break;
      case tags.samplesPerPixel:
        metadata.samplesPerPixel = readShort(cursor, header, syntax);
        break;
      case tags.photometric: {
        const text = readText(cursor, header.length, 32);
        if (text !== 'MONOCHROME1' && text !== 'MONOCHROME2') {
          throw new DicomReadError('Only monochrome images are supported.');
        }
        metadata.photometricInterpretation = text === 'MONOCHROME1' ? 'monochrome1' : 'monochrome2';
        break;
      }
      case tags.numberOfFrames: {
        const text = (readText(cursor, header.length, 32).split('\\')[0] ?? '').trim();
        const value = /^\d+$/u.test(text) ? Number(text) : 0;
        if (!(value > 0)) {
          throw new DicomReadError('The frame count is invalid.');
        }
        metadata.numberOfFrames = value;
        break;
      }
      case tags.rows:
        metadata.height = readShort(cursor, header, syntax);
        break;
      case tags.columns:
        metadata.width = readShort(cursor, header, syntax);
        break;
      case tags.pixelSpacing: {
        const v = readDecimals(cursor, header.length, 2, 'pixel spacing');
        if (!((v[0] as number) > 0 && (v[1] as number) > 0)) {
          throw new DicomReadError('The pixel spacing must be positive.');
        }
        metadata.spacing = { row: v[0] as number, column: v[1] as number };
        break;
      }
      case tags.windowCenter:
        metadata.windowCenter = readDecimal(cursor, header.length, 'window centre');
        break;
      case tags.windowWidth:
        metadata.windowWidth = readPositive(cursor, header.length, 'window width');
        break;
      case tags.rescaleIntercept:
        metadata.rescaleIntercept = readDecimal(cursor, header.length, 'rescale intercept');
        break;
      case tags.rescaleSlope: {
        const value = readDecimal(cursor, header.length, 'rescale slope');
        if (value === 0) {
          throw new DicomReadError('The rescale slope must not be zero.');
        }
        metadata.rescaleSlope = value;
        break;
      }
      case tags.bitsAllocated:
        metadata.bitsAllocated = readShort(cursor, header, syntax);
        break;
      case tags.bitsStored:
        metadata.bitsStored = readShort(cursor, header, syntax);
        break;
      case tags.highBit:
        metadata.highBit = readShort(cursor, header, syntax);
        break;
      case tags.pixelRepresentation: {
        const value = readShort(cursor, header, syntax);
        if (value !== 0 && value !== 1) {
          throw new DicomReadError('The pixel representation must be unsigned or signed.');
        }
        metadata.isSigned = value === 1;
        break;
      }
      case tags.pixelData:
        pixels = readPixels(cursor, header, syntax, metadata);
        break;
      default:
        skipValue(cursor, header, syntax);
    }
  }
  checkShape(metadata);
  if (!pixels) {
    throw new DicomReadError('The pixel data is missing.');
  }
  return createImage(metadata, pixels);
}

/** Reads uncompressed DICOM images, one frame of grey values each. */
export const DicomReader = {
  /**
   * Reads an image from the bytes of a DICOM file.
   * @throws DicomReadError when the file is no DICOM file, is compressed, or is damaged.
   */
  read(bytes: Uint8Array | ArrayBuffer): MedicalImage {
    return readImage(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  },

  /**
   * Reads an image from a file, such as one a person drops on the page.
   * @throws DicomReadError when the file is no DICOM file, is compressed, or is damaged.
   */
  async readFile(file: Blob): Promise<MedicalImage> {
    return readImage(new Uint8Array(await file.arrayBuffer()));
  },
};

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-5;
const nearPoint = (a: Point3D, b: Point3D): boolean => near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z);

/** Builds volumes from the images of a DICOM series. */
export const DicomSeriesReader = {
  /**
   * Reads the files of a series and stacks their images along the normal of the slices.
   * @throws DicomReadError when a file cannot be read or the images do not form one regular volume.
   */
  async readFiles(files: readonly Blob[]): Promise<MedicalVolume> {
    const images = await Promise.all(files.map((file) => DicomReader.readFile(file)));
    return DicomSeriesReader.build(images);
  },

  /**
   * Stacks the images of one series along the normal of the slices, at regular distances.
   * @throws DicomReadError when the images do not form one regular volume.
   */
  build(images: readonly MedicalImage[]): MedicalVolume {
    if (images.length < 2) {
      throw new DicomReadError('A volume requires at least two images.');
    }
    const first = images[0] as MedicalImage;
    const uid = first.seriesInstanceUid;
    const orientation = first.orientation;
    const spacing = first.spacing;
    if (!uid || !orientation || !spacing || !first.position) {
      throw new DicomReadError('The series UID, image position, orientation or pixel spacing is missing.');
    }
    for (const image of images.slice(1)) {
      if (image.seriesInstanceUid !== uid) {
        throw new DicomReadError('The images belong to different series.');
      }
      if (
        image.width !== first.width ||
        image.height !== first.height ||
        image.bitsAllocated !== first.bitsAllocated ||
        image.isSigned !== first.isSigned ||
        !image.position ||
        !image.orientation ||
        !image.spacing
      ) {
        throw new DicomReadError('The images have incompatible geometry or pixel formats.');
      }
      if (
        !nearPoint(orientation.across, image.orientation.across) ||
        !nearPoint(orientation.down, image.orientation.down) ||
        !near(spacing.row, image.spacing.row) ||
        !near(spacing.column, image.spacing.column)
      ) {
        throw new DicomReadError('The images have inconsistent orientation or pixel spacing.');
      }
    }
    const normal = orientation.normal;
    const coordinate = (image: MedicalImage): number => Point3D.dot(image.position as Point3D, normal);
    const slices = [...images].sort((a, b) => coordinate(a) - coordinate(b));
    const coordinates = slices.map(coordinate);
    const sliceSpacing =
      ((coordinates[coordinates.length - 1] as number) - (coordinates[0] as number)) / (coordinates.length - 1);
    if (!(Number.isFinite(sliceSpacing) && sliceSpacing > 0)) {
      throw new DicomReadError('Slice positions must be distinct along the image normal.');
    }
    const tolerance = Math.max(1e-3, sliceSpacing * 1e-3);
    for (let i = 1; i < coordinates.length; i++) {
      if (Math.abs((coordinates[i] as number) - (coordinates[i - 1] as number) - sliceSpacing) > tolerance) {
        throw new DicomReadError('Slice positions are not regularly spaced.');
      }
    }
    return new MedicalVolume(
      stack(slices, first.width, first.height),
      spacing,
      sliceSpacing,
      (slices[0] as MedicalImage).position as Point3D,
      orientation,
      first.windowCenter,
      first.windowWidth,
      first.modality,
    );
  },
};

function stack(slices: readonly MedicalImage[], width: number, height: number): VolumeData {
  const size = width * height;
  const firstPixels = pixelsOf(slices[0] as MedicalImage);
  const same = slices.every((slice) => {
    const pixels = pixelsOf(slice);
    if (pixels.kind !== firstPixels.kind) {
      return false;
    }
    return (
      pixels.kind !== 'word' ||
      firstPixels.kind !== 'word' ||
      (pixels.slope === firstPixels.slope && pixels.intercept === firstPixels.intercept)
    );
  });
  if (same && firstPixels.kind === 'byte') {
    const bytes = new Uint8Array(size * slices.length);
    slices.forEach((slice, i) => {
      bytes.set(pixelsOf(slice).values, i * size);
    });
    return new VolumeData(bytes, width, height, slices.length);
  }
  if (same && firstPixels.kind === 'word') {
    const words = new Uint16Array(size * slices.length);
    slices.forEach((slice, i) => {
      words.set(pixelsOf(slice).values, i * size);
    });
    return new VolumeData(words, width, height, slices.length, firstPixels.slope, firstPixels.intercept);
  }
  const values = new Float32Array(size * slices.length);
  slices.forEach((slice, i) => {
    values.set(slice.values(), i * size);
  });
  return new VolumeData(values, width, height, slices.length);
}
