// The render server in a worker: it creates the real device, replays the batches of a RemoteRenderDevice on it and
// reports back what the main thread needs (pixels, idle, counters, the time of a frame, loss and errors).
import type { CommandList, MarkerStyle, PolylineStyle, RasterStyle } from './commands';
import type { OffscreenRenderTarget, RenderDevice, RenderTarget, SurfaceRenderTarget } from './device';
import { Op, type BatchMessage, type RenderEndpoint, type ServerMessage } from './remote-protocol';
import type { GpuBuffer, GpuTexture } from './resources';
import type { PixelRect, Rgba8, TextureFormat } from './types';

interface Clock {
  now(): number;
}

// Workers have performance; the core does not know the DOM, so it asks the global scope.
const clock = (globalThis as { performance?: Clock }).performance ?? Date;

/** What a server holds for its device: resources, targets and open frames by their id. */
class Replay {
  readonly buffers = new Map<number, GpuBuffer>();
  readonly textures = new Map<number, GpuTexture>();
  readonly targets = new Map<number, RenderTarget>();
  readonly frames = new Map<number, CommandList>();
  private ops: Float64Array = new Float64Array(0);
  private arena: Uint8Array = new Uint8Array(0);
  private objects: readonly unknown[] = [];
  private at = 0;

  constructor(
    private readonly device: RenderDevice,
    private readonly send: (message: ServerMessage, transfer?: object[]) => void,
  ) {}

  run(batch: BatchMessage): void {
    this.ops = batch.ops;
    this.arena = batch.arena;
    this.objects = batch.objects;
    this.at = 0;
    while (this.at < this.ops.length) {
      this.step(this.num());
    }
  }

  private num(): number {
    return this.ops[this.at++] ?? 0;
  }

  private object(): unknown {
    return this.objects[this.num()];
  }

  private rect(): PixelRect {
    return { x: this.num(), y: this.num(), width: this.num(), height: this.num() };
  }

  private color(): Rgba8 {
    return { r: this.num(), g: this.num(), b: this.num(), a: this.num() };
  }

  // The bytes of a payload, without a copy.
  private bytes(): Uint8Array {
    const source = this.num();
    const offset = this.num();
    const length = this.num();
    return source < 0
      ? new Uint8Array(this.arena.buffer, this.arena.byteOffset + offset, length)
      : new Uint8Array(this.objects[source] as ArrayBuffer, offset, length);
  }

