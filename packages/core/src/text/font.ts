// Reads the tables of a TrueType font that text needs: metrics, character map, advances, glyph classes, and the
// offsets of the outline and layout tables. All numbers in font files are big-endian.

/** A TrueType font file, read once. */
export class FontFile {
  readonly view: DataView;
  readonly unitsPerEm: number;
  readonly isLongLoca: boolean;
  /** Ascender, descender (negative) and line gap in font units, as HarfBuzz takes them. */
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly glyphCount: number;
  private readonly tables = new Map<string, number>();
  private readonly advances: Uint16Array;
  private readonly characters = new Map<number, number>();
  private readonly glyphClasses = new Map<number, number>();
  private readonly markClasses = new Map<number, number>();
  private readonly markSets: Set<number>[] = [];
  private readonly coverages = new Map<number, Map<number, number>>();
  private readonly classTables = new Map<number, Map<number, number>>();

  /**
   * @param data - The bytes of a TrueType font (`.ttf`).
   * @throws Error when the data is no TrueType font with the tables needed.
   */
  constructor(data: ArrayBuffer | ArrayBufferView) {
    this.view =
      data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
    const view = this.view;
    if (view.byteLength < 12) {
      throw new Error('The data is no font.');
    }
    const count = view.getUint16(4);
    for (let i = 0; i < count; i++) {
      const entry = 12 + i * 16;
      const tag = String.fromCodePoint(
        view.getUint8(entry),
        view.getUint8(entry + 1),
        view.getUint8(entry + 2),
        view.getUint8(entry + 3),
      );
      this.tables.set(tag, view.getUint32(entry + 8));
    }
    const head = this.require('head');
    const hhea = this.require('hhea');
    const maxp = this.require('maxp');
    this.unitsPerEm = view.getUint16(head + 18);
    this.isLongLoca = view.getInt16(head + 50) !== 0;
    this.glyphCount = view.getUint16(maxp + 4);

    // HarfBuzz takes the typographic metrics of OS/2 when the font asks for them, otherwise those of hhea.
    const os2 = this.tables.get('OS/2');
    const useTypo = os2 !== undefined && (view.getUint16(os2 + 62) & 0x80) !== 0;
    if (useTypo) {
      this.ascender = view.getInt16(os2 + 68);
      this.descender = view.getInt16(os2 + 70);
      this.lineGap = view.getInt16(os2 + 72);
    } else {
      this.ascender = view.getInt16(hhea + 4);
      this.descender = view.getInt16(hhea + 6);
      this.lineGap = view.getInt16(hhea + 8);
    }

    const metrics = view.getUint16(hhea + 34);
    const hmtx = this.require('hmtx');
    this.advances = new Uint16Array(this.glyphCount);
    let last = 0;
    for (let glyph = 0; glyph < this.glyphCount; glyph++) {
      if (glyph < metrics) {
        last = view.getUint16(hmtx + glyph * 4);
      }
      this.advances[glyph] = last;
    }
    this.readCharacterMap(this.require('cmap'));
    const gdef = this.tables.get('GDEF');
    if (gdef !== undefined) {
      this.readGlyphDefinitions(gdef);
    }
  }

  /** The offset of a table in the file, if the font has it. */
  table(tag: string): number | undefined {
    return this.tables.get(tag);
  }

  /** The glyph of a character, 0 when the font has none. */
  glyphOf(codepoint: number): number {
    return this.characters.get(codepoint) ?? 0;
  }

  /** Whether the font has a glyph for the character. */
  hasGlyph(codepoint: number): boolean {
    return this.characters.has(codepoint);
  }

  /** The advance of a glyph in font units. */
  advanceOf(glyph: number): number {
    return this.advances[glyph] ?? 0;
  }

  /** The class of a glyph in GDEF: 1 base, 2 ligature, 3 mark, 4 component, 0 none. */
  classOf(glyph: number): number {
    return this.glyphClasses.get(glyph) ?? 0;
  }

  /** The mark attachment class of a glyph in GDEF. */
  markClassOf(glyph: number): number {
    return this.markClasses.get(glyph) ?? 0;
  }

  /** Whether a glyph is in a mark glyph set of GDEF. */
  inMarkSet(set: number, glyph: number): boolean {
    return this.markSets[set]?.has(glyph) ?? false;
  }

