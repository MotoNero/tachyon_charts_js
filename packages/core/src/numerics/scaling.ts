// Nonlinear scales of an axis: values are mapped to a space in which the axis is linear.

/** A nonlinear scale of an axis. */
export interface AxisScaling {
  /** A value as a position in the linear space of the scale. */
  forward(value: number): number;
  /** A position in the linear space as a value. */
  inverse(value: number): number;
}

/** A logarithm. Values at or below zero have no logarithm: they vanish (NaN), or stick to a floor if there is one. */
export class LogScaling implements AxisScaling {
  private readonly logOfBase: number;

  constructor(
    /** The base of the logarithm. */
    readonly base: number,
    /** The value that values at or below zero stick to; 0 lets them vanish. */
    readonly floor = 0,
  ) {
    this.logOfBase = Math.log(base);
  }

  /** {@inheritDoc AxisScaling.forward} */
  forward(value: number): number {
    let v = value;
    if (this.floor > 0 && !(v >= this.floor)) {
      v = Number.isNaN(v) ? v : this.floor;
    }
    return v > 0 ? Math.log(v) / this.logOfBase : Number.NaN;
  }

  /** {@inheritDoc AxisScaling.inverse} */
  inverse(value: number): number {
    return Math.exp(value * this.logOfBase);
  }
}

/** A logarithm for values of both signs, linear around zero, so that zero and negative values keep a place. */
export class SymLogScaling implements AxisScaling {
  private readonly logOfBase: number;

  constructor(
    /** The base of the logarithm. */
    readonly base: number,
    /** Up to this distance from zero the scale is linear. */
    readonly linearThreshold: number,
  ) {
    this.logOfBase = Math.log(base);
  }

  /** {@inheritDoc AxisScaling.forward} */
  forward(value: number): number {
    return (Math.sign(value) * Math.log(1 + Math.abs(value) / this.linearThreshold)) / this.logOfBase;
  }

  /** {@inheritDoc AxisScaling.inverse} */
  inverse(value: number): number {
    return Math.sign(value) * this.linearThreshold * (Math.exp(Math.abs(value) * this.logOfBase) - 1);
  }
}
