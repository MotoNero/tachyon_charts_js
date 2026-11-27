// The error of the readers of point, volume and page files.

/** A file that cannot be read as points, a volume or pages, with the reason in the message. */
export class PointFileError extends Error {
  /** The name of the error. */
  override readonly name = 'PointFileError';
}
