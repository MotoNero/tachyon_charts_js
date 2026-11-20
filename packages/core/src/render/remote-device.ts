// A render device whose GPU lives in a worker: it records resource changes and the commands of each frame into a
// batch and sends it to the render server (render-server.ts), which replays it on the real device. The main thread
// keeps the chart, its layout and the input; uploads, shaders, command encoding and presenting run in the worker.
import { glyphStride, type CommandList, type MarkerStyle, type PolylineStyle, type RasterStyle } from './commands';
import {
  DeviceLostError,
  type OffscreenRenderTarget,
  type RenderDevice,
  type RenderTarget,
  type SurfaceRenderTarget,
} from './device';
import { Op, type BatchMessage, type RenderEndpoint, type ServerMessage } from './remote-protocol';
import type { GpuBuffer, GpuTexture } from './resources';
import type {
  BufferDesc,
  DeviceCapabilities,
  PixelRect,
  PixelSize,
  Rgba8,
  SurfaceHandle,
  TextureDesc,
  TextureFormat,
} from './types';

// Payloads from this size on travel in a buffer of their own instead of the arena.
const largePayload = 64 * 1024;

// The batch being recorded; its arrays are reused, a flush copies the used part once.
class BatchWriter {
  private ops = new Float64Array(4096);
  private count = 0;
  private arena = new Uint8Array(64 * 1024);
  private used = 0;
  private objects: unknown[] = [];
  private transfer: object[] = [];
  frames = 0;

  get isEmpty(): boolean {
    return this.count === 0;
  }

  num(value: number): void {
    if (this.count === this.ops.length) {
      const grown = new Float64Array(this.ops.length * 2);
      grown.set(this.ops);
      this.ops = grown;
    }
    this.ops[this.count++] = value;
  }

  op(op: number, id: number): void {
    this.num(op);
    this.num(id);
  }

  rect(rect: PixelRect): void {
    this.num(rect.x);
    this.num(rect.y);
    this.num(rect.width);
    this.num(rect.height);
  }

  color(color: Rgba8): void {
    this.num(color.r);
    this.num(color.g);
    this.num(color.b);
    this.num(color.a);
  }

  object(value: unknown, transfer?: object): void {
    this.num(this.objects.length);
    this.objects.push(value);
    if (transfer) {
      this.transfer.push(transfer);
    }
  }

  // A copy of the bytes, since the caller may reuse its array right after the call.
  payload(data: ArrayBufferView, length = data.byteLength): void {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, length);
    if (length >= largePayload) {
      const copy = bytes.slice();
      this.object(copy.buffer, copy.buffer);
      this.num(0);
    } else {
      const start = (this.used + 7) & ~7;
      if (start + length > this.arena.length) {
        const grown = new Uint8Array(Math.max(this.arena.length * 2, start + length));
        grown.set(this.arena.subarray(0, this.used));
        this.arena = grown;
      }
      this.arena.set(bytes, start);
      this.used = start + length;
      this.num(-1);
      this.num(start);
    }
    this.num(length);
  }

  take(): { message: BatchMessage; transfer: object[] } {
    const ops = this.ops.slice(0, this.count);
    const arena = this.arena.slice(0, this.used);
    const message: BatchMessage = { type: 'batch', ops, arena, objects: this.objects, frames: this.frames };
    const transfer = [...this.transfer, ops.buffer, arena.buffer];
    this.count = 0;
    this.used = 0;
    this.objects = [];
    this.transfer = [];
    this.frames = 0;
    return { message, transfer };
  }
}

/**
 * A render device in a worker, seen from the main thread. Charts draw on it as on any device; it sends their frames to
 * the worker. Counters and the time of a frame arrive from the worker after it drew.
 */
export class RemoteRenderDevice implements RenderDevice {
  private readonly writer = new BatchWriter();
  private flushScheduled = false;
  private nextId = 1;
  private readonly requests = new Map<number, (value: Uint8Array | undefined) => void>();
  private readonly lostListeners = new Set<(reason: string) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  private readonly batchFrames: number[] = [];
  private disposed = false;
  private lost: string | undefined;
  private drawCalls = 0;
  private uploaded = 0;
  private outstandingFrames = 0;
  private frameTime = 0;

  /**
   * @param endpoint - The worker or port of the render server, after it reported `ready`.
   * @param capabilities - What the device in the worker can do.
   * @param onDispose - Called after `dispose`, such as to end the worker.
   */
  constructor(
    private readonly endpoint: RenderEndpoint,
    capabilities: DeviceCapabilities,
    private readonly onDispose?: () => void,
  ) {
    this.capabilities = capabilities;
  }

