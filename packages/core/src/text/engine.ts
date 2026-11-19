// Text for every backend, as the text engine of the .NET version: the shaper places the glyphs, the font file gives
// their outlines, and a distance field of each glyph goes into one atlas shared by all fonts. The same font files and
// the same single-precision arithmetic give the same atlas and the same glyph quads as .NET, bit for bit.
import { glyphStride } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuTexture } from '../render/resources';
import { packRgba8, wordsOf, type Rgba8 } from '../render/types';
import { FontFile } from './font';
import { generateMsdf } from './msdf';
import { Outlines, type Contour } from './outlines';
import { Shaper, type ShapedGlyph } from './shaper';

const f = Math.fround;

/** Width and height of the atlas in pixels. */
export const atlasSize = 1024;
const fieldEmSize = 40;
const fieldRange = 4;
const curveSegments = 8;
// The slant of an italic made from an upright cut: the share of the height the top leans to the right.
const syntheticSlant = f(0.2);
const maximumShapedTexts = 4096;

/** The look of a text: a family the engine knows, or the default font, in bold or italic. */
export interface TextFont {
  /** The name of a family added with `addFont`; the default font when left out. */
  readonly family?: string;
  /** Whether the bold face is used. */
  readonly bold?: boolean;
  /** Whether the italic face is used. */
  readonly italic?: boolean;
}

/** How a text is set: its em size in pixels, its color and its font. Keep the object; it is read, not kept. */
export interface TextStyle {
  /** The size in physical pixels. */
  readonly size: number;
  /** The color of the text. */
  readonly color: Rgba8;
  /** The default font when left out. */
  readonly font?: TextFont;
}

/** Rounds as MathF.Round does: halves to the even neighbor. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest !== 0.5) {
    return Math.round(value);
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

interface AtlasGlyph {
  atlasX: number;
  atlasY: number;
  width: number;
  height: number;
  left: number;
  top: number;
}

const noGlyph: AtlasGlyph = { atlasX: 0, atlasY: 0, width: 0, height: 0, left: 0, top: 0 };

/** One font file with its shaping, its outlines and the glyphs it has in the atlas. */
class FontFace {
  readonly font: FontFile;
  readonly shaper: Shaper;
  readonly outlines: Outlines;
  readonly lineHeightPerEm: number;
  readonly glyphs = new Map<number, AtlasGlyph>();
  private readonly shaped = new Map<string, ShapedGlyph[]>();

  constructor(
    data: ArrayBuffer | ArrayBufferView,
    readonly slant: number,
  ) {
    this.font = new FontFile(data);
    this.shaper = new Shaper(this.font);
    this.outlines = new Outlines(this.font, curveSegments);
    const font = this.font;
    this.lineHeightPerEm = f(f(font.ascender - font.descender + font.lineGap) / font.unitsPerEm);
  }

  // Shaping allocates, and overlays draw the same texts in every frame while the view changes.
  shape(text: string): ShapedGlyph[] {
    let glyphs = this.shaped.get(text);
    if (!glyphs) {
      if (this.shaped.size >= maximumShapedTexts) {
        this.shaped.clear();
      }
      glyphs = this.shaper.shape(text);
      this.shaped.set(text, glyphs);
    }
    return glyphs;
  }

  // A face that leans shifts each point to the right by its height above the baseline, where y grows downwards.
  contours(glyph: number): Contour[] {
    const contours = this.outlines.contours(glyph, fieldEmSize);
    if (this.slant !== 0) {
      for (const contour of contours) {
        for (const curve of contour) {
          for (const point of curve) {
            point.x = f(point.x - f(point.y * this.slant));
          }
        }
      }
    }
    return contours;
  }
}

/**
 * Measures and lays out text and keeps the distance field atlas of its glyphs. Fonts are given as the bytes of their
 * TrueType files; the default font is the one the engine is made with.
 */
export class TextEngine {
  /** The atlas, RGBA, {@link atlasSize} pixels square. */
  readonly atlas = new Uint8Array(atlasSize * atlasSize * 4);
  /** Grows whenever the atlas changes. */
  atlasVersion = 0;
  private readonly regular: FontFace;
  private readonly files = new Map<string, ArrayBuffer | ArrayBufferView>();
  private readonly faces = new Map<string, FontFace>();
  private readonly copies = new WeakMap<RenderDevice, { texture: GpuTexture; version: number }>();
  private shelfX = 1;
  private shelfY = 1;
  private shelfHeight = 0;

