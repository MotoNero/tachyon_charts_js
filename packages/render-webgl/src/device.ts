// The WebGL 2 device: one context on a canvas of its own, capabilities, loss, and the life cycle of everything created
// from it. All charts of a device share the context, so that buffers, textures and the glyph atlas serve them all.
import {
  DeviceLostError,
  type BufferDesc,
  type CommandList,
  type DeviceCapabilities,
  type GpuBuffer,
  type GpuTexture,
  type OffscreenRenderTarget,
  type PixelSize,
  type RenderDevice,
  type RenderTarget,
  type SurfaceHandle,
  type SurfaceRenderTarget,
  type TextureDesc,
} from '@tachyon-charts/core';
import { WebGlFrame } from './frame';
import { WebGlBuffer, WebGlTexture } from './resources';
import { WebGlOffscreenTarget, WebGlSurfaceTarget, WebGlTarget } from './targets';

/** Options for {@link createWebGl2Device}. */
export interface WebGl2DeviceOptions {
  /** Which GPU to prefer; the fast one when left out. */
  readonly powerPreference?: WebGLPowerPreference;
  /** The canvas the context lives on; a new OffscreenCanvas when left out. */
  readonly canvas?: OffscreenCanvas;
}

// The largest buffer: WebGL names no limit, typed arrays end below 2 GiB on some engines.
const largestBuffer = 2 ** 31 - 4;

// Most errors repeat every frame; a few are enough to see what went wrong.
const keptErrors = 20;

/**
 * Creates a WebGL 2 device.
 * @returns The device, or `undefined` when the browser has no WebGL 2 or no OffscreenCanvas; callers then fall back.
 */
export function createWebGl2Device(options: WebGl2DeviceOptions = {}): WebGl2Device | undefined {
  if (!options.canvas && typeof OffscreenCanvas !== 'function') {
    return undefined;
  }
  const canvas = options.canvas ?? new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: options.powerPreference ?? 'high-performance',
  });
  if (!gl) {
    return undefined;
  }
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  const capabilities: DeviceCapabilities = {
    backendName: renderer === '' ? 'WebGL 2' : `WebGL 2 (${renderer})`,
    supportsCompute: false,
    maxBufferSize: largestBuffer,
    maxTextureDimension: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxSampleCount: gl.getParameter(gl.MAX_SAMPLES) as number,
  };
  return new WebGl2Device(gl, canvas, capabilities);
}

/** A {@link @tachyon-charts/core#RenderDevice} on WebGL 2. Create it with {@link createWebGl2Device}. */
export class WebGl2Device implements RenderDevice {
  private disposed = false;
  private lost: string | undefined;
  private readonly lostListeners = new Set<(reason: string) => void>();
  private readonly reported: string[] = [];
  private readonly frame: WebGlFrame;

  /** Draw calls issued so far. */
  drawCallCount = 0;

  /** Bytes written to buffers and textures so far. */
  uploadedByteCount = 0;

  /**
   * @param gl - The WebGL 2 context; the other parts of this package draw with it.
   * @param canvas - The canvas of the context.
   * @param capabilities - What the device supports.
   */
  constructor(
    /** The WebGL 2 context; the other parts of this package draw with it. */
    readonly gl: WebGL2RenderingContext,
    /** The canvas of the context; surface targets show what is drawn on it. */
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    /** What the device supports. */
    readonly capabilities: DeviceCapabilities,
  ) {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    this.frame = new WebGlFrame(this);
    canvas.addEventListener('webglcontextlost', (event) => {
      // Without preventDefault the context could not come back; a lost device stays lost, but the event is handled.
      event.preventDefault();
      if (!this.disposed) {
        this.markLost('The WebGL context was lost.');
      }
    });
  }

  /** Whether the device was lost; it then refuses all work. */
  get isLost(): boolean {
    return this.lost !== undefined;
  }

  /** Why the device was lost, `undefined` while it works. */
  get lostReason(): string | undefined {
    return this.lost;
  }

  /** The errors WebGL reported so far (at most 20), for diagnostics and tests; reading it asks the driver. */
  get errors(): readonly string[] {
    if (!this.disposed && this.lost === undefined) {
      for (let error = this.gl.getError(); error !== this.gl.NO_ERROR; error = this.gl.getError()) {
        if (this.reported.length < keptErrors) {
          this.reported.push(`WebGL error 0x${error.toString(16)}`);
        }
      }
    }
    return this.reported;
  }

  /** Calls the listener once when the device is lost, at once if it is lost already; returns a function that removes it. */
  onLost(listener: (reason: string) => void): () => void {
    if (this.lost !== undefined) {
      listener(this.lost);
      return () => undefined;
    }
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /** Loses the device on purpose, to test what an application does then. */
  simulateLoss(): void {
    this.ensureNotDisposed();
    this.markLost('The device loss was simulated.');
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** Creates a buffer in GPU memory. */
  createBuffer(desc: BufferDesc): GpuBuffer {
    this.ensureUsable();
    return new WebGlBuffer(this, desc.sizeInBytes, desc.usage);
  }

  /** Creates a texture. */
  createTexture(desc: TextureDesc): GpuTexture {
    this.ensureUsable();
    return new WebGlTexture(this, desc.size, desc.format);
  }

  /** Creates a target that is not on screen; its content can be read back. */
  createOffscreenTarget(size: PixelSize, dpiScale: number): OffscreenRenderTarget {
    this.ensureUsable();
    return new WebGlOffscreenTarget(this, size, dpiScale);
  }

  /** Creates a target that shows its frames on a canvas. */
  createSurfaceTarget(surface: SurfaceHandle, size: PixelSize, dpiScale: number): SurfaceRenderTarget {
    this.ensureUsable();
    return new WebGlSurfaceTarget(this, surface, size, dpiScale);
  }

  /** Starts recording a frame for a target of this device. */
  beginFrame(target: RenderTarget): CommandList {
    this.ensureUsable();
    if (!(target instanceof WebGlTarget) || target.device !== this) {
      throw new TypeError('The target belongs to another device.');
    }
    if (this.frame.isActive) {
      throw new Error('A frame is still being recorded; submit or dispose it first.');
    }
    target.ensureUsable();
    return this.frame.begin(target);
  }

  /** Resolves when the GPU has done all submitted work. */
  async whenIdle(): Promise<void> {
    this.ensureNotDisposed();
    if (this.lost !== undefined) {
      return;
    }
    const gl = this.gl;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      gl.finish();
      return;
    }
    gl.flush();
    try {
      while (!this.isLost && gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } finally {
      gl.deleteSync(sync);
    }
  }

  /** Frees the device and all it holds. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    if (this.lost === undefined) {
      this.frame.release();
    }
    this.disposed = true;
    this.lostListeners.clear();
    // Browsers keep only a few contexts; giving this one up frees its memory at once.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** Throws when the device is disposed or lost; every member that creates or draws calls it first. */
  ensureUsable(): void {
    this.ensureNotDisposed();
    if (this.lost !== undefined) {
      throw new DeviceLostError(this.lost);
    }
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('The render device is disposed.');
    }
  }

  private markLost(reason: string): void {
    if (this.lost !== undefined) {
      return;
    }
    this.lost = reason;
    const listeners = [...this.lostListeners];
    this.lostListeners.clear();
    for (const listener of listeners) {
      listener(reason);
    }
  }
}