  /** Reads a class definition table into a map from glyph to class; read once per table. */
  readClasses(offset: number, into?: Map<number, number>): Map<number, number> {
    const known = into ? undefined : this.classTables.get(offset);
    if (known) {
      return known;
    }
    const classes = into ?? new Map<number, number>();
    if (!into) {
      this.classTables.set(offset, classes);
    }
    const view = this.view;
    const format = view.getUint16(offset);
    if (format === 1) {
      const start = view.getUint16(offset + 2);
      const count = view.getUint16(offset + 4);
      for (let i = 0; i < count; i++) {
        classes.set(start + i, view.getUint16(offset + 6 + i * 2));
      }
    } else if (format === 2) {
      const count = view.getUint16(offset + 2);
      for (let i = 0; i < count; i++) {
        const record = offset + 4 + i * 6;
        const value = view.getUint16(record + 4);
        for (let glyph = view.getUint16(record); glyph <= view.getUint16(record + 2); glyph++) {
          classes.set(glyph, value);
        }
      }
    }
    return classes;
  }

  /** Reads a coverage table into a map from glyph to its coverage index; read once per table. */
  readCoverage(offset: number): Map<number, number> {
    const known = this.coverages.get(offset);
    if (known) {
      return known;
    }
    const view = this.view;
    const coverage = new Map<number, number>();
    this.coverages.set(offset, coverage);
    const format = view.getUint16(offset);
    const count = view.getUint16(offset + 2);
    if (format === 1) {
      for (let i = 0; i < count; i++) {
        coverage.set(view.getUint16(offset + 4 + i * 2), i);
      }
    } else if (format === 2) {
      for (let i = 0; i < count; i++) {
        const record = offset + 4 + i * 6;
        const first = view.getUint16(record + 4);
        for (let glyph = view.getUint16(record); glyph <= view.getUint16(record + 2); glyph++) {
          coverage.set(glyph, first + glyph - view.getUint16(record));
        }
      }
    }
    return coverage;
  }

  private require(tag: string): number {
    const offset = this.tables.get(tag);
    if (offset === undefined) {
      throw new Error(`The font has no ${tag} table.`);
    }
    return offset;
  }

  // The Unicode map of the font: format 12 (all planes) when there is one, else format 4 (the basic plane).
  private readCharacterMap(cmap: number): void {
    const view = this.view;
    let best = -1;
    let bestRank = 0;
    for (let i = 0; i < view.getUint16(cmap + 2); i++) {
      const record = cmap + 4 + i * 8;
      const offset = cmap + view.getUint32(record + 4);
      const rank = characterMapRank(view.getUint16(record), view.getUint16(record + 2), view.getUint16(offset));
      if (rank > bestRank) {
        best = offset;
        bestRank = rank;
      }
    }
    if (best < 0) {
      throw new Error('The font has no Unicode character map.');
    }
    if (bestRank === 2) {
      this.readFormat12(best);
    } else {
      this.readFormat4(best);
    }
  }

  private readFormat12(table: number): void {
    const view = this.view;
    const groups = view.getUint32(table + 12);
    for (let i = 0; i < groups; i++) {
      const group = table + 16 + i * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      const glyph = view.getUint32(group + 8);
      for (let code = start; code <= end; code++) {
        this.set(code, glyph + code - start);
      }
    }
  }

  private readFormat4(table: number): void {
    const view = this.view;
    const segments = view.getUint16(table + 6) / 2;
    const ends = table + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      const end = view.getUint16(ends + s * 2);
      const start = view.getUint16(starts + s * 2);
      const delta = view.getInt16(deltas + s * 2);
      const range = view.getUint16(ranges + s * 2);
      for (let code = start; code <= end && code !== 0xffff; code++) {
        // Without a range offset the delta alone maps the code; with one, a glyph array holds the glyph to shift.
        const stored = range === 0 ? code : view.getUint16(ranges + s * 2 + range + (code - start) * 2);
        this.set(code, range !== 0 && stored === 0 ? 0 : (stored + delta) & 0xffff);
      }
    }
  }

  private set(code: number, glyph: number): void {
    if (glyph !== 0) {
      this.characters.set(code, glyph);
    }
  }

  private readGlyphDefinitions(gdef: number): void {
    const view = this.view;
    const classes = view.getUint16(gdef + 4);
    const marks = view.getUint16(gdef + 10);
    if (classes !== 0) {
      this.readClasses(gdef + classes, this.glyphClasses);
    }
    if (marks !== 0) {
      this.readClasses(gdef + marks, this.markClasses);
    }
    // Mark glyph sets came with version 1.2.
    if (view.getUint16(gdef + 2) >= 2) {
      const sets = view.getUint16(gdef + 12);
      if (sets !== 0) {
        const table = gdef + sets;
        for (let i = 0; i < view.getUint16(table + 2); i++) {
          const coverage = this.readCoverage(table + view.getUint32(table + 4 + i * 4));
          this.markSets.push(new Set(coverage.keys()));
        }
      }
    }
  }
}

/** How well a subtable of the character map serves: 2 for Unicode format 12, 1 for format 4, 0 not at all. */
function characterMapRank(platform: number, encoding: number, format: number): number {
  const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
  if (!unicode) return 0;
  if (format === 12) return 2;
  return format === 4 ? 1 : 0;
}
