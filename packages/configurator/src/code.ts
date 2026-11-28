// The code of a chart in TypeScript or JavaScript, as CodeGenerator and CodeText of the .NET version. The configurator
// shows its preview by running exactly this code, so the code and the preview cannot differ.
import type { Rgba8 } from '@tachyon-charts/core';

/** The language of the code. */
export type CodeLanguage = 'typescript' | 'javascript';

/** Collects what a piece of code needs and writes values as code. */
export class CodeWriter {
  private readonly imports = new Map<string, Set<string>>();
  private readonly typeImports = new Map<string, Set<string>>();
  private readonly helpers = new Map<string, string>();

  /** @param language - The language of the code. */
  constructor(
    /** The language of the code. */
    readonly language: CodeLanguage,
  ) {}

  /** Imports a name from a package and returns it. */
  use(name: string, from = '@tachyon-charts/core'): string {
    let names = this.imports.get(from);
    if (!names) {
      names = new Set();
      this.imports.set(from, names);
    }
    names.add(name);
    return name;
  }

  /** Imports a type from a package for TypeScript and returns it. */
  useType(name: string, from = '@tachyon-charts/core'): string {
    if (this.language === 'typescript') {
      let names = this.typeImports.get(from);
      if (!names) {
        names = new Set();
        this.typeImports.set(from, names);
      }
      names.add(name);
    }
    return name;
  }

  /** Adds a function of the code once, by its name. */
  helper(name: string, code: string): string {
    this.helpers.set(name, code);
    return name;
  }

  /** An expression with a type for TypeScript, as it is for JavaScript. */
  as(expression: string, type: string): string {
    return this.language === 'typescript' ? `(${expression} as ${type})` : expression;
  }

  /** A type annotation for TypeScript, nothing for JavaScript. */
  type(annotation: string): string {
    return this.language === 'typescript' ? `: ${annotation}` : '';
  }

  /** The imports of the code. */
  importLines(): string[] {
    const sources = [...new Set([...this.imports.keys(), ...this.typeImports.keys()])].sort();
    return sources.map((source) => {
      const names = [...(this.imports.get(source) ?? [])].sort();
      const types = [...(this.typeImports.get(source) ?? [])].filter((name) => !names.includes(name)).sort();
      const all = [...names, ...types.map((name) => `type ${name}`)];
      return `import { ${all.join(', ')} } from '${source}';`;
    });
  }

  /** The names imported, by package, for running the code without a bundler. */
  importedNames(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.imports;
  }

  /** The helper functions of the code. */
  helperCode(): string[] {
    return [...this.helpers.values()];
  }
}

/** A text as code. */
export function str(text: string): string {
  return `'${text.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'").replace(/\n/gu, '\\n')}'`;
}

/** A number as code, written the shortest way that reads back exactly. */
export function num(value: number): string {
  if (Number.isNaN(value)) {
    return 'Number.NaN';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'Number.POSITIVE_INFINITY' : 'Number.NEGATIVE_INFINITY';
  }
  return String(value);
}

/** A color as code. */
export function rgba(color: Rgba8): string {
  return `{ r: ${String(color.r)}, g: ${String(color.g)}, b: ${String(color.b)}, a: ${String(color.a)} }`;
}

/** A name of a variable from a free text. */
export function identifier(text: string): string {
  const words = text
    .replace(/[^A-Za-z0-9]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
  const name = words
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join('');
  return /^[A-Za-z_]/u.test(name) ? name : `data${name}`;
}