  /**
   * @param defaultFont - The bytes of the default font, regular cut.
   */
  constructor(defaultFont: ArrayBuffer | ArrayBufferView) {
    this.regular = new FontFace(defaultFont, 0);
  }

  /**
   * Adds a cut of a family. A cut that is missing is the nearest one there is; italic then leans the outlines.
   * @param family - The name, compared without case.
   */
  addFont(family: string, data: ArrayBuffer | ArrayBufferView, bold = false, italic = false): void {
    this.files.set(TextEngine.key(family, bold, italic), data);
    this.faces.clear();
  }

  /** The distance between two baselines. */
  lineHeight(size: number, font?: TextFont): number {
    return f(f(size) * this.faceOf(font).lineHeightPerEm);
  }

  /** The advance of a text. */
  measureWidth(text: string, size: number, font?: TextFont): number {
    const face = this.faceOf(font);
    let advance = 0;
    for (const glyph of face.shape(text)) {
      advance += glyph.xAdvance;
    }
    return f(f(f(advance) * f(size)) / face.font.unitsPerEm);
  }

  /**
   * Writes the glyphs of a text into a glyph buffer, {@link glyphStride} values each, color as a packed word.
   * Characters seen for the first time extend the atlas.
   * @param x - The start of the baseline; it is moved to a whole pixel, as is the baseline.
   * @param y - The baseline.
   * @param style - Size, color and font.
   * @param glyphs - The buffer; it needs room for as many glyphs as the text has characters.
   * @param first - The glyph to start writing at.
   * @returns The number of glyphs written; spaces have none.
   */
  layout(text: string, x: number, y: number, style: TextStyle, glyphs: Float32Array, first = 0): number {
    if (glyphs.length < (first + text.length) * glyphStride) {
      throw new RangeError('The glyph buffer is too short for the text.');
    }
    const words = wordsOf(glyphs);
    const wordOffset = glyphs.byteOffset / 4;
    const face = this.faceOf(style.font);
    const em = face.font.unitsPerEm;
    const pixels = f(style.size);
    const scale = f(pixels / fieldEmSize);
    const distanceScale = f(2 * fieldRange * scale);
    const packed = packRgba8(style.color);
    // On whole pixels: the baseline, so that the feet of the letters stay sharp, and the start of the text, so that
    // the same text looks the same wherever it stands. The letters keep their spacing between them.
    const startX = roundHalfEven(f(x));
    const baselineY = roundHalfEven(f(y));
    let pen = 0;
    let count = 0;
    for (const glyph of face.shape(text)) {
      const atlasGlyph = this.glyphOf(face, glyph.glyph);
      if (atlasGlyph.width > 0) {
        const at = (first + count) * glyphStride;
        const gx = f(f(startX + f(f(f(pen + glyph.xOffset) * pixels) / em)) + f(atlasGlyph.left * scale));
        const gy = f(f(baselineY - f(f(f(glyph.yOffset) * pixels) / em)) + f(atlasGlyph.top * scale));
        glyphs[at] = gx;
        glyphs[at + 1] = gy;
        glyphs[at + 2] = f(atlasGlyph.width * scale);
        glyphs[at + 3] = f(atlasGlyph.height * scale);
        glyphs[at + 4] = f(atlasGlyph.atlasX / atlasSize);
        glyphs[at + 5] = f(atlasGlyph.atlasY / atlasSize);
        glyphs[at + 6] = f((atlasGlyph.atlasX + atlasGlyph.width) / atlasSize);
        glyphs[at + 7] = f((atlasGlyph.atlasY + atlasGlyph.height) / atlasSize);
        words[wordOffset + at + 8] = packed;
        glyphs[at + 9] = distanceScale;
        glyphs[at + 10] = 0;
        glyphs[at + 11] = 0;
        glyphs[at + 12] = 0;
        count++;
      }
      pen += glyph.xAdvance;
    }
    return count;
  }

  /** Whether the default font has a glyph for the character. */
  hasGlyph(character: string): boolean {
    return this.regular.font.hasGlyph(character.codePointAt(0) ?? 0);
  }

