// Time zones of the IANA database through Intl, with the conversions of wall clocks the time axis needs (TimeZoneInfo
// and WallClock of the .NET version). Times here are milliseconds since 1970-01-01 UTC; a wall time is the same count
// read on the local clock as if it were UTC.

const hour = 3_600_000;
const day = 24 * hour;
const invalidTimeStep = 15 * 60_000;

/** A time zone of the IANA database, such as `Europe/Berlin`, or `UTC`. */
export class TimeZone {
  private static readonly zones = new Map<string, TimeZone>();
  /** Coordinated universal time, without offsets. */
  static readonly utc = new TimeZone('UTC', undefined);

  private constructor(
    /** The name in the IANA database. */
    readonly name: string,
    private readonly format: Intl.DateTimeFormat | undefined,
  ) {}

  /**
   * The zone of a name of the IANA database.
   * @throws RangeError when the runtime knows no such zone.
   */
  static of(name: string): TimeZone {
    if (name === 'UTC') {
      return TimeZone.utc;
    }
    let zone = TimeZone.zones.get(name);
    if (!zone) {
      const format = new Intl.DateTimeFormat('en-US', {
        timeZone: name,
        hourCycle: 'h23',
        era: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
      zone = new TimeZone(name, format);
      TimeZone.zones.set(name, zone);
    }
    return zone;
  }

  /** The offset of the local clock from UTC at a time, in milliseconds. */
  offsetAt(time: number): number {
    if (!this.format) {
      return 0;
    }
    const second = Math.floor(time / 1000) * 1000;
    let year = 0;
    let month = 0;
    let date = 0;
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    let beforeChrist = false;
    for (const part of this.format.formatToParts(second)) {
      const value = Number(part.value);
      switch (part.type) {
        case 'year':
          year = value;
          break;
        case 'month':
          month = value;
          break;
        case 'day':
          date = value;
          break;
        case 'hour':
          hours = value;
          break;
        case 'minute':
          minutes = value;
          break;
        case 'second':
          seconds = value;
          break;
        case 'era':
          beforeChrist = part.value.startsWith('B');
          break;
        default:
          break;
      }
    }
    return wallTime(beforeChrist ? 1 - year : year, month - 1, date, hours, minutes, seconds) - second;
  }

  /** A time read on the local clock. */
  toWall(time: number): number {
    return time + this.offsetAt(time);
  }

  /** Whether a clock change skips a wall time, such as 02:30 on the spring change in Berlin. */
  isInvalid(wall: number): boolean {
    return this.offsetsOf(wall).length === 0;
  }

  /**
   * The time of a wall time. A time skipped by a clock change moves to the first valid one in steps of 15 minutes, a
   * time that occurs twice means its first occurrence.
   */
  toUtc(wall: number): number {
    if (!this.format) {
      return wall;
    }
    let offsets = this.offsetsOf(wall);
    let local = wall;
    while (offsets.length === 0) {
      local += invalidTimeStep;
      offsets = this.offsetsOf(local);
    }
    return local - Math.max(...offsets);
  }

  // The offsets with which a wall time is a time of the zone: none in a gap, two in a repeated hour.
  private offsetsOf(wall: number): number[] {
    if (!this.format) {
      return [0];
    }
    const offsets: number[] = [];
    for (const candidate of [this.offsetAt(wall - day), this.offsetAt(wall + day), this.offsetAt(wall)]) {
      if (!offsets.includes(candidate) && this.offsetAt(wall - candidate) === candidate) {
        offsets.push(candidate);
      }
    }
    return offsets;
  }
}

/** A wall time from its fields, for any year from 1 on (Date.UTC reads years below 100 as 19xx). */
export function wallTime(year: number, month: number, date: number, hours = 0, minutes = 0, seconds = 0): number {
  const time = new Date(0);
  time.setUTCFullYear(year, month, date);
  time.setUTCHours(hours, minutes, seconds, 0);
  return time.getTime();
}