  /** What the device in the worker can do. */
  readonly capabilities: DeviceCapabilities;

  /** {@inheritDoc RenderDevice.isLost} */
  get isLost(): boolean {
    return this.lost !== undefined;
  }

  /** {@inheritDoc RenderDevice.lostReason} */
  get lostReason(): string | undefined {
    return this.lost;
  }

  /** Draw calls the worker issued, as of the last frame it reported. */
  get drawCallCount(): number {
    return this.drawCalls;
  }

  /** Bytes the worker uploaded, as of the last frame it reported. */
  get uploadedByteCount(): number {
    return this.uploaded;
  }

  /** Frames sent that the worker has not drawn yet; a chart waits while two are on their way. */
  get pendingFrames(): number {
    return this.outstandingFrames;
  }

  /** How long the worker took for the last batch of frames, in milliseconds. */
  get lastFrameMilliseconds(): number {
    return this.frameTime;
  }

  /** {@inheritDoc RenderDevice.onLost} */
  onLost(listener: (reason: string) => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /** Calls the listener when the worker fails to replay a batch; returns a function that stops it. */
  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** {@inheritDoc RenderDevice.simulateLoss} */
  simulateLoss(): void {
    this.writer.num(Op.simulateLoss);
    this.flush();
  }

  /** {@inheritDoc RenderDevice.createBuffer} */
  createBuffer(desc: BufferDesc): GpuBuffer {
    this.ensureUsable();
    const id = this.nextId++;
    this.writer.op(Op.createBuffer, id);
    this.writer.num(desc.sizeInBytes);
    this.writer.num(desc.usage);
    this.schedule();
    return new RemoteBuffer(this, this.writer, id, desc);
  }

  /** {@inheritDoc RenderDevice.createTexture} */
  createTexture(desc: TextureDesc): GpuTexture {
    this.ensureUsable();
    const id = this.nextId++;
    this.writer.op(Op.createTexture, id);
    this.writer.num(desc.size.width);
    this.writer.num(desc.size.height);
    this.writer.object(desc.format);
    this.schedule();
    return new RemoteTexture(this, this.writer, id, desc.size, desc.format);
  }

  /** {@inheritDoc RenderDevice.createOffscreenTarget} */
  createOffscreenTarget(size: PixelSize, dpiScale: number): OffscreenRenderTarget {
    this.ensureUsable();
    const id = this.nextId++;
    this.writer.op(Op.createOffscreenTarget, id);
    this.writeSize(size, dpiScale);
    this.schedule();
    return new RemoteTarget(this, this.writer, id, size, dpiScale);
  }

  /**
   * Creates a target that draws into a canvas in the worker. The canvas must be one the worker can take: an
   * `OffscreenCanvas`, such as from `transferControlToOffscreen`.
   */
  createSurfaceTarget(surface: SurfaceHandle, size: PixelSize, dpiScale: number): SurfaceRenderTarget {
    this.ensureUsable();
    const id = this.nextId++;
    this.writer.op(Op.createSurfaceTarget, id);
    this.writeSize(size, dpiScale);
    this.writer.object(surface.canvas, surface.canvas as object);
    this.flush();
    return new RemoteTarget(this, this.writer, id, size, dpiScale);
  }

  /** {@inheritDoc RenderDevice.beginFrame} */
  beginFrame(target: RenderTarget): CommandList {
    this.ensureUsable();
    const id = this.nextId++;
    this.writer.op(Op.beginFrame, id);
    this.writer.num((target as RemoteTarget).id);
    return new RemoteFrame(this, this.writer, id);
  }

  /** {@inheritDoc RenderDevice.whenIdle} */
  async whenIdle(): Promise<void> {
    await this.request(Op.whenIdle);
  }

  /** Ends the device in the worker; the device cannot be used afterwards. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.writer.num(Op.dispose);
    this.flush();
    this.disposed = true;
    for (const resolve of this.requests.values()) {
      resolve(undefined);
    }
    this.requests.clear();
    this.onDispose?.();
  }

  /** Takes a message of the render server. */
  receive(message: ServerMessage): void {
    switch (message.type) {
      case 'done':
        this.outstandingFrames -= this.batchFrames.shift() ?? 0;
        this.drawCalls = message.drawCalls;
        this.uploaded = message.uploadedBytes;
        if (message.frames > 0) {
          this.frameTime = message.milliseconds;
        }
        break;
      case 'pixels':
        this.answer(message.request, message.pixels);
        break;
      case 'idle':
        this.answer(message.request, undefined);
        break;
      case 'lost':
        this.lost = message.reason;
        for (const listener of this.lostListeners) {
          listener(message.reason);
        }
        break;
      case 'error':
        for (const listener of this.errorListeners) {
          listener(message.message);
        }
        break;
      default:
        break;
    }
  }

  /** Sends what was recorded. */
  flush(): void {
    this.flushScheduled = false;
    if (this.writer.isEmpty || this.disposed) {
      return;
    }
    const frames = this.writer.frames;
    const { message, transfer } = this.writer.take();
    this.batchFrames.push(frames);
    this.outstandingFrames += frames;
    this.endpoint.postMessage(message, transfer);
  }

  /** Sends what was recorded at the end of the current task, so that changes between frames go together. */
  schedule(): void {
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      void Promise.resolve().then(() => {
        this.flush();
      });
    }
  }

