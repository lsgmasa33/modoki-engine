/** Font loader — loads font files via the FontFace API and maintains a registry
 *  of available font families. Works for DOM (UI layer) and PixiJS (2D layer)
 *  since both use the browser's font system. */

import { parseFontFilename, type FontInfo } from './fontNaming';
import { assetUrl } from './assetUrl';
import { getAllAssets, type FontManifestBlock } from './assetManifest';

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

/** Filename without its directory. Hand-rolled rather than `node:path` — this module runs in the
 *  BROWSER, and it is called with native fs paths at build time too, so both separators count
 *  (same reasoning as `parseFontFilename`). */
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

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
    // A (weight, style) collision within the same family means last-added wins in the browser.
    // TWO KINDS, and only one is a problem:
    //   - DIFFERENT files normalizing to the same CSS coordinates — a real ambiguity, because which
    //     typeface you get depends on load order. Worth a warning.
    //   - THE SAME font file shipped twice under different paths — most often a game carrying its own
    //     copy of one of the engine's bundled families. `loadAllFonts` loads every `font` asset in
    //     the manifest, engine and game alike, so this is expected rather than wrong: identical bytes
    //     mean last-added-wins picks the same typeface either way. Warning here trained people to
    //     ignore a warning that CAN matter.
    // Basename is the discriminator: same filename => same font shipped twice.
    const clash = variants.find(v => v.weight === info.weight && v.style === info.style);
    if (clash) {
      const sameFile = basename(clash.path) === basename(path);
      const detail = `Family "${info.family}" already has a ${info.weight} ${info.style} variant`;
      if (sameFile) {
        console.log(
          `[FontLoader] ${detail}; "${path}" is the SAME font file as "${clash.path}" ` +
            `(a duplicate copy — harmless, but the game could drop its own and use the engine's)`,
        );
      } else {
        console.warn(
          `[FontLoader] ${detail}; "${path}" is a DIFFERENT file that collides — which typeface ` +
            `wins depends on load order. Rename one so they resolve to distinct families.`,
        );
      }
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

/** Load all font assets from an asset list. Typically called with the result of /api/scan-assets.
 *  Skips any manifest entry whose baked `font` block has `sourceShipped === false` — a
 *  build-time decision (see the asset-shaker's `shipSource` logic) that the source
 *  `.ttf`/`.otf` wasn't shipped because no DOM/PixiJS consumer named its family. Loading
 *  it anyway would 404 and pad the failure summary below with a "failure" that is
 *  actually working as designed; absent/`true` (always true in dev, which serves
 *  everything off disk) loads as before. */
export async function loadAllFonts(assets: { path: string; type: string; font?: FontManifestBlock }[]): Promise<void> {
  const fontAssets = assets.filter(a => a.type === 'font' && a.font?.sourceShipped !== false);
  if (fontAssets.length === 0) return;

  const results = await Promise.allSettled(fontAssets.map(a => loadFont(a.path)));
  const failed = results
    .map((r, i) => ({ result: r, path: fontAssets[i].path }))
    .filter((x): x is { result: PromiseRejectedResult; path: string } => x.result.status === 'rejected');
  if (failed.length > 0) {
    const detail = failed
      .map(f => `${f.path}: ${f.result.reason instanceof Error ? f.result.reason.message : String(f.result.reason)}`)
      .join('; ');
    console.warn(`[FontLoader] ${failed.length}/${fontAssets.length} fonts failed to load — ${detail}`);
  }
}

/** CSS families that name no asset BY DESIGN — the generic keywords, the `ui-*` system
 *  aliases, and the CSS-wide keywords. A scene authoring one of these is asking for
 *  whatever the browser has, so {@link loadFontFamily} must resolve them to "nothing to
 *  load" rather than to "this font is missing". Compared case-insensitively (CSS family
 *  keywords are case-insensitive; a QUOTED family name is a custom family and never a
 *  keyword, which is why the quote-stripping below happens after this test). */
const CSS_GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'math', 'emoji', 'fangsong',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
  'inherit', 'initial', 'revert', 'revert-layer', 'unset',
]);

