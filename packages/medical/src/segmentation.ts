// Segmentations of a volume, as MedicalSegment, MedicalSegmentation, AlignedSegmentation, MedicalSegmentationLayer and
// MedicalSegmentationSeries of the .NET version: labels on a raster of their own, put onto the voxels of a volume,
// shown in colour over its slices and in 3D as a volume of labels or as a surface per label.
import {
  Colormap,
  type Axis,
  type CommandList,
  ChartSeries,
  DoubleRange,
  type GpuTexture,
  type PixelRect,
  type RenderDevice,
  type Rgba8,
  type SeriesFrame,
} from '@tachyon-charts/core';
import { Point3D, TransferFunction3D, Volume3D, VolumeData, type TransferPoint3D } from '@tachyon-charts/3d';
import {
  checkOrientation,
  checkSpacing,
  type ImageSpacing,
  type MedicalVolume,
  type PatientOrientation,
} from './medical-image';
import type { MedicalMprPlane } from './slices';

/** How a segmentation shows in 3D: one volume of all labels, or a lit surface per label. */
export type MedicalSegmentation3DMode = 'volume' | 'surface';

/** A label of a segmentation: its name, colour, opacity and whether it shows. */
export class MedicalSegment {
  private segmentName: string;
  private segmentColor: Rgba8;
  private segmentOpacity = 0.55;
  private visible = true;
  /** @internal The functions called when the segment changes. */
  readonly listeners = new Set<() => void>();

  /**
   * @param label - The value of the label, from 1 to 65 535.
   * @param name - The name.
   * @param color - The colour.
   * @throws RangeError for a label outside 1 to 65 535.
   */
  constructor(
    /** The value of the label. */
    readonly label: number,
    name: string,
    color: Rgba8,
  ) {
    if (!(Number.isInteger(label) && label >= 1 && label <= 65535)) {
      throw new RangeError('A label lies between 1 and 65,535.');
    }
    this.segmentName = name;
    this.segmentColor = color;
  }

  /** The name. */
  get name(): string {
    return this.segmentName;
  }

  set name(value: string) {
    if (value !== this.segmentName) {
      this.segmentName = value;
      this.changed();
    }
  }

  /** The colour. */
  get color(): Rgba8 {
    return this.segmentColor;
  }

  set color(value: Rgba8) {
    const old = this.segmentColor;
    if (value.r !== old.r || value.g !== old.g || value.b !== old.b || value.a !== old.a) {
      this.segmentColor = value;
      this.changed();
    }
  }

  /**
   * How opaque the label shows, from 0 to 1; 0.55 by default.
   * @throws RangeError outside 0 to 1.
   */
  get opacity(): number {
    return this.segmentOpacity;
  }