  /** Throws when the device is disposed or lost. */
  ensureUsable(): void {
    if (this.disposed) {
      throw new DeviceLostError('The render device is disposed.');
    }
    if (this.lost !== undefined) {
      throw new DeviceLostError(this.lost);
    }
  }

  /** Asks the worker and waits for its answer. */
  request(op: number, target?: number): Promise<Uint8Array | undefined> {
    const id = this.nextId++;
    const answer = new Promise<Uint8Array | undefined>((resolve) => {
      this.requests.set(id, resolve);
    });
    this.writer.num(op);
    if (target !== undefined) {
      this.writer.num(target);
    }
    this.writer.num(id);
    this.flush();
    return answer;
  }

  private answer(request: number, pixels: Uint8Array | undefined): void {
    const resolve = this.requests.get(request);
    this.requests.delete(request);
    resolve?.(pixels);
  }

  private writeSize(size: PixelSize, dpiScale: number): void {
    this.writer.num(size.width);
    this.writer.num(size.height);
    this.writer.num(dpiScale);
  }
}

class RemoteBuffer implements GpuBuffer {
  readonly sizeInBytes: number;
  readonly usage: number;
  private disposed = false;

  constructor(
    private readonly device: RemoteRenderDevice,
    private readonly writer: BatchWriter,
    readonly id: number,
    desc: BufferDesc,
  ) {
    this.sizeInBytes = desc.sizeInBytes;
    this.usage = desc.usage;
  }

  write(offsetInBytes: number, data: ArrayBufferView): void {
    if (offsetInBytes < 0 || offsetInBytes + data.byteLength > this.sizeInBytes) {
      throw new RangeError('The data does not fit into the buffer.');
    }
    this.writer.op(Op.writeBuffer, this.id);
    this.writer.num(offsetInBytes);
    this.writer.payload(data);
    this.device.schedule();
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.writer.op(Op.disposeBuffer, this.id);
      this.device.schedule();
    }
  }
}

class RemoteTexture implements GpuTexture {
  private disposed = false;

  constructor(
    private readonly device: RemoteRenderDevice,
    private readonly writer: BatchWriter,
    readonly id: number,
    readonly size: PixelSize,
    readonly format: TextureFormat,
  ) {}

  write(pixels: ArrayBufferView): void {
    this.writer.op(Op.writeTexture, this.id);
    this.writer.payload(pixels);
    this.device.schedule();
  }

  writeRow(row: number, pixels: ArrayBufferView): void {
    this.writer.op(Op.writeTextureRow, this.id);
    this.writer.num(row);
    this.writer.payload(pixels);
    this.device.schedule();
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.writer.op(Op.disposeTexture, this.id);
      this.device.schedule();
    }
  }
}

class RemoteTarget implements SurfaceRenderTarget, OffscreenRenderTarget {
  private disposed = false;

  constructor(
    private readonly device: RemoteRenderDevice,
    private readonly writer: BatchWriter,
    readonly id: number,
    public size: PixelSize,
    public dpiScale: number,
  ) {}

  resize(size: PixelSize, dpiScale: number): void {
    this.size = size;
    this.dpiScale = dpiScale;
    this.writer.op(Op.resizeTarget, this.id);
    this.writer.num(size.width);
    this.writer.num(size.height);
    this.writer.num(dpiScale);
    this.device.schedule();
  }

  async readPixels(): Promise<Uint8Array> {
    const pixels = await this.device.request(Op.readPixels, this.id);
    if (!pixels) {
      throw new DeviceLostError('The render device ended before it read the pixels.');
    }
    return pixels;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.writer.op(Op.disposeTarget, this.id);
      this.device.schedule();
    }
  }
}

class RemoteFrame implements CommandList {
  constructor(
    private readonly device: RemoteRenderDevice,
    private readonly writer: BatchWriter,
    private readonly id: number,
  ) {}

