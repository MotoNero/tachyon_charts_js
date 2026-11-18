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

/** A test of one glyph of a context rule. */
type Test = (glyph: number) => boolean;

/** A rule of a context subtable: the glyphs before, the input glyphs and those after, then the lookups to apply. */
interface Rule {
  backtrack: Test[];
  input: Test[];
  lookahead: Test[];
  records: number;
  recordCount: number;
}

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
      for (const character of this.compose(run[0])) {
        const glyph = this.font.glyphOf(character.codePointAt(0) ?? 0);
        items.push({ glyph, cluster, xAdvance: 0, xOffset: 0, yOffset: 0, kind: this.font.classOf(glyph), attach: 0 });
      }
    }
    return items;
  }

  // The composed form when the font has all its characters, else the decomposed one, else the text as it is.
  private compose(run: string): string {
    const has = (value: string): boolean => {
      for (const character of value) {
        if (!this.font.hasGlyph(character.codePointAt(0) ?? 0)) return false;
      }
      return true;
    };
    const composed = run.normalize('NFC');
    if (has(composed)) return composed;
    const decomposed = run.normalize('NFD');
    return has(decomposed) ? decomposed : run;
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
    const scriptTable = table === undefined ? -1 : this.findScript(table + this.view.getUint16(table + 4), script);
    if (table === undefined || scriptTable < 0 || this.view.getUint16(scriptTable) === 0) {
      return [];
    }
    const view = this.view;
    const featureList = table + view.getUint16(table + 6);
    const lookupList = table + view.getUint16(table + 8);
    const langSys = scriptTable + view.getUint16(scriptTable);
    const featureIndices = Array.from({ length: view.getUint16(langSys + 4) }, (_, i) =>
      view.getUint16(langSys + 6 + i * 2),
    );
    const required = view.getUint16(langSys + 2);
    if (required !== 0xffff) featureIndices.push(required);
    const indices = new Set<number>();
    for (const index of featureIndices) {
      const record = featureList + 2 + index * 6;
      if (features.includes(this.tag(record))) {
        const feature = featureList + view.getUint16(record + 4);
        for (let k = 0; k < view.getUint16(feature + 2); k++) {
          indices.add(view.getUint16(feature + 4 + k * 2));
        }
      }
    }
    return [...indices].sort((a, b) => a - b).map((index) => this.readLookup(lookupList, index, extension));
  }

  // The script table for the script, or the default ones HarfBuzz falls back to; -1 when there is none.
  private findScript(scripts: number, script: string): number {
    const view = this.view;
    for (const candidate of [script, 'DFLT', 'dflt', 'latn']) {
      for (let i = 0; i < view.getUint16(scripts); i++) {
        const record = scripts + 2 + i * 6;
        if (this.tag(record) === candidate) {
          return scripts + view.getUint16(record + 4);
        }
      }
    }
    return -1;
  }

  private readLookup(lookupList: number, index: number, extension: number): Lookup {
    const view = this.view;
    const lookup = lookupList + view.getUint16(lookupList + 2 + index * 2);
    // An extension lookup points from each of its subtables to the real one, which also tells the real type.
    const lookupType = view.getUint16(lookup);
    let type = lookupType;
    const flag = view.getUint16(lookup + 2);
    const count = view.getUint16(lookup + 4);
    const tables: number[] = [];
    for (let i = 0; i < count; i++) {
      let sub = lookup + view.getUint16(lookup + 6 + i * 2);
      if (lookupType === extension) {
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
    return String.fromCodePoint(
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
        const glyphs = Array.from({ length: view.getUint16(sequence) }, (_, k) => view.getUint16(sequence + 2 + k * 2));
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
      for (const k of matched.toReversed()) {
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

  // Applies the first rule of a context subtable that matches at the position; returns -1 when none does.
  private context(
    items: Item[],
    lookup: Lookup,
    type: number,
    table: number,
    i: number,
    apply: (index: number, nested: Lookup) => void,
  ): number {
    const chained = type === 6 || type === 8;
    const format = this.view.getUint16(table);
    const first = (items[i] as Item).glyph;
    const rules = format === 3 ? [this.coverageRule(table, chained)] : this.glyphRules(table, format, chained, first);
    for (const rule of rules) {
      const positions = this.match(items, lookup, i, rule);
      if (positions) {
        this.applyRecords(lookup, rule, positions, apply);
        return rule.input.length;
      }
    }
    return -1;
  }

  // Format 3: one rule of coverage tables.
  private coverageRule(table: number, chained: boolean): Rule {
    const view = this.view;
    const coverages = (at: number, count: number): Test[] =>
      Array.from({ length: count }, (_, k) => {
        const coverage = this.font.readCoverage(table + view.getUint16(at + k * 2));
        return (glyph: number) => coverage.has(glyph);
      });
    let at = table + 2;
    if (!chained) {
      const count = view.getUint16(at);
      return {
        backtrack: [],
        input: coverages(at + 4, count),
        lookahead: [],
        records: at + 4 + count * 2,
        recordCount: view.getUint16(at + 2),
      };
    }
    const backtrack = coverages(at + 2, view.getUint16(at));
    at += 2 + backtrack.length * 2;
    const input = coverages(at + 2, view.getUint16(at));
    at += 2 + input.length * 2;
    const lookahead = coverages(at + 2, view.getUint16(at));
    at += 2 + lookahead.length * 2;
    return { backtrack, input, lookahead, records: at + 2, recordCount: view.getUint16(at) };
  }

  // Formats 1 and 2: the rules of the set the first glyph selects, by glyph or by class.
  private glyphRules(table: number, format: number, chained: boolean, first: number): Rule[] {
    const view = this.view;
    const coverage = this.font.readCoverage(table + view.getUint16(table + 2)).get(first);
    if (coverage === undefined) return [];
    let test =
      (value: number): Test =>
      (glyph: number) =>
        glyph === value;
    let tests = { backtrack: test, input: test, lookahead: test };
    let setIndex = coverage;
    let sets = table + 4;
    if (format === 2) {
      const classes = (at: number) => this.font.readClasses(table + view.getUint16(at));
      const byClass =
        (map: Map<number, number>) =>
        (value: number): Test =>
        (glyph: number) =>
          (map.get(glyph) ?? 0) === value;
      const input = classes(chained ? table + 6 : table + 4);
      test = byClass(input);
      tests = chained
        ? { backtrack: byClass(classes(table + 4)), input: test, lookahead: byClass(classes(table + 8)) }
        : { backtrack: test, input: test, lookahead: test };
      setIndex = input.get(first) ?? 0;
      sets = chained ? table + 10 : table + 6;
    }
    if (setIndex >= view.getUint16(sets) || view.getUint16(sets + 2 + setIndex * 2) === 0) return [];
    const set = table + view.getUint16(sets + 2 + setIndex * 2);
    return Array.from({ length: view.getUint16(set) }, (_, r) =>
      this.parseRule(set + view.getUint16(set + 2 + r * 2), chained, tests),
    );
  }

  private parseRule(
    at: number,
    chained: boolean,
    tests: { backtrack: (value: number) => Test; input: (value: number) => Test; lookahead: (value: number) => Test },
  ): Rule {
    const view = this.view;
    const values = (from: number, count: number, make: (value: number) => Test): Test[] =>
      Array.from({ length: count }, (_, k) => make(view.getUint16(from + k * 2)));
    // The first input glyph is the one the subtable was found by; the rule lists only those after it.
    const anything: Test = () => true;
    if (!chained) {
      const count = view.getUint16(at);
      return {
        backtrack: [],
        input: [anything, ...values(at + 4, count - 1, tests.input)],
        lookahead: [],
        records: at + 4 + (count - 1) * 2,
        recordCount: view.getUint16(at + 2),
      };
    }
    const backtrack = values(at + 2, view.getUint16(at), tests.backtrack);
    at += 2 + backtrack.length * 2;
    const inputCount = view.getUint16(at);
    const input = [anything, ...values(at + 2, inputCount - 1, tests.input)];
    at += 2 + (inputCount - 1) * 2;
    const lookahead = values(at + 2, view.getUint16(at), tests.lookahead);
    at += 2 + lookahead.length * 2;
    return { backtrack, input, lookahead, records: at + 2, recordCount: view.getUint16(at) };
  }

  /** The positions of the input glyphs when the rule matches at i, with backtrack and lookahead; else undefined. */
  private match(items: Item[], lookup: Lookup, i: number, rule: Rule): number[] | undefined {
    const glyphAt = (at: number): number => (items[at] as Item).glyph;
    const positions: number[] = [];
    let at = i;
    for (let k = 0; k < rule.input.length; k++) {
      if (k > 0) at = this.next(items, lookup, at + 1);
      if (at < 0 || !(rule.input[k]?.(glyphAt(at)) ?? false)) return undefined;
      positions.push(at);
    }
    let ahead = at;
    for (const test of rule.lookahead) {
      ahead = this.next(items, lookup, ahead + 1);
      if (ahead < 0 || !test(glyphAt(ahead))) return undefined;
    }
    let behind = i;
    for (const test of rule.backtrack) {
      behind = this.previous(items, lookup, behind - 1);
      if (behind < 0 || !test(glyphAt(behind))) return undefined;
    }
    return positions;
  }

  private applyRecords(
    lookup: Lookup,
    rule: Rule,
    positions: number[],
    apply: (index: number, nested: Lookup) => void,
  ): void {
    const view = this.view;
    const tag = lookup.type === 5 || lookup.type === 6 ? 'GSUB' : 'GPOS';
    const table = this.font.table(tag) as number;
    const lookupList = table + view.getUint16(table + 8);
    for (let r = 0; r < rule.recordCount; r++) {
      const position = positions[view.getUint16(rule.records + r * 4)];
      if (position !== undefined) {
        apply(position, this.readLookup(lookupList, view.getUint16(rule.records + r * 4 + 2), tag === 'GSUB' ? 7 : 9));
      }
    }
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
