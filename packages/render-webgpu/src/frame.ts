// The command list of one frame on WebGPU. As in the .NET version, commands are recorded first; submit uploads the
// corners of all flat shapes in one buffer and the uniforms of all commands in another, then encodes one render pass.
// A device keeps one frame and hands it out again, and all arrays are reused, so a frame creates no objects of its own
// beyond those WebGPU returns (encoder, pass, command buffer, view of a canvas).
import {
  BufferUsage,
  packRgba8,
  type CommandList,
  type GpuBuffer,
  type GpuTexture,
  type MarkerShape,
  type MarkerStyle,
  type PixelRect,
  type PolylineStyle,
  type RasterStyle,
  type Rgba8,
} from '@tachyon-charts/core';
import type { DeviceContext } from './context';
import { flatVertexSize, markerSize, paramsSize, PipelineCache, pointSize } from './pipelines';
import { WebGpuBuffer } from './resources';
import type { WebGpuTarget } from './targets';

const enum Kind {
  Flat,
  Polyline,
  Markers,
}

const shapeCodes: Record<MarkerShape, number> = { circle: 0, square: 1, triangle: 2, diamond: 3, cross: 4, plus: 5 };

/** One recorded command. The objects are kept and filled again in later frames. */
class Op {
  kind = Kind.Flat;
  first = 0;
  count = 0;
  buffer: GPUBuffer | undefined;
  hasClip = false;
  clipX = 0;
  clipY = 0;
  clipWidth = 0;
  clipHeight = 0;
  slot = 0;
  width = 0;
  red = 0;
  green = 0;
  blue = 0;
  alpha = 0;
  scaleX = 1;
  scaleY = 1;
  offsetX = 0;
  offsetY = 0;
  // Glow radius of a line, size scale of markers.
  extra = 0;
  // Glow intensity of a line, shape code of markers.
  extra2 = 0;
  turn: number | undefined;
}

const finite = (...values: number[]): boolean => values.every(Number.isFinite);

const packColor = packRgba8;

export class WebGpuFrame implements CommandList {
  private target: WebGpuTarget | undefined;
  private readonly pipelines: PipelineCache;
  private readonly ops: Op[] = [];
  private opCount = 0;
  private slots = 1;
  private hasClear = false;
  private readonly clearValue = { r: 0, g: 0, b: 0, a: 0 };
  private turn: number | undefined;

  // Corners of flat triangles: x, y as floats and the color as a word, three words each.
  private vertexWords = new Float32Array(3 * 1024);
  private vertexColors = new Uint32Array(this.vertexWords.buffer);
  private vertexCount = 0;
  private uniformFloats = new Float32Array(0);
  private uniformWords = new Uint32Array(0);

  private vertexBuffer: GPUBuffer | undefined;
  private uniformBuffer: GPUBuffer | undefined;
  private uniformGroup: GPUBindGroup | undefined;
  private readonly uniformStride: number;
  private readonly offset = new Uint32Array(1);
  private readonly attachment: GPURenderPassColorAttachment;
  private readonly passDescriptor: GPURenderPassDescriptor;

  constructor(private readonly device: DeviceContext) {
    this.pipelines = new PipelineCache(device.gpu);
    const alignment = device.gpu.limits.minUniformBufferOffsetAlignment;
    this.uniformStride = Math.ceil(paramsSize / alignment) * alignment;
    this.attachment = {
      view: undefined as unknown as GPUTextureView,
      loadOp: 'load',
      storeOp: 'store',
      clearValue: this.clearValue,
    };
    this.passDescriptor = { colorAttachments: [this.attachment] };
  }

  /** Whether a frame is being recorded. */
  get isActive(): boolean {
    return this.target !== undefined;
  }

  /** Starts recording a frame into the target. */
  begin(target: WebGpuTarget): this {
    if (target.size.width === 0 || target.size.height === 0) {
      throw new RangeError('A target without size gets no frames; stop drawing until it has one.');
    }
    this.target = target;
    this.reset();
    this.hasClear = false;
    this.turn = undefined;
    return this;
  }

  clear(color: Rgba8): void {
    this.ensureRecording();
    // A clear covers everything, so the commands before it have no effect.
    this.reset();
    this.hasClear = true;
    this.clearValue.r = color.r / 255;
    this.clearValue.g = color.g / 255;
    this.clearValue.b = color.b / 255;
    this.clearValue.a = color.a / 255;
  }

