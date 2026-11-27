// The pages of a cloud far larger than memory, read from their file, as CloudPages of the .NET version: a view loads the
// pages it sees, as many points of each as its size on screen asks for. The file comes from buildCloudPages of the
// large data package or from the .NET version; both write the same format.
import { PointFileError } from './file-error';

const headerSize = 128;
const pageBytes = 40;
const magic = 0x444c4354; // "TCLD"
const formatVersion = 1;

/** The most points of a page. */
export const pageSize = 32_768;

/** A page: where its points start in the file, how many, and its box with corners from 0 to 1 of the whole. */
export interface CloudPage {
  /** The byte of the first point. */
  readonly offset: number;
  /** The points. */
  readonly count: number;
  /** The lower corner, from 0 to 1 of the whole. */
  readonly low: readonly [number, number, number];
  /** The upper corner, from 0 to 1 of the whole. */
  readonly high: readonly [number, number, number];
}

/** The pages of a cloud, opened from their file; the file may still be on its way. */
export class CloudPages {
  private table: CloudPage[] = [];
  private total = 0;
  private lowCorner: [number, number, number] = [0, 0, 0];
  private highCorner: [number, number, number] = [1, 1, 1];
  private file: Blob | undefined;
  private failure: unknown;

  /**
   * @param source - The file of the pages, or a promise of it while it is built.
   * @param progress - How far the building has come, from 0 to 1, while the file is on its way.
   */
  constructor(
    source: Blob | Promise<Blob>,
    private readonly progress: () => number = () => 0,
  ) {
    void Promise.resolve(source)
      .then((blob) => this.open(blob))
      .catch((error: unknown) => {
        this.failure = error;
      });
  }

  /** Whether the pages are open. */
  get isComplete(): boolean {
    return this.file !== undefined;
  }

  /** How far the pages are built, from 0 to 1. */
  get share(): number {
    return this.isComplete ? 1 : Math.min(0.99, this.progress());
  }

  /** Why the pages could not be opened, if they could not. */
  get error(): unknown {
    return this.failure;
  }

  /** The points with finite coordinates, once open. */
  get count(): number {
    return this.total;
  }

  /** The number of pages, once open. */
  get pageCount(): number {
    return this.table.length;
  }

  /** The lower corner of all points, once open. */
  get low(): readonly [number, number, number] {
    return this.lowCorner;
  }

  /** The upper corner of all points, once open. */
  get high(): readonly [number, number, number] {
    return this.highCorner;
  }

  /** A page. */
  page(index: number): CloudPage {
    return this.table[index] as CloudPage;
  }

  /** The first points of a page, three floats each from 0 to 1 of the whole; the start of a page is a fair sample. */
  async points(index: number, most: number): Promise<Float32Array> {
    const page = this.page(index);
    const count = Math.min(most, page.count);
    const bytes = await (this.file as Blob).slice(page.offset, page.offset + count * 12).arrayBuffer();
    return new Float32Array(bytes);
  }

  private async open(file: Blob): Promise<void> {
    const head = new DataView(await file.slice(0, headerSize).arrayBuffer());
    if (head.byteLength < headerSize || head.getUint32(0, true) !== magic || head.getInt32(4, true) !== formatVersion) {
      throw new PointFileError('This is no file of cloud pages.');
    }
    const count = Number(head.getBigInt64(16, true));
    const pages = head.getInt32(24, true);
    if (file.size < headerSize + pages * pageBytes + count * 12) {
      throw new PointFileError('The file of cloud pages is cut off.');
    }
    const table = new DataView(await file.slice(headerSize, headerSize + pages * pageBytes).arrayBuffer());
    const corner = (view: DataView, at: number, float: boolean): [number, number, number] =>
      float
        ? [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]
        : [view.getFloat64(at, true), view.getFloat64(at + 8, true), view.getFloat64(at + 16, true)];
    this.table = Array.from({ length: pages }, (_, i) => {
      const at = i * pageBytes;
      return {
        offset: Number(table.getBigInt64(at, true)),
        count: table.getInt32(at + 8, true),
        low: corner(table, at + 12, true),
        high: corner(table, at + 24, true),
      };
    });
    this.total = count;
    this.lowCorner = corner(head, 40, false);
    this.highCorner = corner(head, 64, false);
    this.file = file;
  }
}
