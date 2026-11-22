// The command list of one frame on WebGL 2, as the one of the WebGPU package: commands are recorded first; submit
// uploads the corners of all flat shapes in one buffer and the uniforms of all commands in another, then draws. The
// uniforms have the layout of the WGSL shaders. A device keeps one frame and hands it out again, and all arrays are
// reused, so a frame creates no objects of its own.
import {
  BufferUsage,
  packRgba8,
  wordsOf,
  type CommandList,
  type GpuBuffer,
  type GpuTexture,
  type MarkerShape,
  type MarkerStyle,
  type PixelRect,
  type PolylineStyle,
  type RasterReduction,
  type RasterStyle,
  type Rgba8,
} from '@tachyon-charts/core';
import type { GlContext } from './context';
import {
  createPrograms,
  flatVertexSize,
  glyphSize,
  markerSize,
  paramsSize,
  pointAttributes,
  pointSize,
  type Program,
  type Programs,
} from './programs';
import { WebGlBuffer, WebGlTexture } from './resources';
import type { WebGlTarget } from './targets';

const enum Kind {
  Flat,
  Polyline,
  Markers,
  Glyphs,
  Raster,
}

const reductionCodes: Record<RasterReduction, number> = { nearest: 0, mean: 1, maximum: 2 };
const shapeCodes: Record<MarkerShape, number> = { circle: 0, square: 1, triangle: 2, diamond: 3, cross: 4, plus: 5 };

/** One recorded command. The objects are kept and filled again in later frames. */
class Op {
  kind = Kind.Flat;
  first = 0;
  count = 0;
  buffer: WebGLBuffer | undefined;
  texture: WebGlTexture | undefined;
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
  // The table of colors and the style of a raster.
  colormap: WebGlTexture | undefined;
  raster: RasterStyle | undefined;
}

const finite = (...values: number[]): boolean => values.every(Number.isFinite);

const packColor = packRgba8;

export class WebGlFrame implements CommandList {
  private target: WebGlTarget | undefined;
  private readonly programs: Programs;
  private readonly ops: Op[] = [];
  private opCount = 0;
  private slots = 1;
  private hasClear = false;
  private clearRed = 0;
  private clearGreen = 0;
  private clearBlue = 0;
  private clearAlpha = 0;
  private turn: number | undefined;

  // Corners of flat triangles: x, y as floats and the color as a word, three words each.
  private vertexWords = new Float32Array(3 * 1024);
  private vertexColors = new Uint32Array(this.vertexWords.buffer);
  private vertexCount = 0;
  private uniformFloats = new Float32Array(0);
  private uniformWords = new Uint32Array(0);

  // Glyphs of the frame, 13 words each, copied as they come.
  private glyphWords = new Float32Array(13 * 256);
  private glyphCount = 0;
  private readonly glyphBuffer: WebGLBuffer;
  private glyphBufferSize = 0;
  private readonly vertexBuffer: WebGLBuffer;
  private vertexBufferSize = 0;
  private readonly uniformBuffer: WebGLBuffer;
  private uniformBufferSize = 0;
  private readonly uniformStride: number;

  constructor(private readonly device: GlContext) {
    const gl = device.gl;
    this.programs = createPrograms(gl);
    const alignment = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number;
    this.uniformStride = Math.ceil(paramsSize / alignment) * alignment;
    this.glyphBuffer = gl.createBuffer();
    this.vertexBuffer = gl.createBuffer();
    this.uniformBuffer = gl.createBuffer();
  }

  /** Whether a frame is being recorded. */
  get isActive(): boolean {
    return this.target !== undefined;
  }

