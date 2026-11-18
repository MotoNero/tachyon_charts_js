// Shapes text as HarfBuzz does for scripts written from left to right without complex shaping (Latin, Greek,
// Cyrillic and the like): composes characters the font has precomposed, applies the substitutions (GSUB) and
// positions (GPOS) of the default features in lookup order, gives marks no width and moves them onto their base.
// The .NET version shapes with HarfBuzz; tests compare both on a corpus of texts.
import type { FontFile } from './font';

/** One shaped glyph; numbers in font units. */
export interface ShapedGlyph {
  glyph: number;
  /** The UTF-16 index of the first character the glyph stands for. */
  cluster: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

interface Item extends ShapedGlyph {
  /** GDEF class: 1 base, 2 ligature, 3 mark, 4 component. */
  kind: number;
  /** Index of the glyph a mark is attached to, relative to this one; 0 for none. */
  attach: number;
}

const substitutionFeatures = ['rvrn', 'ccmp', 'locl', 'rlig', 'liga', 'clig', 'calt'];
const positionFeatures = ['abvm', 'blwm', 'mark', 'mkmk', 'curs', 'dist', 'kern'];

const ignoreBase = 2;
const ignoreLigatures = 4;
const ignoreMarks = 8;
const useMarkSet = 16;

interface Lookup {
  type: number;
  flag: number;
  markSet: number;
  tables: number[];
}

/** The script tag of a text: that of its first character with a script of its own. */
function scriptTag(text: string): string {
  for (const character of text) {
    if (/\p{Script=Common}|\p{Script=Inherited}/u.test(character)) {
      continue;
    }
    if (/\p{Script=Latin}/u.test(character)) return 'latn';
    if (/\p{Script=Cyrillic}/u.test(character)) return 'cyrl';
    if (/\p{Script=Greek}/u.test(character)) return 'grek';
    return '';
  }
  return '';
}

export class Shaper {
  private readonly view: DataView;
  private readonly cache = new Map<string, { gsub: Lookup[]; gpos: Lookup[] }>();

  constructor(private readonly font: FontFile) {
    this.view = font.view;
  }

  /** Shapes a text. */
  shape(text: string): ShapedGlyph[] {
    const items = this.mapCharacters(text);
    const { gsub, gpos } = this.lookupsFor(scriptTag(text));
    for (const lookup of gsub) {
      this.substitute(items, lookup);
    }
    for (const item of items) {
      item.xAdvance = this.font.advanceOf(item.glyph);
    }
    for (const lookup of gpos) {
      this.position(items, lookup);
    }
    // Marks have no width; then their offsets follow the glyphs they are attached to.
    for (const item of items) {
      if (item.kind === 3) {
        item.xAdvance = 0;
      }
    }
    items.forEach((item, i) => {
      if (item.attach !== 0) {
        const parent = i + item.attach;
        const base = items[parent];
        if (base) {
          item.xOffset += base.xOffset;
          item.yOffset += base.yOffset;
          for (let k = parent; k < i; k++) {
            item.xOffset -= (items[k] as Item).xAdvance;
          }
        }
      }
    });
    return items.map(({ glyph, cluster, xAdvance, xOffset, yOffset }) => ({
      glyph,
      cluster,
      xAdvance,
      xOffset,
      yOffset,
    }));
  }

  // Characters to glyphs. A base with its marks becomes the composed character when the font has it, as HarfBuzz
  // does; the marks join the cluster of their base.
  private mapCharacters(text: string): Item[] {
    const items: Item[] = [];
    const runs = text.matchAll(/\P{M}\p{M}*|\p{M}+/gsu);
    for (const run of runs) {
      const cluster = run.index;
      const composed = run[0].normalize('NFC');
      const decomposed = run[0].normalize('NFD');
      const has = (value: string): boolean => {
        for (const character of value) {
          if (!this.font.hasGlyph(character.codePointAt(0) ?? 0)) return false;
        }
        return true;
      };
      const chosen = has(composed) ? composed : has(decomposed) ? decomposed : run[0];
      for (const character of chosen) {
        const glyph = this.font.glyphOf(character.codePointAt(0) ?? 0);
        items.push({ glyph, cluster, xAdvance: 0, xOffset: 0, yOffset: 0, kind: this.font.classOf(glyph), attach: 0 });
      }
    }
    return items;
  }

  private lookupsFor(script: string): { gsub: Lookup[]; gpos: Lookup[] } {
    let lookups = this.cache.get(script);
    if (!lookups) {
      lookups = {
        gsub: this.readLookups('GSUB', script, substitutionFeatures, 7),
        gpos: this.readLookups('GPOS', script, positionFeatures, 9),
      };
      this.cache.set(script, lookups);
    }
    return lookups;
  }

