// Digital signals, as IDigitalSource, DigitalTransitions and PackedBits of the .NET version: one level per point at an
// even X step, kept as the places where the level changes, or as packed bits with an index of the blocks that change.

/** A digital signal: one level, low or high, per point at an even X step. */
export interface DigitalSource {
  /** The number of points. */
  readonly count: number;
  /** The X of the first point. */
  readonly xStart: number;
  /** The X distance between two points. */
  readonly xStep: number;
  /** Grows with every change. */
  readonly version: number;
  /** The level of a point: true for high. */
  levelAt(index: number): boolean;
  /** The first point from `from` to before `to` whose level differs from the point before it; -1 for none. */
  nextChange(from: number, to: number): number;
}

/**
 * A digital signal kept as the places where its level changes: few changes over many points take little memory.
 * Append levels as they come; points are counted from 0.
 */
export class DigitalTransitions implements DigitalSource {
  private changes = new Float64Array(64);
  private changeCount = 0;
  private points = 0;
  private initial = false;
  private level = false;
  private changed = 0;

  /**
   * @param xStart - The X of the first point.
   * @param xStep - The X distance between two points.
   */
  constructor(
    /** The X of the first point. */
    readonly xStart = 0,
    /** The X distance between two points. */
    readonly xStep = 1,
  ) {}

  /** {@inheritDoc DigitalSource.count} */
  get count(): number {
    return this.points;
  }

  /** {@inheritDoc DigitalSource.version} */
  get version(): number {
    return this.changed;
  }

  /** The number of changes. */
  get transitionCount(): number {
    return this.changeCount;
  }

  /** Appends `count` points of one level. */
  append(level: boolean, count = 1): void {
    if (count <= 0) {
      return;
    }
    if (this.points === 0) {
      this.initial = level;
      this.level = level;
    } else if (level !== this.level) {
      if (this.changeCount === this.changes.length) {
        const grown = new Float64Array(this.changes.length * 2);
        grown.set(this.changes);
        this.changes = grown;
      }
      this.changes[this.changeCount++] = this.points;
      this.level = level;
    }
    this.points += count;
    this.changed++;
  }

  /** {@inheritDoc DigitalSource.levelAt} */
  levelAt(index: number): boolean {
    return this.initial !== ((this.upperBound(index) & 1) === 1);
  }

  /** {@inheritDoc DigitalSource.nextChange} */
  nextChange(from: number, to: number): number {
    const at = this.lowerBound(Math.max(from, 1));
    return at < this.changeCount && (this.changes[at] as number) < to ? (this.changes[at] as number) : -1;
  }

  // The number of changes at or before an index.
  private upperBound(index: number): number {
    let low = 0;
    let high = this.changeCount;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.changes[middle] as number) <= index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  // The number of changes before an index.
  private lowerBound(index: number): number {
    let low = 0;
    let high = this.changeCount;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.changes[middle] as number) < index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

/** Points per block of the index of changes. */
export const changeBlockSize = 4096;
/** Blocks of a level per block of the level above. */
const changeFactor = 64;

/**
 * Which blocks of 4096 points hold a change (a point whose level differs from the one before it), and levels of 64
 * blocks each above, so that a range of any length says at once whether it changes and where the first change lies.
 */
export class ChangeIndex {
  /** One flag per block on the lowest level, then one per 64 blocks on each level above. */
  readonly levels: Uint8Array[];
  private pieces = 0;

  /** @param points - The number of points. */
  constructor(points: number) {
    let size = Math.ceil(points / changeBlockSize);
    this.levels = [new Uint8Array(size)];
    while (size > 1) {
      size = Math.ceil(size / changeFactor);
      this.levels.push(new Uint8Array(size));
    }
  }

  /** Grows with every update. */
  get version(): number {
    return this.pieces;
  }

  /** Sets the flags of blocks from `first` on and the levels above them. */
  setBlocks(first: number, flags: ArrayLike<number>): void {
    const bottom = this.levels[0] as Uint8Array;
    for (let i = 0; i < flags.length; i++) {
      bottom[first + i] = flags[i] as number;
    }
    let start = first;
    let end = first + flags.length;
    for (let level = 1; level < this.levels.length; level++) {
      const below = this.levels[level - 1] as Uint8Array;
      const here = this.levels[level] as Uint8Array;
      start = Math.floor(start / changeFactor);
      end = Math.ceil(end / changeFactor);
      for (let block = start; block < end; block++) {
        let any = 0;
        for (let child = block * changeFactor; child < Math.min((block + 1) * changeFactor, below.length); child++) {
          any |= below[child] as number;
        }
        here[block] = any;
      }
    }
    this.pieces++;
  }

