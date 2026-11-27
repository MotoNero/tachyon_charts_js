// Writes encoded video frames into a WebM file: the EBML header, a segment with info and one video track, and clusters
// of simple blocks. Only what a player needs to play a video from the start; enough for the exports of a chart.

const encoder = new TextEncoder();

function vint(value: number): Uint8Array {
  // Eight bytes always: 0x01 marks the length, seven bytes hold the value.
  const bytes = new Uint8Array(8);
  bytes[0] = 0x01;
  let rest = value;
  for (let i = 7; i >= 1; i--) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  let rest = id;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Uint8Array.from(bytes);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.byteLength;
  }
  return result;
}

function element(id: number, body: Uint8Array): Uint8Array {
  return concat([idBytes(id), vint(body.byteLength), body]);
}

function unsigned(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return element(id, Uint8Array.from(bytes));
}

function float(id: number, value: number): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setFloat64(0, value);
  return element(id, body);
}

function text(id: number, value: string): Uint8Array {
  return element(id, encoder.encode(value));
}

/** @internal The codec of a WebM track, as the WebM names it. */
export type WebmCodec = 'V_VP9' | 'V_VP8' | 'V_AV1';

interface Frame {
  readonly data: Uint8Array;
  readonly milliseconds: number;
  readonly isKey: boolean;
}

/** @internal Collects encoded frames and writes them as one WebM file. */
export class WebmWriter {
  private readonly frames: Frame[] = [];
  private codecPrivate: Uint8Array | undefined;

  constructor(
    private readonly codec: WebmCodec,
    private readonly width: number,
    private readonly height: number,
  ) {}

  /** Takes the configuration record of the encoder, which AV1 needs in the file. */
  setCodecPrivate(description: Uint8Array): void {
    this.codecPrivate = description;
  }

  /** Adds an encoded frame at its time. */
  add(data: Uint8Array, milliseconds: number, isKey: boolean): void {
    this.frames.push({ data, milliseconds, isKey });
  }

  /** The number of frames added. */
  get count(): number {
    return this.frames.length;
  }

  /** The file, lasting until a time in milliseconds. */
  finish(duration: number): Blob {
    const header = element(
      0x1a45dfa3,
      concat([
        unsigned(0x4286, 1),
        unsigned(0x42f7, 1),
        unsigned(0x42f2, 4),
        unsigned(0x42f3, 8),
        text(0x4282, 'webm'),
        unsigned(0x4287, 4),
        unsigned(0x4285, 2),
      ]),
    );
    const info = element(
      0x1549a966,
      concat([
        unsigned(0x2ad7b1, 1_000_000),
        text(0x4d80, 'Tachyon Charts'),
        text(0x5741, 'Tachyon Charts'),
        float(0x4489, duration),
      ]),
    );
    const video = element(0xe0, concat([unsigned(0xb0, this.width), unsigned(0xba, this.height)]));
    const track = element(
      0xae,
      concat([
        unsigned(0xd7, 1),
        unsigned(0x73c5, 1),
        unsigned(0x83, 1),
        text(0x86, this.codec),
        ...(this.codecPrivate ? [element(0x63a2, this.codecPrivate)] : []),
        video,
      ]),
    );
    const tracks = element(0x1654ae6b, track);
    const segment = element(0x18538067, concat([info, tracks, ...this.clusters()]));
    return new Blob([header as BlobPart, segment as BlobPart], { type: 'video/webm' });
  }

  // A new cluster at each key frame and before a time the block could not hold, 32 seconds after its start.
  private clusters(): Uint8Array[] {
    const clusters: Uint8Array[] = [];
    let blocks: Uint8Array[] = [];
    let start = 0;
    const close = (): void => {
      if (blocks.length > 0) {
        clusters.push(element(0x1f43b675, concat([unsigned(0xe7, start), ...blocks])));
        blocks = [];
      }
    };
    for (const frame of this.frames) {
      const time = Math.round(frame.milliseconds);
      if (blocks.length === 0 || frame.isKey || time - start > 32_000) {
        close();
        start = time;
      }
      const head = new Uint8Array(4);
      head[0] = 0x81;
      new DataView(head.buffer).setInt16(1, time - start);
      head[3] = frame.isKey ? 0x80 : 0;
      blocks.push(element(0xa3, concat([head, frame.data])));
    }
    close();
    return clusters;
  }
}
