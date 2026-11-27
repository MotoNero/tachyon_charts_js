// Videos of a chart, as ChartVideo and ChartRecorder of the .NET version: each frame drawn at the size of the video and
// encoded with the encoder of the browser at its exact time, so that the video is sharp and plays evenly however long
// a frame takes to draw. A recording follows the chart as people use it until it is stopped.
import type { ChartSurface, RenderDevice, RenderTarget, ThemeDocument } from '@tachyon-charts/core';
import { WebmWriter, type WebmCodec } from './webm';

/** The size, length and encoding of a video of a chart. */
export interface ChartVideoOptions {
  /** The width in pixels; 1920 by default. */
  readonly width?: number;
  /** The height in pixels; 1080 by default. */
  readonly height?: number;
  /**
   * Pixels of the video per device-independent unit of the chart: 2 draws a chart laid out for 960 × 540 sharp at
   * 1920 × 1080, as on a screen scaled by two. 1 by default.
   */
  readonly scale?: number;
  /** Frames per second; 30 by default. */
  readonly frameRate?: number;
  /** The length in seconds of a video of fixed length; 5 by default. */
  readonly duration?: number;
  /** Bits per second of the encoded video; 12 million by default. */
  readonly bitRate?: number;
  /** A theme for the video only; the one of the chart when left out. */
  readonly theme?: ThemeDocument;
  /**
   * Called before each frame of a video of fixed length with its number and its time in seconds: move a range, turn a
   * camera, append data. The video plays evenly however long a frame takes.
   */
  readonly step?: (frame: number, seconds: number) => void;
  /** Called after each frame of a video of fixed length with the share done, from 0 to 1. */
  readonly onProgress?: (share: number) => void;
}

interface Codec {
  readonly config: string;
  readonly webm: WebmCodec;
}

// VP9 first, as players know it best; AV1 where it is not there; VP8 last.
const codecs: readonly Codec[] = [
  { config: 'vp09.00.51.08', webm: 'V_VP9' },
  { config: 'vp09.00.41.08', webm: 'V_VP9' },
  { config: 'av01.0.12M.08', webm: 'V_AV1' },
  { config: 'av01.0.08M.08', webm: 'V_AV1' },
  { config: 'vp8', webm: 'V_VP8' },
];

/** Whether the browser can encode videos itself (WebCodecs); without, a video comes from a recording of a canvas. */
export function canEncodeVideo(): boolean {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
}

interface Settings {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly frameRate: number;
  readonly bitRate: number;
}

function settingsOf(options: ChartVideoOptions): Settings {
  // Even sizes, as video encoders need them.
  const width = Math.floor((options.width ?? 1920) / 2) * 2;
  const height = Math.floor((options.height ?? 1080) / 2) * 2;
  const frameRate = options.frameRate ?? 30;
  const scale = options.scale ?? 1;
  const bitRate = options.bitRate ?? 12_000_000;
  if (!(width >= 2 && height >= 2 && frameRate > 0 && scale > 0 && bitRate > 0)) {
    throw new RangeError('A video needs a size, a scale, a frame rate and a bit rate above 0.');
  }
  return { width, height, scale, frameRate, bitRate };
}

/** An encoder of frames into a WebM file. */
class FrameEncoder {
  private readonly encoder: VideoEncoder;
  private readonly writer: WebmWriter;
  private failure: Error | undefined;
  private frames = 0;

  private constructor(
    codec: Codec,
    private readonly settings: Settings,
  ) {
    this.writer = new WebmWriter(codec.webm, settings.width, settings.height);
    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const description = metadata?.decoderConfig?.description;
        if (description && codec.webm === 'V_AV1') {
          this.writer.setCodecPrivate(
            ArrayBuffer.isView(description)
              ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
              : new Uint8Array(description).slice(),
          );
        }
        this.writer.add(data, chunk.timestamp / 1000, chunk.type === 'key');
      },
      error: (error) => {
        this.failure = error;
      },
    });
    this.encoder.configure({
      codec: codec.config,
      width: settings.width,
      height: settings.height,
      bitrate: settings.bitRate,
      framerate: settings.frameRate,
      latencyMode: 'quality',
    });
  }

  static async create(settings: Settings): Promise<FrameEncoder> {
    for (const codec of codecs) {
      const support = await VideoEncoder.isConfigSupported({
        codec: codec.config,
        width: settings.width,
        height: settings.height,
        bitrate: settings.bitRate,
        framerate: settings.frameRate,
      });
      if (support.supported) {
        return new FrameEncoder(codec, settings);
      }
    }
    throw new Error('The browser cannot encode a video of this size.');
  }

  /** Encodes a frame of pixels at a time in seconds; a key frame every two seconds. */
  async encode(pixels: Uint8Array, seconds: number): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    const { width, height, frameRate } = this.settings;
    const frame = new VideoFrame(pixels, {
      format: 'RGBA',
      codedWidth: width,
      codedHeight: height,
      timestamp: Math.round(seconds * 1_000_000),
      duration: Math.round(1_000_000 / frameRate),
    });
    this.encoder.encode(frame, { keyFrame: this.frames % Math.round(frameRate * 2) === 0 });
    frame.close();
    this.frames++;
    // Not too far ahead of the encoder, so that a long video does not keep all frames in memory.
    while (this.encoder.encodeQueueSize > 4) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  /** The file, lasting until a time in seconds. */
  async finish(seconds: number): Promise<Blob> {
    await this.encoder.flush();
    this.encoder.close();
    if (this.failure) {
      throw this.failure;
    }
    return this.writer.finish(seconds * 1000);
  }

  /** Lets go of the encoder without a file. */
  cancel(): void {
    if (this.encoder.state !== 'closed') {
      this.encoder.close();
    }
  }
}

