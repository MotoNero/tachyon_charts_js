// Points and matrices of the 3D scene, in double precision on the CPU, as Point3D and Matrix3D of the .NET version.

/** A point or direction in space. */
export class Point3D {
  /** The origin. */
  static readonly zero = new Point3D(0, 0, 0);

  /**
   * @param x - The X coordinate.
   * @param y - The Y coordinate.
   * @param z - The Z coordinate, upwards.
   */
  constructor(
    /** The X coordinate. */
    readonly x: number,
    /** The Y coordinate. */
    readonly y: number,
    /** The Z coordinate, upwards. */
    readonly z: number,
  ) {}

  /** The length as a direction. */
  get length(): number {
    return Math.sqrt(Point3D.dot(this, this));
  }

  /** The scalar product. */
  static dot(a: Point3D, b: Point3D): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  /** The cross product. */
  static cross(a: Point3D, b: Point3D): Point3D {
    return new Point3D(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }

  /** The sum. */
  plus(other: Point3D): Point3D {
    return new Point3D(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  /** The difference. */
  minus(other: Point3D): Point3D {
    return new Point3D(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  /** The point scaled by a factor. */
  times(factor: number): Point3D {
    return new Point3D(this.x * factor, this.y * factor, this.z * factor);
  }

  /** The direction with length 1; unchanged for the zero vector. */
  normalized(): Point3D {
    const length = this.length;
    return length > 0 ? this.times(1 / length) : this;
  }

  /** The point with another Z. */
  withZ(z: number): Point3D {
    return new Point3D(this.x, this.y, z);
  }

  /** Whether both points are the same. */
  equals(other: Point3D): boolean {
    return this.x === other.x && this.y === other.y && this.z === other.z;
  }
}

/** A 4 × 4 matrix in rows, for projecting the scene. */
export class Matrix3D {
  private constructor(private readonly m: Float64Array) {}

  /** @internal A matrix from its 16 numbers, row by row. */
  static of(rows: readonly number[]): Matrix3D {
    return new Matrix3D(Float64Array.from(rows));
  }

  /** The number in a row and column. */
  at(row: number, column: number): number {
    return this.m[row * 4 + column] as number;
  }

  /** The product with another matrix, this one applied last. */
  times(b: Matrix3D): Matrix3D {
    const result = new Float64Array(16);
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += this.at(row, k) * b.at(k, column);
        }
        result[row * 4 + column] = sum;
      }
    }
    return new Matrix3D(result);
  }

  /** The view from an eye onto a target, `up` pointing upwards on the screen. */
  static lookAt(eye: Point3D, target: Point3D, up: Point3D): Matrix3D {
    const back = eye.minus(target).normalized();
    const right = Point3D.cross(up, back).normalized();
    const top = Point3D.cross(back, right);
    return Matrix3D.of([
      right.x,
      right.y,
      right.z,
      -Point3D.dot(right, eye),
      top.x,
      top.y,
      top.z,
      -Point3D.dot(top, eye),
      back.x,
      back.y,
      back.z,
      -Point3D.dot(back, eye),
      0,
      0,
      0,
      1,
    ]);
  }

  /** A perspective with a vertical angle in radians, depth 0 at the near and 1 at the far plane. */
  static perspective(verticalAngle: number, aspect: number, near: number, far: number): Matrix3D {
    const scale = 1 / Math.tan(verticalAngle / 2);
    const depth = far / (near - far);
    return Matrix3D.of([scale / aspect, 0, 0, 0, 0, scale, 0, 0, 0, 0, depth, near * depth, 0, 0, -1, 0]);
  }

  /** A parallel projection that shows a height of the scene. */
  static orthographic(height: number, aspect: number, near: number, far: number): Matrix3D {
    const depth = 1 / (near - far);
    return Matrix3D.of([2 / (height * aspect), 0, 0, 0, 0, 2 / height, 0, 0, 0, 0, depth, near * depth, 0, 0, 0, 1]);
  }

  /** A point in clip space, divided by W, with W. */
  projectWithW(point: Point3D): { x: number; y: number; w: number } {
    const x = this.at(0, 0) * point.x + this.at(0, 1) * point.y + this.at(0, 2) * point.z + this.at(0, 3);
    const y = this.at(1, 0) * point.x + this.at(1, 1) * point.y + this.at(1, 2) * point.z + this.at(1, 3);
    const w = this.at(3, 0) * point.x + this.at(3, 1) * point.y + this.at(3, 2) * point.z + this.at(3, 3);
    return { x: x / w, y: y / w, w };
  }

  /** A point in normalized device coordinates. */
  project(point: Point3D): { x: number; y: number; z: number } {
    const x = this.at(0, 0) * point.x + this.at(0, 1) * point.y + this.at(0, 2) * point.z + this.at(0, 3);
    const y = this.at(1, 0) * point.x + this.at(1, 1) * point.y + this.at(1, 2) * point.z + this.at(1, 3);
    const z = this.at(2, 0) * point.x + this.at(2, 1) * point.y + this.at(2, 2) * point.z + this.at(2, 3);
    const w = this.at(3, 0) * point.x + this.at(3, 1) * point.y + this.at(3, 2) * point.z + this.at(3, 3);
    return { x: x / w, y: y / w, z: z / w };
  }

  /** The point of the scene at a place in normalized device coordinates. */
  unproject(x: number, y: number, z: number): Point3D {
    // Solves the matrix against the place by elimination, which needs no inverse matrix.
    const width = 5;
    const rows = new Float64Array(4 * width);
    const target = [x, y, z, 1];
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        rows[row * width + column] = this.at(row, column);
      }
      rows[row * width + 4] = target[row] as number;
    }
    for (let column = 0; column < 4; column++) {
      eliminate(rows, column);
    }
    const r = (i: number): number => rows[i] as number;
    const w = r(3 * width + 4) / r(3 * width + 3);
    return new Point3D(r(4) / r(0) / w, r(width + 4) / r(width + 1) / w, r(2 * width + 4) / r(2 * width + 2) / w);
  }

  /** The matrix in the column order of WGSL, as 32-bit floats. */
  toGpu(into: Float32Array, offset = 0): void {
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        into[offset + column * 4 + row] = this.at(row, column);
      }
    }
  }
}

function eliminate(rows: Float64Array, column: number): void {
  const width = 5;
  const r = (i: number): number => rows[i] as number;
  let pivot = column;
  for (let row = column + 1; row < 4; row++) {
    if (Math.abs(r(row * width + column)) > Math.abs(r(pivot * width + column))) {
      pivot = row;
    }
  }
  for (let i = 0; pivot !== column && i < width; i++) {
    const swap = r(pivot * width + i);
    rows[pivot * width + i] = r(column * width + i);
    rows[column * width + i] = swap;
  }
  for (let row = 0; row < 4; row++) {
    const factor = r(row * width + column) / r(column * width + column);
    for (let i = column; row !== column && i < width; i++) {
      rows[row * width + i] = r(row * width + i) - factor * r(column * width + i);
    }
  }
}