  set opacity(value: number) {
    if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new RangeError('Opacity must be finite and between zero and one.');
    }
    if (value !== this.segmentOpacity) {
      this.segmentOpacity = value;
      this.changed();
    }
  }

  /** Whether the label shows. */
  get isVisible(): boolean {
    return this.visible;
  }

  set isVisible(value: boolean) {
    if (value !== this.visible) {
      this.visible = value;
      this.changed();
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const palette: readonly Rgba8[] = [
  { r: 230, g: 75, b: 90, a: 255 },
  { r: 55, g: 180, b: 110, a: 255 },
  { r: 60, g: 130, b: 235, a: 255 },
  { r: 245, g: 175, b: 55, a: 255 },
  { r: 170, g: 95, b: 225, a: 255 },
  { r: 45, g: 195, b: 205, a: 255 },
  { r: 240, g: 105, b: 180, a: 255 },
  { r: 155, g: 190, b: 55, a: 255 },
];

/** Labels on a raster of their own with its geometry in the patient; labels without a description get one. */
export class MedicalSegmentation {
  /** The spacing of the voxels in millimetres. */
  readonly voxelSpacing: Point3D;
  /** The descriptions of the labels, by label. */
  readonly segments: readonly MedicalSegment[];
  /** How the segmentation shows in 3D. */
  readonly threeDMode: MedicalSegmentation3DMode;
  private readonly listeners = new Set<() => void>();
  private changes = 0;

  /**
   * @param data - The labels, whole numbers from 0 (none) to 65 535.
   * @param inPlane - The spacing of the pixels of a slice.
   * @param sliceSpacing - The distance between slices.
   * @param origin - The place of the first voxel in the patient.
   * @param orientation - The directions of a slice in the patient.
   * @param segments - Descriptions of labels.
   * @param threeDMode - How it shows in 3D; one volume by default.
   * @throws RangeError for values that are no labels, a label described twice, or unusable geometry.
   */
  constructor(
    /** The labels. */
    readonly data: VolumeData,
    inPlane: ImageSpacing,
    sliceSpacing: number,
    /** The place of the first voxel in the patient. */
    readonly origin: Point3D,
    /** The directions of a slice in the patient. */
    readonly orientation: PatientOrientation,
    segments: readonly MedicalSegment[] = [],
    threeDMode: MedicalSegmentation3DMode = 'volume',
  ) {
    checkSpacing(inPlane);
    if (!(Number.isFinite(sliceSpacing) && sliceSpacing > 0)) {
      throw new RangeError('Slice spacing must be finite and positive.');
    }
    checkOrientation(orientation);
    this.voxelSpacing = new Point3D(inPlane.column, inPlane.row, sliceSpacing);
    this.threeDMode = threeDMode;
    const described = new Map<number, MedicalSegment>();
    for (const segment of segments) {
      if (described.has(segment.label)) {
        throw new RangeError(`Label ${String(segment.label)} is described more than once.`);
      }
      described.set(segment.label, segment);
    }
    for (const label of findLabels(data)) {
      if (!described.has(label)) {
        described.set(
          label,
          new MedicalSegment(label, `Label ${String(label)}`, palette[(label - 1) % palette.length] as Rgba8),
        );
      }
    }
    this.segments = [...described.values()].sort((a, b) => a.label - b.label);
    for (const segment of this.segments) {
      segment.listeners.add(() => {
        this.changes++;
        for (const listener of this.listeners) {
          listener();
        }
      });
    }
  }

  /** @internal Grows with every change of a segment. */
  get version(): number {
    return this.changes;
  }

  /** Calls a function whenever a segment changes; returns a function that stops it. */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function findLabels(data: VolumeData): number[] {
  const seen = new Uint8Array(65536);
  const values = data.values;
  const scaled = data.slope !== 1 || data.intercept !== 0 || values instanceof Float32Array;
  for (const stored of values) {
    const value = scaled ? stored * data.slope + data.intercept : stored;
    if (!(Number.isFinite(value) && value >= 0 && value <= 65535 && value === Math.trunc(value))) {
      throw new RangeError('A label map may contain only integer values from zero through 65,535.');
    }
    seen[value] = 1;
  }
  const labels: number[] = [];
  for (let label = 1; label < seen.length; label++) {
    if (seen[label] === 1) {
      labels.push(label);
    }
  }
  return labels;
}

function toPatient(local: Point3D, origin: Point3D, orientation: PatientOrientation): Point3D {
  return origin
    .plus(orientation.across.normalized().times(local.x))
    .plus(orientation.down.normalized().times(local.y))
    .plus(orientation.normal.times(local.z));
}

function fromPatient(patient: Point3D, origin: Point3D, orientation: PatientOrientation): Point3D {
  const delta = patient.minus(origin);
  return new Point3D(
    Point3D.dot(delta, orientation.across.normalized()),
    Point3D.dot(delta, orientation.down.normalized()),
    Point3D.dot(delta, orientation.normal),
  );
}

function nearest(position: number, spacing: number, count: number): number {
  const voxel = position / spacing;
  if (voxel < -0.5 || voxel > count - 0.5) {
    return -1;
  }
  return Math.min(Math.max(Math.floor(voxel + 0.5), 0), count - 1);
}

/** @internal The labels of a segmentation on the voxels of a volume, each voxel the label nearest to it. */
export class AlignedSegmentation {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly labels: Uint16Array;
  private present: number[] | undefined;
  private compact: VolumeData | undefined;
  private readonly binaries = new Map<number, VolumeData>();

  constructor(target: MedicalVolume, source: MedicalSegmentation) {
    this.width = target.data.width;
    this.height = target.data.height;
    this.depth = target.data.depth;
    this.labels = new Uint16Array(this.width * this.height * this.depth);
    const targetSpacing = target.voxelSpacing;
    const sourceSpacing = source.voxelSpacing;
    // Both mappings are rotations and shifts, so a voxel of the target lies in the source at a start plus a step per
    // index; that saves two transforms per voxel of volumes with millions of them.
    const inSource = (x: number, y: number, z: number): Point3D =>
      fromPatient(
        toPatient(
          new Point3D(x * targetSpacing.x, y * targetSpacing.y, z * targetSpacing.z),
          target.origin,
          target.orientation,
        ),
        source.origin,
        source.orientation,
      );
    const start = inSource(0, 0, 0);
    const stepX = inSource(1, 0, 0).minus(start);
    const stepY = inSource(0, 1, 0).minus(start);
    const stepZ = inSource(0, 0, 1).minus(start);
    const data = source.data;
    for (let z = 0; z < this.depth; z++) {
      for (let y = 0; y < this.height; y++) {
        const row = start.plus(stepY.times(y)).plus(stepZ.times(z));
        for (let x = 0; x < this.width; x++) {
          const px = row.x + stepX.x * x;
          const py = row.y + stepX.y * x;
          const pz = row.z + stepX.z * x;
          const sx = nearest(px, sourceSpacing.x, data.width);
          const sy = nearest(py, sourceSpacing.y, data.height);
          const sz = nearest(pz, sourceSpacing.z, data.depth);
          if (sx >= 0 && sy >= 0 && sz >= 0) {
            this.labels[(z * this.height + y) * this.width + x] = data.at(sx, sy, sz);
          }
        }
      }
    }
  }

  at(x: number, y: number, z: number): number {
    return this.labels[(z * this.height + y) * this.width + x] as number;
  }

  /** The labels that occur, in order. */
  get presentLabels(): readonly number[] {
    if (!this.present) {
      const seen = new Uint8Array(65536);
      for (const label of this.labels) {
        seen[label] = 1;
      }
      this.present = [];
      for (let label = 1; label < seen.length; label++) {
        if (seen[label] === 1) {
          this.present.push(label);
        }
      }
    }
    return this.present;
  }

  /** The byte a label of the compact volume gets, spread over 1 to 255. */
  compactValue(index: number): number {
    return roundHalfEven((255 * (index + 1)) / this.presentLabels.length);
  }

  /** All labels as bytes, for one volume of labels. */
  get compactData(): VolumeData {
    if (!this.compact) {
      const table = new Uint8Array(65536);
      this.presentLabels.forEach((label, i) => {
        table[label] = this.compactValue(i);
      });
      const values = new Uint8Array(this.labels.length);
      for (let i = 0; i < values.length; i++) {
        values[i] = table[this.labels[i] as number] as number;
      }
      this.compact = new VolumeData(values, this.width, this.height, this.depth);
    }
    return this.compact;
  }

  /** One label full, the rest empty, for its surface. */
  binary(label: number): VolumeData {
    let data = this.binaries.get(label);
    if (!data) {
      const values = new Uint8Array(this.labels.length);
      for (let i = 0; i < values.length; i++) {
        values[i] = this.labels[i] === label ? 255 : 0;
      }
      data = new VolumeData(values, this.width, this.height, this.depth);
      this.binaries.set(label, data);
    }
    return data;
  }

  read(plane: MedicalMprPlane, column: number, row: number, index: number): number {
    switch (plane) {
      case 'axial':
        return this.at(column, row, index);
      case 'coronal':
        return this.at(column, index, this.depth - 1 - row);
      default:
        return this.at(index, column, this.depth - 1 - row);
    }
  }
}

// Math.Round of .NET rounds halves to even.
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}

/** @internal A segmentation put onto a volume, with its volumes for 3D charts. */
export class SegmentationLayer {
  readonly aligned: AlignedSegmentation;
  readonly objects: Volume3D[] = [];
  private readonly segments: Map<number, MedicalSegment>;
  private readonly surfaces = new Map<MedicalSegment, Volume3D>();
  private readonly compact = new Map<number, number>();
  private readonly transfer: TransferFunction3D | undefined;
  private readonly volume: Volume3D | undefined;

  constructor(
    target: MedicalVolume,
    readonly source: MedicalSegmentation,
  ) {
    this.aligned = new AlignedSegmentation(target, source);
    this.segments = new Map(source.segments.map((segment) => [segment.label, segment]));
    const present = this.aligned.presentLabels;
    if (source.threeDMode === 'volume' && present.length <= 255) {
      present.forEach((label, i) => this.compact.set(label, this.aligned.compactValue(i)));
      const clear = { r: 0, g: 0, b: 0, a: 0 };
      this.transfer = new TransferFunction3D([
        { share: 0, color: clear, opacity: 0 },
        { share: 1, color: clear, opacity: 0 },
      ]);
      this.transfer.showsEditor = false;
      this.volume = this.createVolume(target, this.aligned.compactData, 'transfer', this.transfer);
      this.objects.push(this.volume);
    }
    if (source.threeDMode === 'surface') {
      for (const label of present) {
        const segment = this.segments.get(label);
        if (segment) {
          const surface = this.createVolume(target, this.aligned.binary(label), 'surface', undefined);
          surface.isoValue = 255 / 2;
          this.surfaces.set(segment, surface);
          this.objects.push(surface);
        }
      }
    }
    this.refresh3D();
  }

  segment(label: number): MedicalSegment | undefined {
    return this.segments.get(label);
  }

  refresh3D(): void {
    if (this.source.threeDMode === 'volume' && !this.volume) {
      throw new RangeError(
        'The 3D volume mode supports at most 255 labels at once. Use surface mode for this segmentation.',
      );
    }
    if (this.volume && this.transfer) {
      this.transfer.replace(this.createTransfer());
      this.volume.setAppearance(Colormap.builtIn('Grayscale'), { isLit: false }, true);
    }
    for (const [segment, surface] of this.surfaces) {
      const color = segment.color;
      surface.setAppearance(
        new Colormap(`Segment ${String(segment.label)}`, [color, color]),
        { opacity: segment.opacity, gloss: 0.15 },
        segment.isVisible && segment.opacity > 0,
      );
    }
  }

  private createTransfer(): TransferPoint3D[] {
    const clear = { r: 0, g: 0, b: 0, a: 0 };
    let previous: TransferPoint3D = { share: 0, color: clear, opacity: 0 };
    const points: TransferPoint3D[] = [previous];
    let previousShare = 0;
    for (const [label, value] of [...this.compact.entries()].sort((a, b) => a[1] - b[1])) {
      const share = value / 255;
      const boundary = (previousShare + share) / 2;
      points.push({ ...previous, share: boundary });
      const segment = this.segments.get(label) as MedicalSegment;
      previous = { share: boundary, color: segment.color, opacity: segment.isVisible ? segment.opacity : 0 };
      points.push(previous);
      previousShare = share;
    }
    points.push({ ...previous, share: 1 });
    return points;
  }

  private createVolume(
    target: MedicalVolume,
    data: VolumeData,
    mode: 'transfer' | 'surface',
    transfer: TransferFunction3D | undefined,
  ): Volume3D {
    const spacing = target.voxelSpacing;
    const volume = new Volume3D(
      data,
      new DoubleRange(0, (data.width - 1) * spacing.x),
      new DoubleRange(0, (data.height - 1) * spacing.y),
      new DoubleRange(0, (data.depth - 1) * spacing.z),
      { mode, ...(transfer ? { transfer } : {}), showsSlices: false },
    );
    volume.showsEditor = false;
    volume.isInterpolated = mode === 'surface';
    return volume;
  }
}

/** @internal The labels on a slice in their colours, over the values. */
export class SegmentationSeries extends ChartSeries {
  private pixels: Uint8Array;
  private texture: GpuTexture | undefined;
  private uploaded = -1;
  private bounds: PixelRect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly slice: {
      readonly plane: MedicalMprPlane;
      readonly width: number;
      readonly height: number;
      readonly spacing: ImageSpacing;
      readonly sliceIndex: number;
    },
    private readonly layers: () => readonly SegmentationLayer[],
    private readonly stamp: () => number,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
    this.pixels = new Uint8Array(slice.width * slice.height * 4);
    this.name = 'Segmentation';
  }

  override get accentColor(): Rgba8 {
    return { r: 230, g: 75, b: 90, a: 255 };
  }

  get version(): number {
    return this.stamp();
  }

  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    return axis === 'x'
      ? new DoubleRange(0, this.slice.width * this.slice.spacing.column)
      : new DoubleRange(0, this.slice.height * this.slice.spacing.row);
  }

  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    if (this.layers().length === 0) {
      return;
    }
    this.texture ??= device.createTexture({
      size: { width: this.slice.width, height: this.slice.height },
      format: 'rgba8unorm',
    });
    const version = this.version;
    if (this.uploaded !== version) {
      this.fill();
      this.texture.write(this.pixels);
      this.uploaded = version;
    }
    const x0 = frame.x.toPixel(0);
    const x1 = frame.x.toPixel(this.slice.width * this.slice.spacing.column);
    const y0 = frame.y.toPixel(0);
    const y1 = frame.y.toPixel(this.slice.height * this.slice.spacing.row);
    this.bounds = {
      x: Math.fround(Math.min(x0, x1)),
      y: Math.fround(Math.min(y0, y1)),
      width: Math.fround(Math.abs(x1 - x0)),
      height: Math.fround(Math.abs(y1 - y0)),
    };
  }

  draw(commands: CommandList): void {
    if (this.texture && this.layers().length > 0 && this.bounds.width > 0 && this.bounds.height > 0) {
      commands.drawImage(this.texture, this.bounds);
    }
  }

  override releaseResources(): void {
    this.texture?.dispose();
    this.texture = undefined;
    this.uploaded = -1;
  }

  private fill(): void {
    const pixels = this.pixels;
    pixels.fill(0);
    const { plane, width, height } = this.slice;
    const index = this.slice.sliceIndex;
    for (const layer of this.layers()) {
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          const label = layer.aligned.read(plane, column, row, index);
          const segment = label === 0 ? undefined : layer.segment(label);
          if (!segment?.isVisible || segment.opacity <= 0) {
            continue;
          }
          const color = segment.color;
          const alpha = Math.min(Math.max(segment.opacity * (color.a / 255), 0), 1);
          over(pixels, (row * width + column) * 4, color, alpha);
        }
      }
    }
  }
}

// The colour over what lies there already, as the .NET version blends it.
function over(pixels: Uint8Array, at: number, source: Rgba8, alpha: number): void {
  const da = (pixels[at + 3] as number) / 255;
  const outA = alpha + da * (1 - alpha);
  if (outA <= 0) {
    pixels.fill(0, at, at + 4);
    return;
  }
  const channel = (sourceChannel: number, destination: number): number =>
    roundHalfEven((sourceChannel * alpha + destination * da * (1 - alpha)) / outA);
  pixels[at] = channel(source.r, pixels[at] as number);
  pixels[at + 1] = channel(source.g, pixels[at + 1] as number);
  pixels[at + 2] = channel(source.b, pixels[at + 2] as number);
  pixels[at + 3] = roundHalfEven(outA * 255);
}