  // The lookups of the features in the default language system of the script, in the order of the lookup list.
  private readLookups(tag: string, script: string, features: string[], extension: number): Lookup[] {
    const table = this.font.table(tag);
    if (table === undefined) {
      return [];
    }
    const view = this.view;
    const scripts = table + view.getUint16(table + 4);
    const featureList = table + view.getUint16(table + 6);
    const lookupList = table + view.getUint16(table + 8);
    let scriptTable = -1;
    for (const candidate of [script, 'DFLT', 'dflt', 'latn']) {
      for (let i = 0; i < view.getUint16(scripts); i++) {
        const record = scripts + 2 + i * 6;
        if (this.tag(record) === candidate) {
          scriptTable = scripts + view.getUint16(record + 4);
          break;
        }
      }
      if (scriptTable >= 0) break;
    }
    if (scriptTable < 0 || view.getUint16(scriptTable) === 0) {
      return [];
    }
    const langSys = scriptTable + view.getUint16(scriptTable);
    const indices = new Set<number>();
    const required = view.getUint16(langSys + 2);
    const featureIndices = [...Array(view.getUint16(langSys + 4)).keys()].map((i) =>
      view.getUint16(langSys + 6 + i * 2),
    );
    if (required !== 0xffff) featureIndices.push(required);
    for (const index of featureIndices) {
      const record = featureList + 2 + index * 6;
      if (!features.includes(this.tag(record))) continue;
      const feature = featureList + view.getUint16(record + 4);
      for (let k = 0; k < view.getUint16(feature + 2); k++) {
        indices.add(view.getUint16(feature + 4 + k * 2));
      }
    }
    return [...indices].sort((a, b) => a - b).map((index) => this.readLookup(lookupList, index, extension));
  }

  private readLookup(lookupList: number, index: number, extension: number): Lookup {
    const view = this.view;
    const lookup = lookupList + view.getUint16(lookupList + 2 + index * 2);
    let type = view.getUint16(lookup);
    const flag = view.getUint16(lookup + 2);
    const count = view.getUint16(lookup + 4);
    const tables: number[] = [];
    for (let i = 0; i < count; i++) {
      let sub = lookup + view.getUint16(lookup + 6 + i * 2);
      if (type === extension) {
        type = view.getUint16(sub + 2);
        sub += view.getUint32(sub + 4);
      }
      tables.push(sub);
    }
    const markSet = flag & useMarkSet ? view.getUint16(lookup + 6 + count * 2) : 0;
    return { type, flag, markSet, tables };
  }

  private tag(offset: number): string {
    const view = this.view;
    return String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  }

  private skips(lookup: Lookup, item: Item): boolean {
    const kind = item.kind;
    if (kind === 1 && lookup.flag & ignoreBase) return true;
    if (kind === 2 && lookup.flag & ignoreLigatures) return true;
    if (kind === 3) {
      if (lookup.flag & ignoreMarks) return true;
      if (lookup.flag & useMarkSet) return !this.font.inMarkSet(lookup.markSet, item.glyph);
      const type = lookup.flag >> 8;
      if (type !== 0 && this.font.markClassOf(item.glyph) !== type) return true;
    }
    return false;
  }

  /** The index of the next glyph from `from` on that the lookup does not skip, or -1. */
  private next(items: Item[], lookup: Lookup, from: number): number {
    for (let i = from; i < items.length; i++) {
      if (!this.skips(lookup, items[i] as Item)) return i;
    }
    return -1;
  }

  private previous(items: Item[], lookup: Lookup, from: number): number {
    for (let i = from; i >= 0; i--) {
      if (!this.skips(lookup, items[i] as Item)) return i;
    }
    return -1;
  }

  // ---- Substitution ----

  private substitute(items: Item[], lookup: Lookup): void {
    for (let i = 0; i < items.length; i++) {
      if (this.skips(lookup, items[i] as Item)) continue;
      for (const table of lookup.tables) {
        const consumed = this.substituteAt(items, lookup, lookup.type, table, i);
        if (consumed >= 0) {
          break;
        }
      }
    }
  }