  /** The first block from `first` to before `end` with a change; -1 for none. */
  firstChangedBlock(first: number, end: number): number {
    return this.find(0, first, end);
  }

  // Looks on one level, descending into a block above as soon as it has a change.
  private find(level: number, first: number, end: number): number {
    const flags = this.levels[level] as Uint8Array;
    let block = first;
    while (block < end) {
      const above = level + 1 < this.levels.length ? Math.floor(block / changeFactor) : -1;
      // Whole blocks above without a change are skipped at once.
      if (above >= 0 && block % changeFactor === 0 && (this.levels[level + 1] as Uint8Array)[above] === 0) {
        block = (above + 1) * changeFactor;
        continue;
      }
      if (flags[block] === 1) {
        return block;
      }
      block++;
    }
    return -1;
  }
}

/** Counts the changes of a run of packed bits: bit i of the result is set when bit i differs from bit i - 1. */
function changesOf(word: number, previous: number): number {
  return (word ^ ((word << 1) | previous)) >>> 0;
}

/**
 * A digital signal as packed bits, 32 points to a word, the first point in bit 0, as a bit column of a column file
 * holds them (its 64-bit words are two such words each). An index of the blocks that change makes wide views fast.
 */
export class PackedBits implements DigitalSource {
  /** The index of the blocks that change. */
  readonly index: ChangeIndex;

  /**
   * @param words - The bits; they are not copied.
   * @param count - The number of points.
   * @param xStart - The X of the first point.
   * @param xStep - The X distance between two points.
   */
  constructor(
    /** The bits, 32 points to a word. */
    readonly words: Uint32Array,
    /** The number of points. */
    readonly count: number,
    /** The X of the first point. */
    readonly xStart = 0,
    /** The X distance between two points. */
    readonly xStep = 1,
  ) {
    this.index = new ChangeIndex(count);
    const blocks = Math.ceil(count / changeBlockSize);
    const flags = new Uint8Array(blocks);
    for (let block = 0; block < blocks; block++) {
      const start = block * changeBlockSize;
      flags[block] = this.scan(Math.max(start, 1), Math.min(start + changeBlockSize, count)) >= 0 ? 1 : 0;
    }
    this.index.setBlocks(0, flags);
  }

  /** {@inheritDoc DigitalSource.version} */
  get version(): number {
    return this.index.version;
  }

  /** {@inheritDoc DigitalSource.levelAt} */
  levelAt(index: number): boolean {
    return (((this.words[index >>> 5] as number) >>> (index & 31)) & 1) === 1;
  }

  /** {@inheritDoc DigitalSource.nextChange} */
  nextChange(from: number, to: number): number {
    const start = Math.max(from, 1);
    const end = Math.min(to, this.count);
    if (start >= end) {
      return -1;
    }
    // The rest of the first block, then the first block with a change, then its first change.
    const headEnd = Math.min((Math.floor(start / changeBlockSize) + 1) * changeBlockSize, end);
    const head = this.scan(start, headEnd);
    if (head >= 0 || headEnd === end) {
      return head;
    }
    const block = this.index.firstChangedBlock(headEnd / changeBlockSize, Math.ceil(end / changeBlockSize));
    return block < 0 ? -1 : this.scan(block * changeBlockSize, end);
  }

  // The first change from `start` (at least 1) to before `end`, word by word.
  private scan(start: number, end: number): number {
    for (let at = start; at < end;) {
      const word = at >>> 5;
      const previous = word === 0 ? (this.words[0] as number) & 1 : ((this.words[word - 1] as number) >>> 31) & 1;
      let changes = changesOf(this.words[word] as number, previous);
      // Only the bits from `at` to before `end` within this word.
      changes &= (0xffffffff << (at & 31)) >>> 0;
      const wordEnd = (word + 1) * 32;
      if (end < wordEnd) {
        changes &= (1 << (end & 31)) - 1;
      }
      if (word === 0) {
        changes &= ~1;
      }
      if (changes !== 0) {
        return word * 32 + (31 - Math.clz32(changes & -changes));
      }
      at = wordEnd;
    }
    return -1;
  }
}
