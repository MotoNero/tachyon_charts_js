// The command list of one frame on WebGPU. A device keeps one and hands it out for every frame, so that frames do not
// create objects of their own beyond those WebGPU itself returns (encoder, pass, command buffer).
import type {
  CommandList,
  GpuBuffer,
  GpuTexture,
  MarkerStyle,
  PixelRect,
  PolylineStyle,
  RasterStyle,
  Rgba8,
} from '@tachyon-charts/core';
import type { DeviceContext } from './context';
import type { WebGpuTarget } from './targets';

export class WebGpuFrame implements CommandList {
  private target: WebGpuTarget | undefined;
  private encoder: GPUCommandEncoder | undefined;
  private pass: GPURenderPassEncoder | undefined;
  private view: GPUTextureView | undefined;
  private quarterTurn: number | undefined;
  // Reused for every pass: WebGPU copies the descriptor when the pass begins.
  private readonly clearValue = { r: 0, g: 0, b: 0, a: 0 };
  private readonly attachment: GPURenderPassColorAttachment;
  private readonly passDescriptor: GPURenderPassDescriptor;

  constructor(private readonly device: DeviceContext) {
    this.attachment = {
      view: undefined as unknown as GPUTextureView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: this.clearValue,
    };
    this.passDescriptor = { colorAttachments: [this.attachment] };
  }

  /** Whether a frame is being recorded. */
  get isActive(): boolean {
    return this.target !== undefined;
  }

  /** The quarter turn set for the commands that follow, if any. */
  get turn(): number | undefined {
    return this.quarterTurn;
  }

  /** Starts recording a frame into the target. */
  begin(target: WebGpuTarget): this {
    if (target.size.width === 0 || target.size.height === 0) {
      throw new RangeError('A target without size gets no frames; stop drawing until it has one.');
    }
    this.target = target;
    this.view = target.frameView();
    this.encoder = this.device.gpu.createCommandEncoder();
    this.pass = undefined;
    this.quarterTurn = undefined;
    return this;
  }

  clear(color: Rgba8): void {
    this.ensureRecording();
    this.endPass();
    this.clearValue.r = color.r / 255;
    this.clearValue.g = color.g / 255;
    this.clearValue.b = color.b / 255;
    this.clearValue.a = color.a / 255;
    this.beginPass('clear');
  }

  /** The pass the drawing commands record into; one that keeps the target's content when none is open. */
  renderPass(): GPURenderPassEncoder {
    this.ensureRecording();
    return this.pass ?? this.beginPass('load');
  }

  fillRectangle(bounds: PixelRect, color: Rgba8): void {
    this.notYet('rectangles', bounds, color);
  }

  fillLinearGradient(bounds: PixelRect, startColor: Rgba8, endColor: Rgba8, vertical: boolean): void {
    this.notYet('gradients', bounds, startColor, endColor, vertical);
  }

  fillTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: Rgba8): void {
    this.notYet('triangles', ax, ay, bx, by, cx, cy, color);
  }

  fillMesh(vertices: Float32Array, count: number, clip?: PixelRect): void {
    this.notYet('meshes', vertices, count, clip);
  }

  drawPolyline(points: GpuBuffer, firstPoint: number, pointCount: number, style: PolylineStyle): void {
    this.notYet('lines', points, firstPoint, pointCount, style);
  }

  drawMarkers(markers: GpuBuffer, firstMarker: number, markerCount: number, style: MarkerStyle): void {
    this.notYet('markers', markers, firstMarker, markerCount, style);
  }

  drawGlyphs(atlas: GpuTexture, glyphs: Float32Array, count: number): void {
    this.notYet('glyphs', atlas, glyphs, count);
  }

  drawImage(image: GpuTexture, bounds: PixelRect): void {
    this.notYet('images', image, bounds);
  }

  drawRaster(values: GpuTexture, colormap: GpuTexture, bounds: PixelRect, style: RasterStyle): void {
    this.notYet('rasters', values, colormap, bounds, style);
  }

  setQuarterTurn(sum: number | undefined): void {
    this.ensureRecording();
    this.quarterTurn = sum;
  }

  submit(): void {
    this.ensureRecording();
    // A frame without any command still has to reach a canvas, as the transparent start of the frame.
    if (this.pass === undefined) {
      this.clearValue.r = this.clearValue.g = this.clearValue.b = this.clearValue.a = 0;
      this.beginPass('clear');
    }
    this.endPass();
    const encoder = this.encoder;
    this.finish();
    if (encoder) {
      this.device.gpu.queue.submit([encoder.finish()]);
    }
  }

  dispose(): void {
    // Without submit the recorded commands are dropped with the encoder.
    if (this.isActive) {
      this.endPass();
      this.finish();
    }
  }

  private beginPass(loadOp: GPULoadOp): GPURenderPassEncoder {
    this.attachment.view = this.view as GPUTextureView;
    this.attachment.loadOp = loadOp;
    this.pass = (this.encoder as GPUCommandEncoder).beginRenderPass(this.passDescriptor);
    return this.pass;
  }

  private endPass(): void {
    this.pass?.end();
    this.pass = undefined;
  }

  private finish(): void {
    this.target = undefined;
    this.encoder = undefined;
    this.view = undefined;
    this.attachment.view = undefined as unknown as GPUTextureView;
  }

  private ensureRecording(): void {
    if (!this.target) {
      throw new Error('The frame is not recording: it was submitted or disposed.');
    }
    this.target.ensureUsable();
  }

  private notYet(what: string, ...ignored: unknown[]): never {
    this.ensureRecording();
    throw new Error(`The WebGPU frame cannot draw ${what} yet (${String(ignored.length)} arguments).`);
  }
}