  // Applies one subtable at a position; returns -1 when it does not apply.
  private substituteAt(items: Item[], lookup: Lookup, type: number, table: number, i: number): number {
    const view = this.view;
    const item = items[i] as Item;
    switch (type) {
      case 1: {
        const coverage = this.font.readCoverage(table + view.getUint16(table + 2)).get(item.glyph);
        if (coverage === undefined) return -1;
        const glyph =
          view.getUint16(table) === 1
            ? (item.glyph + view.getInt16(table + 4)) & 0xffff
            : view.getUint16(table + 6 + coverage * 2);
        this.replace(item, glyph);
        return 1;
      }
      case 2: {
        const coverage = this.font.readCoverage(table + view.getUint16(table + 2)).get(item.glyph);
        if (coverage === undefined) return -1;
        const sequence = table + view.getUint16(table + 6 + coverage * 2);
        const glyphs = [...Array(view.getUint16(sequence)).keys()].map((k) => view.getUint16(sequence + 2 + k * 2));
        const replaced = glyphs.map((glyph) => ({ ...item, glyph, kind: this.font.classOf(glyph) }));
        items.splice(i, 1, ...replaced);
        return glyphs.length;
      }
      case 4:
        return this.ligature(items, lookup, table, i);
      case 5:
      case 6:
        return this.context(items, lookup, type, table, i, (index, nested) => {
          this.substituteNested(items, index, nested);
        });
      default:
        return -1;
    }
  }

  private replace(item: Item, glyph: number): void {
    item.glyph = glyph;
    item.kind = this.font.classOf(glyph);
  }

  private ligature(items: Item[], lookup: Lookup, table: number, i: number): number {
    const view = this.view;
    const first = items[i] as Item;
    const coverage = this.font.readCoverage(table + view.getUint16(table + 2)).get(first.glyph);
    if (coverage === undefined) return -1;
    const set = table + view.getUint16(table + 6 + coverage * 2);
    for (let l = 0; l < view.getUint16(set); l++) {
      const ligature = set + view.getUint16(set + 2 + l * 2);
      const glyph = view.getUint16(ligature);
      const components = view.getUint16(ligature + 2);
      const matched: number[] = [];
      let at = i;
      let fits = true;
      for (let c = 1; c < components; c++) {
        at = this.next(items, lookup, at + 1);
        if (at < 0 || (items[at] as Item).glyph !== view.getUint16(ligature + 4 + (c - 1) * 2)) {
          fits = false;
          break;
        }
        matched.push(at);
      }
      if (!fits) continue;
      const cluster = Math.min(first.cluster, ...matched.map((k) => (items[k] as Item).cluster));
      for (let k = i; k <= (matched.at(-1) ?? i); k++) {
        (items[k] as Item).cluster = cluster;
      }
      this.replace(first, glyph);
      first.kind = 2;
      for (const k of matched.reverse()) {
        items.splice(k, 1);
      }
      return 1;
    }
    return -1;
  }

  private substituteNested(items: Item[], index: number, lookup: Lookup): void {
    for (const table of lookup.tables) {
      if (this.substituteAt(items, lookup, lookup.type, table, index) >= 0) return;
    }
  }

  // ---- Context, shared by GSUB 5/6 and GPOS 7/8 ----

