// Precomputed extremes in levels of growing blocks (LodPyramid of the .NET version).
import type { NumberArray } from '../data/source';
import { accumulate, Extremes } from './min-max';

/** The values per block of the lowest level. */
export const baseBlockSize = 16;
const initialBlocks = 64;

class Level {
  count = 0;
  min: Float64Array;
  max: Float64Array;

  constructor(capacity: number) {
    this.min = new Float64Array(capacity);
    this.max = new Float64Array(capacity);
  }

  ensure(blocks: number): void {
    if (blocks > this.min.length) {
      const capacity = Math.max(blocks, this.min.length * 2);
      const min = new Float64Array(capacity);
      const max = new Float64Array(capacity);
      min.set(this.min.subarray(0, this.count));
      max.set(this.max.subarray(0, this.count));
      this.min = min;
      this.max = max;
    }
  }
}

/**
 * Precomputed extremes in levels of growing blocks, which answer range queries without touching most of the data.
 * Only complete blocks are stored and a stored block never changes, so the values must be append-only. Values behind
 * the stored blocks are scanned, so a query is always right, however far the pyramid is behind.
 */
export class LodPyramid {
  /** The default number of blocks of one level that form a block of the next level. */
  static readonly defaultFactor = 4;
  private readonly levels: Level[] = [new Level(initialBlocks)];
  private readonly scratch = new Extremes();

  /**
   * @param factor - The number of blocks of one level that form a block of the next, at least 2.
   * @throws RangeError when the factor is below 2.
   */
  constructor(
    /** The number of blocks of one level that form a block of the next. */
    readonly factor = LodPyramid.defaultFactor,
  ) {
    if (!Number.isInteger(factor) || factor < 2) {
      throw new RangeError(`The factor must be an integer of at least 2, not ${String(factor)}.`);
    }
  }

  /** The number of values covered by stored blocks. */
  get coveredCount(): number {
    return this.base.count * baseBlockSize;
  }

  /** The memory of the stored blocks in bytes. */
  get byteCount(): number {
    let blocks = 0;
    for (const level of this.levels) {
      blocks += level.count;
    }
    return blocks * 2 * Float64Array.BYTES_PER_ELEMENT;
  }

  private get base(): Level {
    return this.levels[0] as Level;
  }

  /**
   * Adds the blocks that became complete among the first `count` values, at most `maxBlocks` of them, and returns
   * whether all complete blocks are stored.
   */
  update(values: NumberArray, count = values.length, maxBlocks = Number.POSITIVE_INFINITY): boolean {
    const complete = Math.floor(count / baseBlockSize);
    const target = Math.min(complete, this.base.count + maxBlocks);
    const base = this.base;
    base.ensure(target);
    const extremes = this.scratch;
    for (let block = base.count; block < target; block++) {
      accumulate(values, block * baseBlockSize, (block + 1) * baseBlockSize, extremes.clear());
      base.min[block] = extremes.min;
      base.max[block] = extremes.max;
    }
    if (target > base.count) {
      base.count = target;
      this.buildLevels();
    }
    return target === complete;
  }

  /**
   * Adds base blocks computed elsewhere, such as in a worker: the extremes of the blocks from `first` on.
   * @throws RangeError when `first` is not the next block to store.
   */
  addBlocks(first: number, min: Float64Array, max: Float64Array): void {
    const base = this.base;
    if (first !== base.count || min.length !== max.length) {
      throw new RangeError(`Blocks from ${String(first)} do not follow the ${String(base.count)} stored ones.`);
    }
    base.ensure(first + min.length);
    base.min.set(min, first);
    base.max.set(max, first);
    base.count = first + min.length;
    this.buildLevels();
  }

  /** Adds the extremes of `values[start, end)` to `extremes` and returns them. */
  query(values: NumberArray, start: number, end: number, extremes: Extremes): Extremes {
    let firstBlock = Math.trunc((start + baseBlockSize - 1) / baseBlockSize);
    let lastBlock = Math.min(Math.trunc(end / baseBlockSize), this.base.count);
    if (firstBlock >= lastBlock) {
      accumulate(values, start, end, extremes);
      return extremes;
    }
    accumulate(values, start, firstBlock * baseBlockSize, extremes);
    accumulate(values, lastBlock * baseBlockSize, end, extremes);
    const factor = this.factor;
    for (let index = 0; firstBlock < lastBlock; index++) {
      const level = this.levels[index] as Level;
      const next = this.levels[index + 1];
      if (!next || Math.trunc(lastBlock / factor) > next.count) {
        LodPyramid.accumulateBlocks(level, firstBlock, lastBlock, extremes);
        break;
      }
      const alignedStart = Math.min(Math.trunc((firstBlock + factor - 1) / factor) * factor, lastBlock);
      const alignedEnd = Math.max(lastBlock - (lastBlock % factor), alignedStart);
      LodPyramid.accumulateBlocks(level, firstBlock, alignedStart, extremes);
      LodPyramid.accumulateBlocks(level, alignedEnd, lastBlock, extremes);
      firstBlock = alignedStart / factor;
      lastBlock = alignedEnd / factor;
    }
    return extremes;
  }

  private static accumulateBlocks(level: Level, first: number, last: number, extremes: Extremes): void {
    let min = extremes.min;
    let max = extremes.max;
    for (let block = first; block < last; block++) {
      min = Math.min(min, level.min[block] as number);
      max = Math.max(max, level.max[block] as number);
    }
    extremes.min = min;
    extremes.max = max;
  }

  private buildLevels(): void {
    const extremes = this.scratch;
    for (let index = 0; index < this.levels.length; index++) {
      const source = this.levels[index] as Level;
      const target = Math.trunc(source.count / this.factor);
      if (target === 0) {
        break;
      }
      let level = this.levels[index + 1];
      if (!level) {
        level = new Level(Math.max(target, initialBlocks));
        this.levels.push(level);
      }
      level.ensure(target);
      for (let block = level.count; block < target; block++) {
        LodPyramid.accumulateBlocks(source, block * this.factor, (block + 1) * this.factor, extremes.clear());
        level.min[block] = extremes.min;
        level.max[block] = extremes.max;
      }
      level.count = target;
    }
  }
}
