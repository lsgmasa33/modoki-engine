/** Font filename parsing — shared between runtime FontLoader and the build-time
 *  asset tree-shaker. Both must agree on family names or fonts will silently
 *  fail to load in production. */

/** Weight/style suffixes stripped from filenames to derive the base family name */
export const WEIGHT_MAP: Record<string, { weight: string; style?: string }> = {
  'thin': { weight: '100' },
  'extralight': { weight: '200' },
  'ultralight': { weight: '200' },
  'light': { weight: '300' },
  'regular': { weight: '400' },
  'normal': { weight: '400' },
  'medium': { weight: '500' },
  'semibold': { weight: '600' },
  'demibold': { weight: '600' },
  'bold': { weight: '700' },
  'extrabold': { weight: '800' },
  'ultrabold': { weight: '800' },
  'black': { weight: '900' },
  'heavy': { weight: '900' },
  'thinitalic': { weight: '100', style: 'italic' },
  'lightitalic': { weight: '300', style: 'italic' },
  'italic': { weight: '400', style: 'italic' },
  'mediumitalic': { weight: '500', style: 'italic' },
  'semibolditalic': { weight: '600', style: 'italic' },
  'bolditalic': { weight: '700', style: 'italic' },
  'extrabolditalic': { weight: '800', style: 'italic' },
  'blackitalic': { weight: '900', style: 'italic' },
};

export interface FontInfo {
  family: string;
  path: string;
  weight: string;
  style: string;
}

/** Parse a font filename into family name + weight + style.
 *  e.g. "Roboto-Bold.woff2" → { family: "Roboto", weight: "700", style: "normal" }
 *       "OpenSans-SemiBoldItalic.ttf" → { family: "Open Sans", weight: "600", style: "italic" } */
export function parseFontFilename(path: string): FontInfo {
  // Extract filename without extension. Strip everything up to the last slash OR
  // backslash — this is called with native fs paths (backslash on Windows) at build
  // time AND with forward-slash URLs at runtime, so it must accept both separators.
  // (A `/`-only split left the whole Windows path as the "family", breaking matching.)
  const base = path.split(/[\\/]/).pop() ?? path;
  const filename = base.replace(/\.[^.]+$/, '');

  // Split on hyphen or underscore — last segment is often the variant
  const parts = filename.split(/[-_]/);
  let family: string;
  let weight = '400';
  let style = 'normal';

  if (parts.length > 1) {
    const lastPart = parts[parts.length - 1].toLowerCase();
    const match = WEIGHT_MAP[lastPart];
    if (match) {
      family = parts.slice(0, -1).join(' ');
      weight = match.weight;
      style = match.style || 'normal';
    } else {
      // Last part isn't a known variant — treat entire filename as family
      family = parts.join(' ');
    }
  } else {
    family = filename;
  }

  // Insert spaces before capitals for camelCase names: "OpenSans" → "Open Sans"
  family = family.replace(/([a-z])([A-Z])/g, '$1 $2');

  return { family, path, weight, style };
}