  private context(
    items: Item[],
    lookup: Lookup,
    type: number,
    table: number,
    i: number,
    apply: (index: number, nested: Lookup) => void,
  ): number {
    const view = this.view;
    const format = view.getUint16(table);
    const chained = type === 6 || type === 8;
    let backtrack: ((glyph: number) => boolean)[] = [];
    let input: ((glyph: number) => boolean)[];
    let lookahead: ((glyph: number) => boolean)[] = [];
    let records: number;
    let recordCount: number;
    const coverageTest = (offset: number) => {
      const coverage = this.font.readCoverage(offset);
      return (glyph: number) => coverage.has(glyph);
    };
    const first = (items[i] as Item).glyph;
    if (format === 3) {
      let at = table + 2;
      const list = (count: number): ((glyph: number) => boolean)[] =>
        [...Array(count).keys()].map((k) => coverageTest(table + view.getUint16(at + 2 + k * 2)));
      if (chained) {
        const b = view.getUint16(at);
        backtrack = list(b);
        at += 2 + b * 2;
        const n = view.getUint16(at);
        input = list(n);
        at += 2 + n * 2;
        const a = view.getUint16(at);
        lookahead = list(a);
        at += 2 + a * 2;
        recordCount = view.getUint16(at);
        records = at + 2;
      } else {
        const n = view.getUint16(at);
        recordCount = view.getUint16(at + 2);
        input = [...Array(n).keys()].map((k) => coverageTest(table + view.getUint16(at + 4 + k * 2)));
        records = at + 4 + n * 2;
      }
      if (!(input[0]?.(first) ?? false)) return -1;
      return this.matchAndApply(items, lookup, i, backtrack, input, lookahead, records, recordCount, apply);
    }
    const coverage = this.font.readCoverage(table + view.getUint16(table + 2)).get(first);
    if (coverage === undefined) return -1;
    let classes: [Map<number, number>, Map<number, number>, Map<number, number>] | undefined;
    let setOffset: number;
    if (format === 2) {
      const read = (at: number) => this.font.readClasses(table + view.getUint16(at));
      classes = chained ? [read(table + 4), read(table + 6), read(table + 8)] : [new Map(), read(table + 4), new Map()];
      const index = classes[1].get(first) ?? 0;
      const sets = chained ? table + 10 : table + 6;
      if (index >= view.getUint16(sets)) return -1;
      const offset = view.getUint16(sets + 2 + index * 2);
      if (offset === 0) return -1;
      setOffset = table + offset;
    } else {
      const sets = chained ? table + 4 : table + 4;
      setOffset = table + view.getUint16(sets + 2 + coverage * 2);
    }
    for (let r = 0; r < view.getUint16(setOffset); r++) {
      let at = setOffset + view.getUint16(setOffset + 2 + r * 2);
      const test = (value: number, which: number) =>
        classes
          ? (glyph: number) => ((classes as Map<number, number>[])[which]?.get(glyph) ?? 0) === value
          : (glyph: number) => glyph === value;
      if (chained) {
        const b = view.getUint16(at);
        backtrack = [...Array(b).keys()].map((k) => test(view.getUint16(at + 2 + k * 2), 0));
        at += 2 + b * 2;
        const n = view.getUint16(at);
        input = [() => true, ...[...Array(n - 1).keys()].map((k) => test(view.getUint16(at + 2 + k * 2), 1))];
        at += 2 + (n - 1) * 2;
        const a = view.getUint16(at);
        lookahead = [...Array(a).keys()].map((k) => test(view.getUint16(at + 2 + k * 2), 2));
        at += 2 + a * 2;
        recordCount = view.getUint16(at);
        records = at + 2;
      } else {
        const n = view.getUint16(at);
        recordCount = view.getUint16(at + 2);
        input = [() => true, ...[...Array(n - 1).keys()].map((k) => test(view.getUint16(at + 4 + k * 2), 1))];
        records = at + 4 + (n - 1) * 2;
      }
      const result = this.matchAndApply(items, lookup, i, backtrack, input, lookahead, records, recordCount, apply);
      if (result >= 0) return result;
    }
    return -1;
  }

  private matchAndApply(
    items: Item[],
    lookup: Lookup,
    i: number,
    backtrack: ((glyph: number) => boolean)[],
    input: ((glyph: number) => boolean)[],
    lookahead: ((glyph: number) => boolean)[],
    records: number,
    recordCount: number,
    apply: (index: number, nested: Lookup) => void,
  ): number {
    const positions = [i];
    let at = i;
    for (let k = 1; k < input.length; k++) {
      at = this.next(items, lookup, at + 1);
      if (at < 0 || !(input[k]?.((items[at] as Item).glyph) ?? false)) return -1;
      positions.push(at);
    }
    let ahead = at;
    for (const test of lookahead) {
      ahead = this.next(items, lookup, ahead + 1);
      if (ahead < 0 || !test((items[ahead] as Item).glyph)) return -1;
    }
    let behind = i;
    for (const test of backtrack) {
      behind = this.previous(items, lookup, behind - 1);
      if (behind < 0 || !test((items[behind] as Item).glyph)) return -1;
    }
    const view = this.view;
    const tag = lookup.type === 5 || lookup.type === 6 ? 'GSUB' : 'GPOS';
    const table = this.font.table(tag) as number;
    const lookupList = table + view.getUint16(table + 8);
    for (let r = 0; r < recordCount; r++) {
      const sequence = view.getUint16(records + r * 4);
      const index = view.getUint16(records + r * 4 + 2);
      const position = positions[sequence];
      if (position !== undefined) {
        apply(position, this.readLookup(lookupList, index, tag === 'GSUB' ? 7 : 9));
      }
    }
    return input.length;
  }

  // ---- Positioning ----

  private position(items: Item[], lookup: Lookup): void {
    for (let i = 0; i < items.length; i++) {
      if (this.skips(lookup, items[i] as Item)) continue;
      for (const table of lookup.tables) {
        if (this.positionAt(items, lookup, lookup.type, table, i)) break;
      }
    }
  }

