/** Font loader — loads font files via the FontFace API and maintains a registry
 *  of available font families. Works for DOM (UI layer) and PixiJS (2D layer)
 *  since both use the browser's font system. */

import { parseFontFilename, type FontInfo } from './fontNaming';
import { assetUrl } from './assetUrl';

export { parseFontFilename, type FontInfo };

// ── Registry ────────────────────────────────────────────

/** Loaded fonts indexed by family name → variant list */
const loadedFonts = new Map<string, FontInfo[]>();

/** All font asset paths that have been loaded (dedup guard) */
const loadedPaths = new Set<string>();

/** In-flight loads keyed by path, so concurrent callers for the same font share
 *  one underlying fetch/FontFace.load() instead of racing two registrations.
 *  Rejected loads are evicted (not cached permanently) so a failure can be retried. */
const loading = new Map<string, Promise<string>>();

async function doLoadFont(path: string): Promise<string> {
  const info = parseFontFilename(path);
  // QUOTE the CSS url() — an unquoted url() breaks on a SPACE (or other CSS-special
  // char) in the filename (e.g. "Geologica-Bold Dynamic.ttf"), failing face.load().
  // Escape any embedded double-quote/backslash so the quoted url() stays well-formed.
  const src = assetUrl(path).replace(/(["\\])/g, '\\$1');
  const face = new FontFace(info.family, `url("${src}")`, {
    weight: info.weight,
    style: info.style,
  });

  await face.load();
  document.fonts.add(face);
  loadedPaths.add(path);

  const variants = loadedFonts.get(info.family);
  if (!variants) {
    loadedFonts.set(info.family, [info]);
  } else {
    // Warn on a (weight, style) collision within the same family: a second file
    // normalizing to identical CSS coordinates means last-added wins in the browser.
    if (variants.some(v => v.weight === info.weight && v.style === info.style)) {
      console.warn(
        `[FontLoader] Family "${info.family}" already has a ${info.weight} ${info.style} variant; ` +
          `"${path}" collides and the browser will use the last-added one`,
      );
    }
    variants.push(info);
  }

  console.log(`[FontLoader] Loaded "${info.family}" (${info.weight} ${info.style}) from ${path}`);
  return info.family;
}

/** Load a single font file and register it with the browser. Returns the family name.
 *  Concurrent calls for the same path share one in-flight load. */
export function loadFont(path: string): Promise<string> {
  if (loadedPaths.has(path)) {
    return Promise.resolve(parseFontFilename(path).family);
  }

  const inflight = loading.get(path);
  if (inflight) return inflight;

  const promise = doLoadFont(path).finally(() => {
    // Evict the in-flight entry once settled. On success the path is now in
    // loadedPaths (fast path above); on failure eviction allows a retry.
    loading.delete(path);
  });
  loading.set(path, promise);
  return promise;
}

/** Load all font assets from an asset list. Typically called with the result of /api/scan-assets. */
export async function loadAllFonts(assets: { path: string; type: string }[]): Promise<void> {
  const fontAssets = assets.filter(a => a.type === 'font');
  if (fontAssets.length === 0) return;

  const results = await Promise.allSettled(fontAssets.map(a => loadFont(a.path)));
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn(`[FontLoader] ${failed.length}/${fontAssets.length} fonts failed to load`);
  }
}

/** Get list of unique loaded font family names (for Inspector dropdowns). */
export function getLoadedFontFamilies(): string[] {
  return Array.from(loadedFonts.keys()).sort();
}

/** Get all loaded font info (families with their variants). */
export function getLoadedFonts(): Map<string, FontInfo[]> {
  return loadedFonts;
}

/** Resolve a font asset path to its CSS family name. Returns the path as-is if not a font file. */
export function fontFamilyFromPath(path: string): string {
  return parseFontFilename(path).family;
}

/** Reverse lookup: find a representative asset path for a given CSS family name.
 *  Deterministic — prefers the regular (weight 400 / normal style) variant, then a
 *  normal-style variant, otherwise the first registered. Returns null if not found. */
export function fontPathFromFamily(family: string): string | null {
  const variants = loadedFonts.get(family);
  if (!variants || variants.length === 0) return null;
  const regular = variants.find(v => v.weight === '400' && v.style === 'normal');
  if (regular) return regular.path;
  const normal = variants.find(v => v.style === 'normal');
  return (normal ?? variants[0]).path;
}