/** Warn-once per family, so a UI tree with 200 strings in one missing family logs once. */
const familyWarned = new Set<string>();

/** Split a CSS `font-family` VALUE into its candidate family names. Usually one name
 *  (`UIElement.fontFamily` is written by the Inspector's font picker as a resolved family),
 *  but a human can type a stack — `"Varela Round", sans-serif` — and each segment has to be
 *  looked up separately or the whole string reads as one absent family. */
function cssFamilyCandidates(value: string): string[] {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0 && !CSS_GENERIC_FAMILIES.has(part.toLowerCase()))
    // Strip the CSS quoting a family with spaces/punctuation may carry.
    .map(part => (/^(".*"|'.*')$/.test(part) ? part.slice(1, -1) : part))
    .filter(part => part.length > 0);
}

/** FontFace-register every manifest font asset belonging to a CSS family NAME — the
 *  `UIElement.fontFamily` counterpart to {@link loadFont}'s per-path load, and the reason a
 *  scene's `{type:'font', path:'<family name>'}` resource is a real acquire rather than a
 *  no-op (#253). ALL of the family's variants are loaded, not just one: a UI that authors
 *  `fontWeight: 700` needs the Bold file registered under the same family or the browser
 *  synthesizes a fake bold from the regular.
 *
 *  ⚠️ Matching is `parseFontFilename(path).family`, deliberately the SAME rule the build's
 *  `resolveFontsByFamily` (asset-tree-shaker.ts) uses to decide whether a font's source
 *  `.ttf` is worth shipping. The two must agree: a family this resolves but the build does
 *  not is a font that works in the editor and is absent from the shipped game.
 *
 *  Returns the number of variants registered. 0 means nothing was loaded — either the family
 *  names no asset (warned once) or there is no DOM at all (headless: silently 0, so a scene
 *  load in the verification harness neither warns nor throws). Never rejects: a failed
 *  FontFace load is warned and counted out, because a font is not worth failing a scene load
 *  over. */
export async function loadFontFamily(value: string): Promise<number> {
  if (!value) return 0;
  // Headless (verification harness, node-env tests): no FontFace API and no document to add
  // a face to. Nothing renders there, so this is "nothing to do", not a failure.
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return 0;

  const candidates = cssFamilyCandidates(value);
  if (candidates.length === 0) return 0;

  let registered = 0;
  for (const family of candidates) {
    const inManifest = getAllAssets().filter(
      a => a.type === 'font' && parseFontFilename(a.path).family === family,
    );
    // `sourceShipped === false` = the shaker dropped the source `.ttf` next to its atlas, so
    // the path is in the manifest but 404s. Reported separately below: "the build dropped it"
    // is a different fix from "no such font", and the first reads as the second otherwise.
    const loadable = inManifest.filter(a => a.font?.sourceShipped !== false);

    if (loadable.length === 0) {
      if (!familyWarned.has(family)) {
        familyWarned.add(family);
        if (inManifest.length > 0) {
          console.warn(
            `[FontLoader] font family "${family}" resolves to ${inManifest.map(a => a.path).join(', ')}, ` +
              `whose source the build did not ship (shipSource:'never', or no DOM usage detected) — ` +
              `text using it falls back to the browser default.`,
          );
        } else {
          console.warn(
            `[FontLoader] font family "${family}" matches no font asset — text using it falls back to ` +
              `the browser default. (Expected if "${family}" is a system font; otherwise check the ` +
              `filename: the family is derived from it, e.g. VarelaRound-Regular.ttf => "Varela Round".)`,
          );
        }
      }
      continue;
    }

    // It resolves now → forget the warning, so a genuine LATER break (an asset deleted
    // mid-session in the editor) warns again instead of being silenced for the session.
    // Same shape as fontAtlasLoader's `unknownSeen.delete`.
    familyWarned.delete(family);

    const results = await Promise.allSettled(loadable.map(a => loadFont(a.path)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    registered += results.length - failed.length;
    if (failed.length > 0) {
      console.warn(
        `[FontLoader] ${failed.length}/${results.length} variants of "${family}" failed to load — ` +
          failed.map(f => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join('; '),
      );
    }
  }
  return registered;
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