function drawFrame(chart: ChartSurface, device: RenderDevice, target: RenderTarget): void {
  // The layout can depend on the size of the picture; a second pass lets it settle on the first frame.
  chart.invalidate();
  chart.render(device, target);
}

/**
 * Records a video of fixed length: each frame belongs to the time of its number divided by the frame rate and is
 * encoded at that time, so the video plays evenly. Without WebCodecs it returns `undefined`.
 */
export async function encodeChartVideo(
  chart: ChartSurface,
  device: RenderDevice,
  options: ChartVideoOptions = {},
): Promise<Blob | undefined> {
  if (!canEncodeVideo()) {
    return undefined;
  }
  const settings = settingsOf(options);
  const frames = Math.ceil((options.duration ?? 5) * settings.frameRate);
  if (!(frames > 0)) {
    throw new RangeError('A video needs a length above 0.');
  }
  const encoder = await FrameEncoder.create(settings);
  const target = device.createOffscreenTarget({ width: settings.width, height: settings.height }, settings.scale);
  const ownTheme = chart.theme;
  if (options.theme) {
    chart.theme = options.theme;
  }
  try {
    for (let frame = 0; frame < frames; frame++) {
      const seconds = frame / settings.frameRate;
      options.step?.(frame, seconds);
      drawFrame(chart, device, target);
      if (frame === 0) {
        drawFrame(chart, device, target);
      }
      await encoder.encode(await target.readPixels(), seconds);
      options.onProgress?.((frame + 1) / frames);
    }
    return await encoder.finish(frames / settings.frameRate);
  } catch (error) {
    encoder.cancel();
    throw error;
  } finally {
    target.dispose();
    chart.theme = ownTheme;
    chart.invalidate();
  }
}

/** A recording that follows the chart as people use it, until it is stopped. */
export interface ChartRecording {
  /** The seconds recorded so far. */
  readonly seconds: number;
  /** Stops the recording and returns the video. */
  stop(): Promise<Blob>;
  /** Stops the recording without a video. */
  cancel(): void;
}

/**
 * Starts a recording of the chart as it changes: at the frame rate it draws the chart at the size of the video and
 * encodes it at the time it was drawn. Needs WebCodecs.
 * @throws Error without WebCodecs or without an encoder for the size.
 */
export async function startChartRecording(
  chart: ChartSurface,
  device: RenderDevice,
  options: ChartVideoOptions = {},
): Promise<ChartRecording> {
  if (!canEncodeVideo()) {
    throw new Error('The browser cannot encode videos.');
  }
  const settings = settingsOf(options);
  const encoder = await FrameEncoder.create(settings);
  const target = device.createOffscreenTarget({ width: settings.width, height: settings.height }, settings.scale);
  const start = performance.now();
  let seconds = 0;
  let isRunning = true;
  let pending: Promise<void> = Promise.resolve();
  let failure: unknown;
  let frame = 0;
  const capture = async (): Promise<void> => {
    const at = (performance.now() - start) / 1000;
    drawFrame(chart, device, target);
    if (frame === 0) {
      drawFrame(chart, device, target);
    }
    frame++;
    await encoder.encode(await target.readPixels(), at);
    seconds = at;
  };
  const timer = setInterval(() => {
    // A frame that takes longer than the interval lets the next one wait instead of piling up.
    pending = pending.then(capture).catch((error: unknown) => {
      failure = error;
    });
  }, 1000 / settings.frameRate);
  const end = async (): Promise<void> => {
    isRunning = false;
    clearInterval(timer);
    await pending;
    target.dispose();
    chart.invalidate();
  };
  return {
    get seconds() {
      return isRunning ? (performance.now() - start) / 1000 : seconds;
    },
    async stop() {
      await end();
      if (failure !== undefined) {
        encoder.cancel();
        throw failure instanceof Error ? failure : new Error('The recording failed.', { cause: failure });
      }
      return encoder.finish(Math.max(seconds + 1 / settings.frameRate, 1 / settings.frameRate));
    },
    cancel() {
      void end().then(() => {
        encoder.cancel();
      });
    },
  };
}
