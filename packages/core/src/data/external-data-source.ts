// A data source over arrays owned by the application, as ExternalDataSource of the .NET version.
import {
  checkLengths,
  MetadataScanner,
  type DataMetadata,
  type DataSnapshot,
  type NumberArray,
  type PointSource,
} from './source';

/**
 * Shows typed arrays of the application without copying them. The metadata comes from one scan on first use, so that
 * making the source costs nothing. When the application changes the arrays, it calls {@link ExternalDataSource.invalidate}.
 */
export class ExternalDataSource implements PointSource {
  private cached: DataMetadata | undefined;
  private changes = 0;

  /**
   * @param x - The X values; a part of a larger buffer is fine (`subarray`).
   * @param y - The Y values, as many.
   * @param isSortedX - What the application knows of the order of X; scanned when left out.
   */
  constructor(
    readonly x: NumberArray,
    readonly y: NumberArray,
    private readonly isSortedX?: boolean,
  ) {
    checkLengths(x, y);
  }

  get version(): number {
    return this.changes;
  }

  get metadata(): DataMetadata {
    if (!this.cached) {
      const scanner = new MetadataScanner();
      scanner.add(this.x, this.y);
      const scanned = scanner.toMetadata(this.x.length);
      this.cached =
        this.isSortedX === undefined
          ? scanned
          : { ...scanned, isSortedX: this.isSortedX, uniformXStep: this.isSortedX ? scanned.uniformXStep : undefined };
    }
    return this.cached;
  }

  snapshot(): DataSnapshot {
    return this.snapshotInto({ x: this.x, y: this.y, count: 0, version: 0, metadata: this.metadata, epoch: 0 });
  }

  snapshotInto(target: DataSnapshot): DataSnapshot {
    target.x = this.x;
    target.y = this.y;
    target.count = this.x.length;
    target.version = this.changes;
    target.metadata = this.metadata;
    target.epoch = this.changes;
    return target;
  }

  latest(): number | undefined {
    return this.y.length > 0 ? this.y[this.y.length - 1] : undefined;
  }

  /** Announces that the application changed the arrays: the metadata is scanned again, the version grows. */
  invalidate(): void {
    this.cached = undefined;
    this.changes++;
  }
}