  fillRectangle(bounds: PixelRect, color: Rgba8): void {
    this.ensureRecording();
    if (!isDrawable(bounds)) {
      return;
    }
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    const packed = packColor(color);
    this.beginTriangle();
    this.vertex(bounds.x, bounds.y, packed);
    this.vertex(right, bounds.y, packed);
    this.vertex(right, bottom, packed);
    this.beginTriangle();
    this.vertex(bounds.x, bounds.y, packed);
    this.vertex(right, bottom, packed);
    this.vertex(bounds.x, bottom, packed);
  }

  fillLinearGradient(bounds: PixelRect, startColor: Rgba8, endColor: Rgba8, vertical: boolean): void {
    this.ensureRecording();
    if (!isDrawable(bounds)) {
      return;
    }
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    const start = packColor(startColor);
    const end = packColor(endColor);
    const topRight = vertical ? start : end;
    const bottomLeft = vertical ? end : start;
    this.beginTriangle();
    this.vertex(bounds.x, bounds.y, start);
    this.vertex(right, bounds.y, topRight);
    this.vertex(right, bottom, end);
    this.beginTriangle();
    this.vertex(bounds.x, bounds.y, start);
    this.vertex(right, bottom, end);
    this.vertex(bounds.x, bottom, bottomLeft);
  }

  fillTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: Rgba8): void {
    this.ensureRecording();
    if (finite(ax, ay, bx, by, cx, cy)) {
      const packed = packColor(color);
      this.beginTriangle();
      this.vertex(ax, ay, packed);
      this.vertex(bx, by, packed);
      this.vertex(cx, cy, packed);
    }
  }

  fillMesh(vertices: Float32Array, count: number, clip?: PixelRect): void {
    this.ensureRecording();
    const corners = Math.min(count, Math.floor(vertices.length / 3));
    const usable = corners - (corners % 3);
    if (usable <= 0) {
      return;
    }
    const op = this.nextOp(Kind.Flat);
    op.first = this.vertexCount;
    op.count = usable;
    this.setClip(op, clip);
    this.ensureVertices(usable);
    const colors = new Uint32Array(vertices.buffer, vertices.byteOffset, usable * 3);
    for (let i = 0; i < usable; i++) {
      this.vertex(vertices[i * 3] as number, vertices[i * 3 + 1] as number, colors[i * 3 + 2] as number);
    }
  }

  drawTextPlaceholder(bounds: PixelRect, color: Rgba8): void {
    this.fillRectangle(bounds, color);
  }

  drawPolyline(points: GpuBuffer, firstPoint: number, pointCount: number, style: PolylineStyle): void {
    this.ensureRecording();
    const buffer = this.vertexSource(points);
    if (pointCount < 2) {
      return;
    }
    checkRange(points, firstPoint, pointCount, pointSize);
    const op = this.nextOp(Kind.Polyline);
    op.buffer = buffer;
    op.first = firstPoint;
    op.count = pointCount;
    op.width = style.widthInPixels;
    setColor(op, style.color);
    op.scaleX = style.scaleX ?? 1;
    op.scaleY = style.scaleY ?? 1;
    op.offsetX = style.offsetX ?? 0;
    op.offsetY = style.offsetY ?? 0;
    op.extra = style.glowRadius ?? 0;
    op.extra2 = style.glowIntensity ?? 0;
    op.slot = this.slots++;
    op.turn = this.turn;
    this.setClip(op, style.clip);
  }

  drawMarkers(markers: GpuBuffer, firstMarker: number, markerCount: number, style: MarkerStyle): void {
    this.ensureRecording();
    const buffer = this.vertexSource(markers);
    if (markerCount < 1) {
      return;
    }
    checkRange(markers, firstMarker, markerCount, markerSize);
    const op = this.nextOp(Kind.Markers);
    op.buffer = buffer;
    op.first = firstMarker;
    op.count = markerCount;
    op.width = style.borderWidthInPixels;
    setColor(op, style.borderColor);
    op.scaleX = style.scaleX ?? 1;
    op.scaleY = style.scaleY ?? 1;
    op.offsetX = style.offsetX ?? 0;
    op.offsetY = style.offsetY ?? 0;
    op.extra = style.sizeScale ?? 1;
    op.extra2 = shapeCodes[style.shape];
    op.slot = this.slots++;
    op.turn = this.turn;
    this.setClip(op, style.clip);
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
    this.turn = sum;
  }

  submit(): void {
    this.ensureRecording();
    const target = this.target as WebGpuTarget;
    const gpu = this.device.gpu;
    this.uploadVertices();
    this.uploadUniforms(target);
    const pipelines = this.pipelines.get(target.format);

    const encoder = gpu.createCommandEncoder();
    this.attachment.view = target.frameView();
    this.attachment.loadOp = this.hasClear ? 'clear' : 'load';
    const pass = encoder.beginRenderPass(this.passDescriptor);
    const { width, height } = target.size;
    for (let i = 0; i < this.opCount; i++) {
      const op = this.ops[i] as Op;
      this.offset[0] = op.slot * this.uniformStride;
      pass.setBindGroup(0, this.uniformGroup as GPUBindGroup, this.offset);
      if (op.hasClip) {
        setScissor(pass, op, width, height);
      }
      if (op.kind === Kind.Flat) {
        pass.setPipeline(pipelines.flat);
        pass.setVertexBuffer(0, this.vertexBuffer as GPUBuffer);
        pass.draw(op.count, 1, op.first, 0);
      } else if (op.kind === Kind.Markers) {
        pass.setPipeline(pipelines.marker);
        pass.setVertexBuffer(0, op.buffer as GPUBuffer, op.first * markerSize, op.count * markerSize);
        pass.draw(6, op.count, 0, 0);
      } else {
        const start = op.first * pointSize;
        const bytes = (op.count - 1) * pointSize;
        pass.setVertexBuffer(0, op.buffer as GPUBuffer, start, bytes);
        pass.setVertexBuffer(1, op.buffer as GPUBuffer, start + pointSize, bytes);
        if (op.extra > 0) {
          pass.setPipeline(pipelines.glow);
          pass.draw(6, op.count - 1, 0, 0);
          this.device.drawCallCount++;
        }
        pass.setPipeline(pipelines.polyline);
        pass.draw(6, op.count - 1, 0, 0);
      }
      this.device.drawCallCount++;
      if (op.hasClip) {
        pass.setScissorRect(0, 0, width, height);
      }
    }
    pass.end();
    gpu.queue.submit([encoder.finish()]);
    this.finish();
  }

  dispose(): void {
    // Without submit the recorded commands are dropped.
    if (this.isActive) {
      this.finish();
    }
  }

  private reset(): void {
    for (let i = 0; i < this.opCount; i++) {
      (this.ops[i] as Op).buffer = undefined;
    }
    this.opCount = 0;
    this.slots = 1;
    this.vertexCount = 0;
  }

  private finish(): void {
    this.reset();
    this.target = undefined;
    this.attachment.view = undefined as unknown as GPUTextureView;
  }

  private nextOp(kind: Kind): Op {
    let op = this.ops[this.opCount];
    if (!op) {
      op = new Op();
      this.ops.push(op);
    }
    this.opCount++;
    op.kind = kind;
    op.slot = 0;
    op.count = 0;
    op.hasClip = false;
    op.turn = undefined;
    return op;
  }

  /** Makes room for one more flat triangle; the three corners follow with {@link vertex}. */
  private beginTriangle(): void {
    // Neighboring triangles share one draw call.
    const last = this.opCount > 0 ? this.ops[this.opCount - 1] : undefined;
    const joins = last?.kind === Kind.Flat && !last.hasClip && last.first + last.count === this.vertexCount;
    const op = joins ? last : this.nextOp(Kind.Flat);
    if (!joins) {
      op.first = this.vertexCount;
    }
    op.count += 3;
    this.ensureVertices(3);
  }

  // Corners computed on the CPU turn at once; points the GPU transforms turn in the shader.
  private vertex(x: number, y: number, color: number): void {
    const at = this.vertexCount * 3;
    if (this.turn === undefined) {
      this.vertexWords[at] = x;
      this.vertexWords[at + 1] = y;
    } else {
      this.vertexWords[at] = this.turn - y;
      this.vertexWords[at + 1] = x;
    }
    this.vertexColors[at + 2] = color;
    this.vertexCount++;
  }

  private ensureVertices(more: number): void {
    const needed = (this.vertexCount + more) * 3;
    if (needed > this.vertexWords.length) {
      const grown = new Float32Array(Math.max(needed, this.vertexWords.length * 2));
      grown.set(this.vertexWords.subarray(0, this.vertexCount * 3));
      this.vertexWords = grown;
      this.vertexColors = new Uint32Array(grown.buffer);
    }
  }

  private setClip(op: Op, clip: PixelRect | undefined): void {
    if (!clip) {
      return;
    }
    op.hasClip = true;
    if (this.turn === undefined) {
      op.clipX = clip.x;
      op.clipY = clip.y;
      op.clipWidth = clip.width;
      op.clipHeight = clip.height;
    } else {
      op.clipX = this.turn - (clip.y + clip.height);
      op.clipY = clip.x;
      op.clipWidth = clip.height;
      op.clipHeight = clip.width;
    }
  }

  private uploadVertices(): void {
    if (this.vertexCount === 0) {
      return;
    }
    const bytes = this.vertexCount * flatVertexSize;
    if (!this.vertexBuffer || this.vertexBuffer.size < bytes) {
      const size = Math.max(bytes, (this.vertexBuffer?.size ?? 0) * 2);
      this.vertexBuffer?.destroy();
      this.vertexBuffer = this.device.gpu.createBuffer({
        size,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.gpu.queue.writeBuffer(this.vertexBuffer, 0, this.vertexWords.buffer, 0, bytes);
  }

  private uploadUniforms(target: WebGpuTarget): void {
    const words = this.uniformStride / 4;
    const needed = this.slots * words;
    if (this.uniformFloats.length < needed) {
      this.uniformFloats = new Float32Array(Math.max(needed, this.uniformFloats.length * 2));
      this.uniformWords = new Uint32Array(this.uniformFloats.buffer);
    }
    const floats = this.uniformFloats;
    const { width, height } = target.size;
    // Slot 0 serves the flat triangles: the target size is all they need.
    floats.fill(0, 0, needed);
    floats[0] = width;
    floats[1] = height;
    for (let i = 0; i < this.opCount; i++) {
      const op = this.ops[i] as Op;
      if (op.kind === Kind.Flat) {
        continue;
      }
      const at = op.slot * words;
      floats[at] = width;
      floats[at + 1] = height;
      floats[at + 2] = op.width;
      floats[at + 4] = op.red;
      floats[at + 5] = op.green;
      floats[at + 6] = op.blue;
      floats[at + 7] = op.alpha;
      floats[at + 8] = op.scaleX;
      floats[at + 9] = op.scaleY;
      floats[at + 10] = op.offsetX;
      floats[at + 11] = op.offsetY;
      floats[at + 12] = op.extra;
      if (op.kind === Kind.Markers) {
        this.uniformWords[at + 13] = op.extra2;
      } else {
        floats[at + 13] = op.extra2;
      }
      if (op.turn !== undefined) {
        floats[at + 32] = 1;
        floats[at + 33] = op.turn;
      }
    }
    const bytes = this.slots * this.uniformStride;
    if (!this.uniformBuffer || this.uniformBuffer.size < bytes) {
      const size = Math.max(bytes, (this.uniformBuffer?.size ?? 0) * 2);
      this.uniformBuffer?.destroy();
      this.uniformBuffer = this.device.gpu.createBuffer({
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uniformGroup = this.device.gpu.createBindGroup({
        layout: this.pipelines.uniformLayout,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, size: paramsSize } }],
      });
    }
    this.device.gpu.queue.writeBuffer(this.uniformBuffer, 0, floats.buffer, 0, bytes);
  }

  private vertexSource(buffer: GpuBuffer): GPUBuffer {
    if (!(buffer instanceof WebGpuBuffer) || buffer.device !== this.device) {
      throw new TypeError('The buffer belongs to another device.');
    }
    if ((buffer.usage & BufferUsage.vertex) === 0) {
      throw new TypeError('The buffer was not created for vertex data.');
    }
    buffer.ensureUsable();
    return buffer.buffer;
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

function isDrawable(bounds: PixelRect): boolean {
  return finite(bounds.x, bounds.y, bounds.width, bounds.height) && bounds.width > 0 && bounds.height > 0;
}

function setColor(op: Op, color: Rgba8): void {
  op.red = color.r / 255;
  op.green = color.g / 255;
  op.blue = color.b / 255;
  op.alpha = color.a / 255;
}

function checkRange(buffer: GpuBuffer, first: number, count: number, size: number): void {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    first < 0 ||
    (first + count) * size > buffer.sizeInBytes
  ) {
    throw new RangeError(
      `${String(count)} elements from ${String(first)} do not fit into a buffer of ${String(buffer.sizeInBytes)} bytes.`,
    );
  }
}

function setScissor(pass: GPURenderPassEncoder, op: Op, width: number, height: number): void {
  const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
  const left = clamp(Math.floor(op.clipX), 0, width);
  const top = clamp(Math.floor(op.clipY), 0, height);
  const right = clamp(Math.ceil(op.clipX + op.clipWidth), left, width);
  const bottom = clamp(Math.ceil(op.clipY + op.clipHeight), top, height);
  pass.setScissorRect(left, top, right - left, bottom - top);
}