  private floats(): Float32Array {
    const bytes = this.bytes();
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  private frame(): CommandList {
    const frame = this.frames.get(this.num());
    if (!frame) {
      throw new Error('The batch refers to a frame that is not open.');
    }
    return frame;
  }

  private buffer(): GpuBuffer {
    const buffer = this.buffers.get(this.num());
    if (!buffer) {
      throw new Error('The batch refers to a buffer that does not exist.');
    }
    return buffer;
  }

  private texture(): GpuTexture {
    const texture = this.textures.get(this.num());
    if (!texture) {
      throw new Error('The batch refers to a texture that does not exist.');
    }
    return texture;
  }

  private target(): RenderTarget {
    const target = this.targets.get(this.num());
    if (!target) {
      throw new Error('The batch refers to a target that does not exist.');
    }
    return target;
  }

  private size(): { width: number; height: number } {
    return { width: this.num(), height: this.num() };
  }

  // One operation; the order of the reads is the order the remote device wrote the numbers.
  private step(op: number): void {
    switch (op) {
      case Op.createBuffer: {
        const id = this.num();
        this.buffers.set(id, this.device.createBuffer({ sizeInBytes: this.num(), usage: this.num() }));
        break;
      }
      case Op.writeBuffer: {
        const buffer = this.buffer();
        const offset = this.num();
        buffer.write(offset, this.bytes());
        break;
      }
      case Op.disposeBuffer: {
        const id = this.num();
        this.buffers.get(id)?.dispose();
        this.buffers.delete(id);
        break;
      }
      case Op.createTexture: {
        const id = this.num();
        const size = this.size();
        this.textures.set(id, this.device.createTexture({ size, format: this.object() as TextureFormat }));
        break;
      }
      case Op.writeTexture:
        this.texture().write(this.bytes());
        break;
      case Op.writeTextureRow: {
        const texture = this.texture();
        const row = this.num();
        texture.writeRow(row, this.bytes());
        break;
      }
      case Op.disposeTexture: {
        const id = this.num();
        this.textures.get(id)?.dispose();
        this.textures.delete(id);
        break;
      }
      case Op.createSurfaceTarget: {
        const id = this.num();
        const size = this.size();
        const dpi = this.num();
        this.targets.set(id, this.device.createSurfaceTarget({ kind: 'canvas', canvas: this.object() }, size, dpi));
        break;
      }
      case Op.createOffscreenTarget: {
        const id = this.num();
        const size = this.size();
        this.targets.set(id, this.device.createOffscreenTarget(size, this.num()));
        break;
      }
      case Op.resizeTarget: {
        const target = this.target() as SurfaceRenderTarget;
        const size = this.size();
        target.resize(size, this.num());
        break;
      }
      case Op.disposeTarget: {
        const id = this.num();
        this.targets.get(id)?.dispose();
        this.targets.delete(id);
        break;
      }
      case Op.beginFrame: {
        const id = this.num();
        this.frames.set(id, this.device.beginFrame(this.target()));
        break;
      }
      default:
        this.drawStep(op);
    }
  }

  private drawStep(op: number): void {
    switch (op) {
      case Op.clear:
        this.frame().clear(this.color());
        break;
      case Op.fillRectangle:
        this.frame().fillRectangle(this.rect(), this.color());
        break;
      case Op.fillLinearGradient:
        this.frame().fillLinearGradient(this.rect(), this.color(), this.color(), this.num() !== 0);
        break;
      case Op.fillTriangle:
        this.frame().fillTriangle(this.num(), this.num(), this.num(), this.num(), this.num(), this.num(), this.color());
        break;
      case Op.fillMesh: {
        const frame = this.frame();
        const vertices = this.floats();
        const count = this.num();
        const hasClip = this.num() !== 0;
        const clip = this.rect();
        frame.fillMesh(vertices, count, hasClip ? clip : undefined);
        break;
      }
      case Op.drawTextPlaceholder:
        this.frame().drawTextPlaceholder(this.rect(), this.color());
        break;
      case Op.drawPolyline:
        this.frame().drawPolyline(this.buffer(), this.num(), this.num(), this.object() as PolylineStyle);
        break;
      case Op.drawMarkers:
        this.frame().drawMarkers(this.buffer(), this.num(), this.num(), this.object() as MarkerStyle);
        break;
      case Op.drawGlyphs:
        this.frame().drawGlyphs(this.texture(), this.floats(), this.num());
        break;
      case Op.drawImage:
        this.frame().drawImage(this.texture(), this.rect());
        break;
      case Op.drawRaster:
        this.frame().drawRaster(this.texture(), this.texture(), this.rect(), this.object() as RasterStyle);
        break;
      case Op.setQuarterTurn: {
        const frame = this.frame();
        const sum = this.num();
        frame.setQuarterTurn(Number.isNaN(sum) ? undefined : sum);
        break;
      }
      case Op.submit:
        this.frame().submit();
        break;
      case Op.disposeFrame: {
        const id = this.num();
        this.frames.get(id)?.dispose();
        this.frames.delete(id);
        break;
      }
      default:
        this.requestStep(op);
    }
  }

  private requestStep(op: number): void {
    switch (op) {
      case Op.readPixels: {
        const target = this.target() as OffscreenRenderTarget;
        const request = this.num();
        void target.readPixels().then((pixels) => {
          this.send({ type: 'pixels', request, pixels }, [pixels.buffer]);
        });
        break;
      }
      case Op.whenIdle: {
        const request = this.num();
        void this.device.whenIdle().then(() => {
          this.send({ type: 'idle', request });
        });
        break;
      }
      case Op.simulateLoss:
        this.device.simulateLoss();
        break;
      case Op.dispose:
        this.dispose();
        break;
      default:
        throw new Error(`Unknown render operation ${String(op)}.`);
    }
  }

  dispose(): void {
    for (const frame of this.frames.values()) {
      frame.dispose();
    }
    for (const target of this.targets.values()) {
      target.dispose();
    }
    for (const texture of this.textures.values()) {
      texture.dispose();
    }
    for (const buffer of this.buffers.values()) {
      buffer.dispose();
    }
    this.frames.clear();
    this.targets.clear();
    this.textures.clear();
    this.buffers.clear();
    this.device.dispose();
  }
}

/**
 * Serves a `RemoteRenderDevice` from a worker: creates the device with `createDevice` when the main thread connects
 * and replays its batches. Call it in the module of the worker with its global scope as endpoint.
 */
export function serveRenderRequests(
  endpoint: RenderEndpoint,
  createDevice: () => Promise<RenderDevice | undefined>,
): void {
  let replay: Replay | undefined;
  let device: RenderDevice | undefined;
  const send = (message: ServerMessage, transfer: object[] = []): void => {
    endpoint.postMessage(message, transfer);
  };
  endpoint.addEventListener('message', (event) => {
    const message = event.data as { readonly type?: string };
    if (message.type === 'init') {
      void createDevice().then(
        (created) => {
          if (!created) {
            send({ type: 'unavailable', reason: 'The worker has no device to draw with.' });
            return;
          }
          device = created;
          replay = new Replay(created, send);
          created.onLost((reason) => {
            send({ type: 'lost', reason });
          });
          send({ type: 'ready', capabilities: { ...created.capabilities } });
        },
        (error: unknown) => {
          send({ type: 'unavailable', reason: String(error) });
        },
      );
    } else if (message.type === 'batch' && replay && device) {
      const batch = message as BatchMessage;
      const start = clock.now();
      try {
        replay.run(batch);
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      send({
        type: 'done',
        frames: batch.frames,
        drawCalls: device.drawCallCount,
        uploadedBytes: device.uploadedByteCount,
        milliseconds: clock.now() - start,
      });
    }
  });
  endpoint.start?.();
}
