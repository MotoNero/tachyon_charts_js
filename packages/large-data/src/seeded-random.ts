// The random numbers of System.Random with a seed (the subtractive generator of Knuth that .NET keeps for seeded
// instances), so that point tiles mix their points in the same order as the .NET version.

const seedBase = 161_803_398;
const intMax = 2_147_483_647;

/** A random generator with a seed, number for number the same as System.Random(seed) of .NET. */
export class SeededRandom {
  private readonly table = new Int32Array(56);
  private next = 0;
  private nextP = 21;

  /** @param seed - The seed. */
  constructor(seed: number) {
    const table = this.table;
    const subtraction = seed === -2_147_483_648 ? intMax : Math.abs(seed);
    let mj = seedBase - subtraction;
    table[55] = mj;
    let mk = 1;
    let ii = 0;
    for (let i = 1; i < 55; i++) {
      ii += 21;
      if (ii >= 55) {
        ii -= 55;
      }
      table[ii] = mk;
      mk = mj - mk;
      if (mk < 0) {
        mk += intMax;
      }
      mj = table[ii] as number;
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let n = i + 30;
        if (n >= 55) {
          n -= 55;
        }
        let value = (table[i] as number) - (table[1 + n] as number);
        if (value < 0) {
          value += intMax;
        }
        table[i] = value;
      }
    }
  }

  /** A number from 0 to 1, exclusive, as NextDouble(). */
  nextDouble(): number {
    return this.sample() * (1 / intMax);
  }

  /** A whole number from 0 to `maxValue`, exclusive, as Next(maxValue). */
  nextInt(maxValue: number): number {
    return Math.trunc(this.sample() * (1 / intMax) * maxValue);
  }

  /**
   * A whole number from 0 to `maxValue`, exclusive, as NextInt64(maxValue): the top bits of a 64-bit number made of
   * three draws, drawn again until below the bound. Exact for bounds up to 2^53.
   */
  nextInt64(maxValue: number): number {
    if (maxValue <= 1) {
      return 0;
    }
    const bits = Math.ceil(Math.log2(maxValue));
    // log2 of a power of two can come out a hair high or low; the bound decides.
    let width = bits;
    if (2 ** (bits - 1) >= maxValue) {
      width = bits - 1;
    } else if (2 ** bits < maxValue) {
      width = bits + 1;
    }
    for (;;) {
      const low = this.nextInt(1 << 22);
      const middle = this.nextInt(1 << 22);
      const high = this.nextInt(1 << 20);
      let result: number;
      if (width <= 20) {
        result = Math.floor(high / 2 ** (20 - width));
      } else if (width <= 42) {
        result = high * 2 ** (width - 20) + Math.floor(middle / 2 ** (42 - width));
      } else {
        result = high * 2 ** (width - 20) + middle * 2 ** (width - 42) + Math.floor(low / 2 ** (64 - width));
      }
      if (result < maxValue) {
        return result;
      }
    }
  }

  private sample(): number {
    const table = this.table;
    let next = this.next + 1;
    if (next >= 56) {
      next = 1;
    }
    let nextP = this.nextP + 1;
    if (nextP >= 56) {
      nextP = 1;
    }
    let value = (table[next] as number) - (table[nextP] as number);
    if (value === intMax) {
      value--;
    }
    if (value < 0) {
      value += intMax;
    }
    table[next] = value;
    this.next = next;
    this.nextP = nextP;
    return value;
  }
}
