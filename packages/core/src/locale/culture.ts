// The language of the texts in charts, as ChartText of the .NET version: English with a decimal point, German with a
// decimal comma. More languages are one more entry.

/** The languages of the texts in a chart. */
export type ChartLanguage = 'english' | 'german';

/** How numbers and names are written in a language. */
export interface Culture {
  readonly language: ChartLanguage;
  readonly decimalSeparator: string;
  readonly negativeSign: string;
}

const cultures: Record<ChartLanguage, Culture> = {
  english: { language: 'english', decimalSeparator: '.', negativeSign: '-' },
  german: { language: 'german', decimalSeparator: ',', negativeSign: '-' },
};

/** The culture of a language. */
export function cultureOf(language: ChartLanguage): Culture {
  return cultures[language];
}

/** The culture the .NET version calls invariant: English numbers, used where the language must not change a text. */
export const invariantCulture: Culture = cultures.english;

let current: ChartLanguage = 'english';
let changes = 0;
const listeners = new Set<() => void>();

/** The language of all charts, which axes and instruments use unless they are given a culture of their own. */
export const chartText = {
  get language(): ChartLanguage {
    return current;
  },
  set language(language: ChartLanguage) {
    if (!(language in cultures)) {
      throw new RangeError(`"${language}" is no chart language.`);
    }
    if (language !== current) {
      current = language;
      changes++;
      for (const listener of listeners) {
        listener();
      }
    }
  },
  /** The culture of the current language. */
  get culture(): Culture {
    return cultures[current];
  },
  /** Grows with every change of the language. */
  get version(): number {
    return changes;
  },
  /** Calls the listener after every change of the language; returns a function that removes it. */
  onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