  /** Starts recording a frame into the target. */
  begin(target: WebGlTarget): this {
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
    this.clearRed = color.r / 255;
    this.clearGreen = color.g / 255;
    this.clearBlue = color.b / 255;
    this.clearAlpha = color.a / 255;
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
    const colors = wordsOf(vertices);
    const base = vertices.byteOffset / 4;
    for (let i = 0; i < usable; i++) {
      this.vertex(vertices[i * 3] as number, vertices[i * 3 + 1] as number, colors[base + i * 3 + 2] as number);
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
    this.ensureRecording();
    this.textureSource(atlas);
    const usable = Math.min(count, Math.floor(glyphs.length / 13));
    if (usable <= 0) {
      return;
    }
    const op = this.nextOp(Kind.Glyphs);
    op.texture = atlas as WebGlTexture;
    op.first = this.glyphCount;
    op.count = usable;
    const needed = (this.glyphCount + usable) * 13;
    if (needed > this.glyphWords.length) {
      const grown = new Float32Array(Math.max(needed, this.glyphWords.length * 2));
      grown.set(this.glyphWords.subarray(0, this.glyphCount * 13));
      this.glyphWords = grown;
    }
    // Copied as words, so that the color keeps its bits.
    const source = wordsOf(glyphs);
    const start = glyphs.byteOffset / 4;
    const target = wordsOf(this.glyphWords);
    const into = this.glyphCount * 13;
    for (let k = 0; k < usable * 13; k++) {
      target[into + k] = source[start + k] as number;
    }
    this.glyphCount += usable;
  }

  drawImage(image: GpuTexture, bounds: PixelRect): void {
    this.ensureRecording();
    throw new Error(
      `The WebGL frame cannot draw images yet, as the WebGPU frame (${String(image.size.width)} × ${String(bounds.width)}).`,
    );
  }

  drawRaster(values: GpuTexture, colormap: GpuTexture, bounds: PixelRect, style: RasterStyle): void {
    this.ensureRecording();
    this.textureSource(values);
    this.textureSource(colormap);
    const op = this.nextOp(Kind.Raster);
    op.texture = values as WebGlTexture;
    op.colormap = colormap as WebGlTexture;
    op.raster = style;
    op.scaleX = bounds.width;
    op.scaleY = bounds.height;
    op.offsetX = bounds.x;
    op.offsetY = bounds.y;
    op.slot = this.slots++;
    op.turn = this.turn;
  }

  setQuarterTurn(sum: number | undefined): void {
    this.ensureRecording();
    this.turn = sum;
  }

  submit(): void {
    this.ensureRecording();
    const target = this.target as WebGlTarget;
    const gl = this.device.gl;
    this.uploadVertices();
    this.uploadGlyphs();
    this.uploadUniforms(target);
    target.bind();
    const { width, height } = target.size;
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    if (this.hasClear) {
      gl.clearColor(this.clearRed, this.clearGreen, this.clearBlue, this.clearAlpha);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.enable(gl.BLEND);
    for (let i = 0; i < this.opCount; i++) {
      const op = this.ops[i] as Op;
      gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, this.uniformBuffer, op.slot * this.uniformStride, paramsSize);
      if (op.hasClip) {
        gl.enable(gl.SCISSOR_TEST);
        setScissor(gl, op, width, height);
      }
      this.draw(op);
      this.device.drawCallCount++;
      if (op.hasClip) {
        gl.disable(gl.SCISSOR_TEST);
      }
    }
    gl.bindVertexArray(null);
    gl.useProgram(null);
    target.present();
    this.finish();
  }

  dispose(): void {
    // Without submit the recorded commands are dropped.
    if (this.isActive) {
      this.finish();
    }
  }

  /** Frees the programs and buffers of the frame with its device. */
  release(): void {
    const gl = this.device.gl;
    for (const program of Object.values(this.programs) as Program[]) {
      gl.deleteProgram(program.program);
      gl.deleteVertexArray(program.vertexArray);
    }
    gl.deleteBuffer(this.glyphBuffer);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.uniformBuffer);
  }