  clear(color: Rgba8): void {
    this.writer.op(Op.clear, this.id);
    this.writer.color(color);
  }

  fillRectangle(bounds: PixelRect, color: Rgba8): void {
    this.writer.op(Op.fillRectangle, this.id);
    this.writer.rect(bounds);
    this.writer.color(color);
  }

  fillLinearGradient(bounds: PixelRect, startColor: Rgba8, endColor: Rgba8, vertical: boolean): void {
    this.writer.op(Op.fillLinearGradient, this.id);
    this.writer.rect(bounds);
    this.writer.color(startColor);
    this.writer.color(endColor);
    this.writer.num(vertical ? 1 : 0);
  }

  fillTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: Rgba8): void {
    this.writer.op(Op.fillTriangle, this.id);
    this.writer.num(ax);
    this.writer.num(ay);
    this.writer.num(bx);
    this.writer.num(by);
    this.writer.num(cx);
    this.writer.num(cy);
    this.writer.color(color);
  }

  fillMesh(vertices: Float32Array, count: number, clip?: PixelRect): void {
    this.writer.op(Op.fillMesh, this.id);
    this.writer.payload(vertices);
    this.writer.num(count);
    this.writer.num(clip ? 1 : 0);
    this.writer.rect(clip ?? noClip);
  }

  drawTextPlaceholder(bounds: PixelRect, color: Rgba8): void {
    this.writer.op(Op.drawTextPlaceholder, this.id);
    this.writer.rect(bounds);
    this.writer.color(color);
  }

  drawPolyline(points: GpuBuffer, firstPoint: number, pointCount: number, style: PolylineStyle): void {
    this.writer.op(Op.drawPolyline, this.id);
    this.writer.num((points as RemoteBuffer).id);
    this.writer.num(firstPoint);
    this.writer.num(pointCount);
    this.writer.object(style);
  }

  drawMarkers(markers: GpuBuffer, firstMarker: number, markerCount: number, style: MarkerStyle): void {
    this.writer.op(Op.drawMarkers, this.id);
    this.writer.num((markers as RemoteBuffer).id);
    this.writer.num(firstMarker);
    this.writer.num(markerCount);
    this.writer.object(style);
  }

  drawGlyphs(atlas: GpuTexture, glyphs: Float32Array, count: number): void {
    this.writer.op(Op.drawGlyphs, this.id);
    this.writer.num((atlas as RemoteTexture).id);
    // Only the glyphs drawn travel, not the whole reused array.
    this.writer.payload(glyphs, Math.min(glyphs.byteLength, count * glyphStride * 4));
    this.writer.num(count);
  }

  drawImage(image: GpuTexture, bounds: PixelRect): void {
    this.writer.op(Op.drawImage, this.id);
    this.writer.num((image as RemoteTexture).id);
    this.writer.rect(bounds);
  }

  drawRaster(values: GpuTexture, colormap: GpuTexture, bounds: PixelRect, style: RasterStyle): void {
    this.writer.op(Op.drawRaster, this.id);
    this.writer.num((values as RemoteTexture).id);
    this.writer.num((colormap as RemoteTexture).id);
    this.writer.rect(bounds);
    this.writer.object(style);
  }

  setQuarterTurn(sum: number | undefined): void {
    this.writer.op(Op.setQuarterTurn, this.id);
    this.writer.num(sum ?? Number.NaN);
  }

  submit(): void {
    this.writer.op(Op.submit, this.id);
    this.writer.frames++;
    this.device.flush();
  }

  dispose(): void {
    this.writer.op(Op.disposeFrame, this.id);
    this.device.schedule();
  }
}

const noClip: PixelRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Connects to a render server in a worker (`serveRenderRequests`) and resolves with its device, or with `undefined`
 * when the worker has no device to draw with.
 * @param endpoint - The worker or port of the render server.
 * @param onDispose - Called when the device is disposed, such as to end the worker.
 */
export function connectRenderWorker(
  endpoint: RenderEndpoint,
  onDispose?: () => void,
): Promise<RemoteRenderDevice | undefined> {
  return new Promise((resolve) => {
    let device: RemoteRenderDevice | undefined;
    endpoint.addEventListener('message', (event) => {
      const message = event.data as ServerMessage;
      if (device) {
        device.receive(message);
      } else if (message.type === 'ready') {
        device = new RemoteRenderDevice(endpoint, message.capabilities, onDispose);
        resolve(device);
      } else if (message.type === 'unavailable') {
        resolve(undefined);
      }
    });
    endpoint.start?.();
    endpoint.postMessage({ type: 'init' }, []);
  });
}