  private positionAt(items: Item[], lookup: Lookup, type: number, table: number, i: number): boolean {
    switch (type) {
      case 2:
        return this.pair(items, lookup, table, i);
      case 4:
        return this.markOnBase(items, table, i);
      case 6:
        return this.markOnMark(items, table, i);
      case 7:
      case 8:
        return (
          this.context(items, lookup, type, table, i, (index, nested) => {
            for (const sub of nested.tables) {
              if (this.positionAt(items, nested, nested.type, sub, index)) return;
            }
          }) >= 0
        );
      default:
        return false;
    }
  }

  /** Reads a value record into the item; returns its size in bytes. */
  private value(format: number, at: number, item: Item | undefined): number {
    const view = this.view;
    let size = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (!(format & (1 << bit))) continue;
      const value = view.getInt16(at + size);
      if (item) {
        if (bit === 0) item.xOffset += value;
        else if (bit === 1) item.yOffset += value;
        else if (bit === 2) item.xAdvance += value;
      }
      size += 2;
    }
    return size;
  }

  private valueSize(format: number): number {
    let size = 0;
    for (let bit = 0; bit < 8; bit++) if (format & (1 << bit)) size += 2;
    return size;
  }

  private pair(items: Item[], lookup: Lookup, table: number, i: number): boolean {
    const view = this.view;
    const first = items[i] as Item;
    const coverage = this.font.readCoverage(table + view.getUint16(table + 2)).get(first.glyph);
    if (coverage === undefined) return false;
    const j = this.next(items, lookup, i + 1);
    if (j < 0) return false;
    const second = items[j] as Item;
    const format1 = view.getUint16(table + 4);
    const format2 = view.getUint16(table + 6);
    const size1 = this.valueSize(format1);
    const size2 = this.valueSize(format2);
    if (view.getUint16(table) === 1) {
      const set = table + view.getUint16(table + 10 + coverage * 2);
      for (let p = 0; p < view.getUint16(set); p++) {
        const record = set + 2 + p * (2 + size1 + size2);
        if (view.getUint16(record) === second.glyph) {
          this.value(format1, record + 2, first);
          this.value(format2, record + 2 + size1, second);
          return true;
        }
      }
      return false;
    }
    const class1 = this.font.readClasses(table + view.getUint16(table + 8)).get(first.glyph) ?? 0;
    const class2 = this.font.readClasses(table + view.getUint16(table + 10)).get(second.glyph) ?? 0;
    const count1 = view.getUint16(table + 12);
    const count2 = view.getUint16(table + 14);
    if (class1 >= count1 || class2 >= count2) return false;
    const record = table + 16 + (class1 * count2 + class2) * (size1 + size2);
    this.value(format1, record, first);
    this.value(format2, record + size1, second);
    return true;
  }

  private anchor(offset: number): [number, number] {
    return [this.view.getInt16(offset + 2), this.view.getInt16(offset + 4)];
  }

  private markOnBase(items: Item[], table: number, i: number): boolean {
    const mark = items[i] as Item;
    if (mark.kind !== 3) return false;
    // The base is the nearest glyph before the mark that is no mark.
    let b = i - 1;
    while (b >= 0 && (items[b] as Item).kind === 3) b--;
    if (b < 0) return false;
    return this.attachMark(items, table, i, b);
  }

  private markOnMark(items: Item[], table: number, i: number): boolean {
    const mark = items[i] as Item;
    if (mark.kind !== 3 || i === 0 || (items[i - 1] as Item).kind !== 3) return false;
    return this.attachMark(items, table, i, i - 1);
  }

  private attachMark(items: Item[], table: number, i: number, b: number): boolean {
    const view = this.view;
    const mark = items[i] as Item;
    const base = items[b] as Item;
    const markIndex = this.font.readCoverage(table + view.getUint16(table + 2)).get(mark.glyph);
    const baseIndex = this.font.readCoverage(table + view.getUint16(table + 4)).get(base.glyph);
    if (markIndex === undefined || baseIndex === undefined) return false;
    const classes = view.getUint16(table + 6);
    const markArray = table + view.getUint16(table + 8);
    const baseArray = table + view.getUint16(table + 10);
    const markRecord = markArray + 2 + markIndex * 4;
    const markClass = view.getUint16(markRecord);
    const markAnchor = this.anchor(markArray + view.getUint16(markRecord + 2));
    const baseAnchorOffset = view.getUint16(baseArray + 2 + (baseIndex * classes + markClass) * 2);
    if (baseAnchorOffset === 0) return false;
    const baseAnchor = this.anchor(baseArray + baseAnchorOffset);
    mark.xOffset = baseAnchor[0] - markAnchor[0];
    mark.yOffset = baseAnchor[1] - markAnchor[1];
    mark.attach = b - i;
    return true;
  }
}