  private draw(op: Op): void {
    const gl = this.device.gl;
    const programs = this.programs;
    blendNormally(gl);
    switch (op.kind) {
      case Kind.Flat:
        this.use(programs.flat);
        pointAttributes(gl, programs.flat, this.vertexBuffer, 0, false);
        gl.drawArrays(gl.TRIANGLES, op.first, op.count);
        break;
      case Kind.Glyphs:
        this.use(programs.text);
        bindTexture(gl, 0, op.texture as WebGlTexture);
        pointAttributes(gl, programs.text, this.glyphBuffer, op.first * glyphSize, true);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, op.count);
        break;
      case Kind.Raster:
        this.use(programs.raster);
        bindTexture(gl, 0, op.texture as WebGlTexture);
        bindTexture(gl, 1, op.colormap as WebGlTexture);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        break;
      case Kind.Markers:
        this.use(programs.marker);
        pointAttributes(gl, programs.marker, op.buffer as WebGLBuffer, op.first * markerSize, true);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, op.count);
        break;
      default:
        this.drawPolylineOp(op);
    }
  }

  // The glow first, with a maximum blend, then the line; each segment is an instance on two views of the points.
  private drawPolylineOp(op: Op): void {
    const gl = this.device.gl;
    const start = op.first * pointSize;
    if (op.extra > 0) {
      this.use(this.programs.glow);
      pointAttributes(gl, this.programs.glow, op.buffer as WebGLBuffer, start, true);
      // The glow of neighboring segments overlaps; the maximum keeps it from adding up.
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, op.count - 1);
      this.device.drawCallCount++;
      blendNormally(gl);
    }
    this.use(this.programs.polyline);
    pointAttributes(gl, this.programs.polyline, op.buffer as WebGLBuffer, start, true);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, op.count - 1);
  }

  private use(program: Program): void {
    this.device.gl.useProgram(program.program);
    this.device.gl.bindVertexArray(program.vertexArray);
  }

  private reset(): void {
    for (let i = 0; i < this.opCount; i++) {
      const op = this.ops[i] as Op;
      op.buffer = undefined;
      op.texture = undefined;
      op.colormap = undefined;
      op.raster = undefined;
    }
    this.opCount = 0;
    this.slots = 1;
    this.vertexCount = 0;
    this.glyphCount = 0;
  }

  private finish(): void {
    this.reset();
    this.target = undefined;
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

  // A buffer grows to twice its size when it is too small, so that it is seldom made anew.
  private upload(buffer: WebGLBuffer, size: number, data: Float32Array, bytes: number, target: number): number {
    const gl = this.device.gl;
    gl.bindBuffer(target, buffer);
    let capacity = size;
    if (capacity < bytes) {
      capacity = Math.max(bytes, capacity * 2);
      gl.bufferData(target, capacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(target, 0, data, 0, bytes / 4);
    gl.bindBuffer(target, null);
    return capacity;
  }

  private uploadGlyphs(): void {
    if (this.glyphCount > 0) {
      const gl = this.device.gl;
      const bytes = this.glyphCount * glyphSize;
      this.glyphBufferSize = this.upload(
        this.glyphBuffer,
        this.glyphBufferSize,
        this.glyphWords,
        bytes,
        gl.ARRAY_BUFFER,
      );
    }
  }

  private uploadVertices(): void {
    if (this.vertexCount > 0) {
      const gl = this.device.gl;
      const bytes = this.vertexCount * flatVertexSize;
      this.vertexBufferSize = this.upload(
        this.vertexBuffer,
        this.vertexBufferSize,
        this.vertexWords,
        bytes,
        gl.ARRAY_BUFFER,
      );
    }
  }

  // The fields of the raster shader in the shared layout of the parameters.
  private rasterUniforms(at: number, style: RasterStyle): void {
    const floats = this.uniformFloats;
    floats[at + 2] = style.isInterpolated === true ? 1 : 0;
    floats[at + 4] = reductionCodes[style.reduction ?? 'nearest'];
    floats[at + 12] = style.isLogarithmic === true ? 1 : 0;
    this.uniformWords[at + 13] = style.rowShift ?? 0;
    floats[at + 14] = style.minimum;
    floats[at + 15] = style.maximum;
    floats[at + 16] = style.sectionX ?? 0;
    floats[at + 17] = style.sectionY ?? 0;
    floats[at + 18] = style.sectionWidth ?? 1;
    floats[at + 19] = style.sectionHeight ?? 1;
    setUniformColor(floats, at + 20, style.missingColor ?? { r: 0, g: 0, b: 0, a: 0 });
    setUniformColor(floats, at + 24, style.belowColor);
    setUniformColor(floats, at + 28, style.aboveColor);
  }

  private uploadUniforms(target: WebGlTarget): void {
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
      if (op.kind !== Kind.Flat) {
        this.opUniforms(op, op.slot * words, width, height);
      }
    }
    const gl = this.device.gl;
    this.uniformBufferSize = this.upload(
      this.uniformBuffer,
      this.uniformBufferSize,
      floats,
      this.slots * this.uniformStride,
      gl.UNIFORM_BUFFER,
    );
  }

  private opUniforms(op: Op, at: number, width: number, height: number): void {
    const floats = this.uniformFloats;
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
    if (op.kind === Kind.Raster && op.raster) {
      this.rasterUniforms(at, op.raster);
    }
    if (op.turn !== undefined) {
      floats[at + 32] = 1;
      floats[at + 33] = op.turn;
    }
  }

  private vertexSource(buffer: GpuBuffer): WebGLBuffer {
    if (!(buffer instanceof WebGlBuffer) || buffer.device !== this.device) {
      throw new TypeError('The buffer belongs to another device.');
    }
    if ((buffer.usage & BufferUsage.vertex) === 0) {
      throw new TypeError('The buffer was not created for vertex data.');
    }
    buffer.ensureUsable();
    return buffer.buffer;
  }

  private textureSource(texture: GpuTexture): void {
    if (!(texture instanceof WebGlTexture) || texture.device !== this.device) {
      throw new TypeError('The texture belongs to another device.');
    }
    texture.ensureUsable();
  }

  private ensureRecording(): void {
    if (!this.target) {
      throw new Error('The frame is not recording: it was submitted or disposed.');
    }
    this.target.ensureUsable();
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

// A color of the raster style; -1 in every channel stands for the end of the table.
function setUniformColor(floats: Float32Array, at: number, value: Rgba8 | undefined): void {
  floats[at] = value ? value.r / 255 : -1;
  floats[at + 1] = value ? value.g / 255 : -1;
  floats[at + 2] = value ? value.b / 255 : -1;
  floats[at + 3] = value ? value.a / 255 : -1;
}

function blendNormally(gl: WebGL2RenderingContext): void {
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

function bindTexture(gl: WebGL2RenderingContext, unit: number, texture: WebGlTexture): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture.texture);
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

// WebGL counts scissor rows from the bottom; the commands count from the top.
function setScissor(gl: WebGL2RenderingContext, op: Op, width: number, height: number): void {
  const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
  const left = clamp(Math.floor(op.clipX), 0, width);
  const top = clamp(Math.floor(op.clipY), 0, height);
  const right = clamp(Math.ceil(op.clipX + op.clipWidth), left, width);
  const bottom = clamp(Math.ceil(op.clipY + op.clipHeight), top, height);
  gl.scissor(left, height - bottom, right - left, bottom - top);
}