  /** The atlas as a texture of the device, brought up to date; call it after layouts and before drawing. */
  atlasOn(device: RenderDevice): GpuTexture {
    let copy = this.copies.get(device);
    if (!copy) {
      copy = {
        texture: device.createTexture({ size: { width: atlasSize, height: atlasSize }, format: 'rgba8unorm' }),
        version: -1,
      };
      this.copies.set(device, copy);
    }
    if (copy.version !== this.atlasVersion) {
      copy.texture.write(this.atlas);
      copy.version = this.atlasVersion;
    }
    return copy.texture;
  }

  /** Releases the atlas of a device that goes away. */
  releaseAtlas(device: RenderDevice): void {
    this.copies.get(device)?.texture.dispose();
    this.copies.delete(device);
  }

  private static key(family: string, bold: boolean, italic: boolean): string {
    return `${family.trim().toLowerCase()}|${bold ? 'b' : ''}${italic ? 'i' : ''}`;
  }

  // The face of a font: the cut asked for, or the nearest cut of the family leaning for italic, or the default font.
  private faceOf(font: TextFont | undefined): FontFace {
    const bold = font?.bold ?? false;
    const italic = font?.italic ?? false;
    const family = font?.family?.trim();
    if (!family && !bold && !italic) {
      return this.regular;
    }
    const key = TextEngine.key(family ?? '', bold, italic);
    let face = this.faces.get(key);
    if (!face) {
      face = this.makeFace(family ?? '', bold, italic);
      this.faces.set(key, face);
    }
    return face;
  }

  private makeFace(family: string, bold: boolean, italic: boolean): FontFace {
    const exact = this.files.get(TextEngine.key(family, bold, italic));
    if (exact) {
      return new FontFace(exact, 0);
    }
    if (italic) {
      const upright = this.files.get(TextEngine.key(family, bold, false));
      if (upright) {
        return new FontFace(upright, syntheticSlant);
      }
    }
    if (family !== '' && (bold || italic)) {
      const regular = this.files.get(TextEngine.key(family, false, false));
      if (regular) {
        return new FontFace(regular, italic ? syntheticSlant : 0);
      }
    }
    // An unknown family takes the default font in the same cut; the default font itself can only lean.
    if (family !== '') {
      return this.faceOf({ bold, italic });
    }
    return italic ? new FontFace(this.regularData(), syntheticSlant) : this.regular;
  }

  private regularData(): DataView {
    return this.regular.font.view;
  }

  private glyphOf(face: FontFace, glyph: number): AtlasGlyph {
    let atlasGlyph = face.glyphs.get(glyph);
    if (!atlasGlyph) {
      atlasGlyph = this.createGlyph(face, glyph);
      face.glyphs.set(glyph, atlasGlyph);
    }
    return atlasGlyph;
  }

  private createGlyph(face: FontFace, glyph: number): AtlasGlyph {
    const contours = face.contours(glyph);
    if (contours.length === 0) {
      return noGlyph;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const contour of contours) {
      for (const curve of contour) {
        for (const point of curve) {
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }
      }
    }
    const margin = fieldRange + 1;
    const left = Math.floor(minX) - margin;
    const top = Math.floor(minY) - margin;
    const width = Math.ceil(maxX) + margin - left;
    const height = Math.ceil(maxY) + margin - top;
    for (const contour of contours) {
      for (const curve of contour) {
        for (const point of curve) {
          point.x = f(point.x - left);
          point.y = f(point.y - top);
        }
      }
    }
    const [x, y] = this.reserve(width, height);
    generateMsdf(contours, width, height, fieldRange, this.atlas, (y * atlasSize + x) * 4, atlasSize * 4);
    this.atlasVersion++;
    return { atlasX: x, atlasY: y, width, height, left, top };
  }

  private reserve(width: number, height: number): [number, number] {
    if (this.shelfX + width + 1 > atlasSize) {
      this.shelfX = 1;
      this.shelfY += this.shelfHeight + 1;
      this.shelfHeight = 0;
    }
    if (this.shelfY + height + 1 > atlasSize) {
      throw new Error('The glyph atlas is full.');
    }
    const position: [number, number] = [this.shelfX, this.shelfY];
    this.shelfX += width + 1;
    this.shelfHeight = Math.max(this.shelfHeight, height);
    return position;
  }
}
