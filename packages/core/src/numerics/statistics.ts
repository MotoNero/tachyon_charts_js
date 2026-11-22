// Statistics of samples as in the .NET version: histograms with the binning rules of NumPy, quartiles with its linear
// interpolation, the numbers of a box plot, and a kernel density estimate with the bandwidth of Scott.

/** Numbers that can be counted and walked through, such as an array or a typed array. */
export type Values = ArrayLike<number> & Iterable<number>;

/** How a histogram finds its bins; the rules follow those of NumPy. */
export type BinningRule = 'fixedCount' | 'fixedWidth' | 'sturges' | 'freedmanDiaconis';

/** Values sorted into bins of equal width: `counts[i]` values lie from `edges[i]` to `edges[i + 1]`. */
export interface Histogram {
  /** The edges of the bins, one more than bins. */
  readonly edges: Float64Array;
  /** The number of values per bin. */
  readonly counts: Float64Array;
}

/**
 * Counts values into bins. NaN and infinities are left out.
 * @param parameter - The number of bins for `fixedCount`, their width for `fixedWidth`.
 * @throws RangeError when a fixed rule has no positive parameter.
 */
export function computeHistogram(values: Values, rule: BinningRule, parameter = 0): Histogram {
  if ((rule === 'fixedCount' || rule === 'fixedWidth') && !(parameter > 0)) {
    throw new RangeError(`A fixed rule needs a positive parameter, not ${String(parameter)}.`);
  }
  const sorted = finiteSorted(values);
  if (sorted.length === 0) {
    return { edges: new Float64Array(0), counts: new Float64Array(0) };
  }
  let minimum = sorted[0] as number;
  let maximum = sorted.at(-1) as number;
  if (minimum === maximum) {
    // Like NumPy: one unit around a single value.
    minimum -= 0.5;
    maximum += 0.5;
  }
  const bins = countBins(sorted, maximum - minimum, rule, parameter);
  const edges = new Float64Array(bins + 1);
  for (let i = 0; i <= bins; i++) {
    edges[i] = minimum + ((maximum - minimum) * i) / bins;
  }
  const counts = new Float64Array(bins);
  for (const value of sorted) {
    const bin = Math.min(Math.trunc(((value - minimum) / (maximum - minimum)) * bins), bins - 1);
    counts[bin] = (counts[bin] as number) + 1;
  }
  return { edges, counts };
}

/** A quantile of sorted values, with the linear interpolation of NumPy. */
export function quantile(sorted: ArrayLike<number>, share: number): number {
  const position = share * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  const low = sorted[lower] as number;
  return low + ((sorted[upper] as number) - low) * (position - lower);
}

/** The finite values, sorted ascending. */
export function finiteSorted(values: Values): Float64Array {
  const result: number[] = [];
  for (const value of values) {
    if (Number.isFinite(value)) {
      result.push(value);
    }
  }
  return Float64Array.from(result).sort();
}

function countBins(sorted: Float64Array, range: number, rule: BinningRule, parameter: number): number {
  switch (rule) {
    case 'fixedCount':
      return Math.max(Math.trunc(parameter), 1);
    case 'fixedWidth':
      return Math.max(Math.ceil(range / parameter), 1);
    case 'sturges':
      return Math.max(Math.ceil(Math.log2(sorted.length) + 1), 1);
    default: {
      const interquartile = quantile(sorted, 0.75) - quantile(sorted, 0.25);
      const width = 2 * interquartile * Math.pow(sorted.length, -1 / 3);
      return width > 0 ? Math.max(Math.ceil(range / width), 1) : 1;
    }
  }
}

/**
 * What a box plot shows of a sample: quartiles after NumPy, whiskers at the outermost values within 1.5
 * interquartile ranges, and the values beyond them.
 */
export interface BoxStatistics {
  /** The first quartile. */
  readonly firstQuartile: number;
  /** The median. */
  readonly median: number;
  /** The third quartile. */
  readonly thirdQuartile: number;
  /** The lowest value within 1.5 interquartile ranges below the box. */
  readonly lowerWhisker: number;
  /** The highest value within 1.5 interquartile ranges above the box. */
  readonly upperWhisker: number;
  /** The values beyond the whiskers. */
  readonly outliers: readonly number[];
}

/** Computes the numbers of a box plot; undefined without a finite value. */
export function computeBoxStatistics(values: Values): BoxStatistics | undefined {
  const sorted = finiteSorted(values);
  if (sorted.length === 0) {
    return undefined;
  }
  const first = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const third = quantile(sorted, 0.75);
  const fence = 1.5 * (third - first);
  const inside = sorted.filter((value) => value >= first - fence && value <= third + fence);
  const outliers = [...sorted.filter((value) => value < first - fence || value > third + fence)];
  return {
    firstQuartile: first,
    median,
    thirdQuartile: third,
    lowerWhisker: inside[0] as number,
    upperWhisker: inside.at(-1) as number,
    outliers,
  };
}

/** The bandwidth of Scott for a Gaussian kernel: the standard deviation times n^(-1/5); 0 below two values. */
export function densityBandwidth(values: Values): number {
  if (values.length < 2) {
    return 0;
  }
  let mean = 0;
  for (const value of values) {
    mean += value;
  }
  mean /= values.length;
  let sum = 0;
  for (const value of values) {
    const delta = value - mean;
    sum += delta * delta;
  }
  return Math.sqrt(sum / (values.length - 1)) * Math.pow(values.length, -0.2);
}

/** The kernel density estimate at a position, with a Gaussian kernel. */
export function estimateDensity(values: Values, bandwidth: number, position: number): number {
  let sum = 0;
  for (const value of values) {
    const distance = (position - value) / bandwidth;
    sum += Math.exp(-0.5 * distance * distance);
  }
  return sum / (values.length * bandwidth * Math.sqrt(2 * Math.PI));
}
