/** Font loader — loads font files via the FontFace API and maintains a registry
 *  of available font families. Works for DOM (UI layer) and PixiJS (2D layer)
 *  since both use the browser's font system. */

import { parseFontFilename, type FontInfo } from './fontNaming';
import { assetUrl, withCacheBust } from './assetUrl';
import { getAllAssets, getAssetEntry, resolveRef, onFontInvalidated, type FontManifestBlock } from './assetManifest';
import { isGuid } from '../core/assetRefRules';
import { createTeardownToken } from '../core/liveness';

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

/** The live `FontFace` object each path added to `document.fonts`, kept so a re-import
 *  can DELETE the superseded face. The browser owns a face until something removes it,
 *  so without this the old typeface stays registered forever and keeps rendering — the
 *  bug this map exists for (#276). */
const faces = new Map<string, FontFace>();

/** Teardown liveness — no per-key epoch: every invalidation/teardown invalidates wholesale. A
 *  load captures it before awaiting and refuses to register if it changed: otherwise a load of
 *  the OLD bytes that was still in flight when the re-import landed resolves afterwards and
 *  re-registers the stale face on top of the fresh one. Mirrors fontAtlasLoader's liveness guard. */
const liveness = createTeardownToken();

/** Drop the {@link FontInfo} a path contributed to {@link loadedFonts} (and the family
 *  key if that was its last variant). Called before a re-load so the reload re-registers
 *  exactly one variant instead of appending a duplicate — which would also trip the
 *  same-(weight,style) collision log against the font's own previous self. */
function forgetVariant(path: string): void {
  for (const [family, variants] of loadedFonts) {
    const i = variants.findIndex(v => v.path === path);
    if (i < 0) continue;
    variants.splice(i, 1);
    if (variants.length === 0) loadedFonts.delete(family);
  }
}

/** Filename without its directory. Hand-rolled rather than `node:path` — this module runs in the
 *  BROWSER, and it is called with native fs paths at build time too, so both separators count
 *  (same reasoning as `parseFontFilename`). */
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

async function doLoadFont(path: string): Promise<string> {
  const info = parseFontFilename(path);
  // `?v=<hash>` so a re-imported font is a NEW URL the browser/CDN has not cached —
  // without it the refetch below is served the old bytes and the reload is a no-op.
  // Same appender the SDF sibling's `fontUrls()` uses, and like it a no-op in dev
  // (the Vite dev server does not cache), so this is the production half of #276.
  // QUOTE the CSS url() — an unquoted url() breaks on a SPACE (or other CSS-special
  // char) in the filename (e.g. "Geologica-Bold Dynamic.ttf"), failing face.load().
  // Escape any embedded double-quote/backslash so the quoted url() stays well-formed.
  const src = withCacheBust(assetUrl(path), getAssetEntry(path)?.hash).replace(/(["\\])/g, '\\$1');
  const face = new FontFace(info.family, `url("${src}")`, {
    weight: info.weight,
    style: info.style,
  });

  const stillLive = liveness.capture();
  await face.load();
  // Invalidated (or torn down) while this was in flight: these are the OLD bytes and a
  // reload for the new ones is already running. Registering now would put the stale face
  // back on top — last-added wins, so it would silently beat the fresh one.
  if (!stillLive()) return info.family;
  document.fonts.add(face);
  // Delete the superseded face only AFTER its replacement is registered, so live text
  // never falls back to a system font for a frame. The ordering lives here, in the one
  // place a face is ever added, rather than in the invalidation path.
  const prev = faces.get(path);
  faces.set(path, face);
  if (prev && prev !== face) document.fonts.delete(prev);
  loadedPaths.add(path);

  // This path's PREVIOUS registration (a re-import) is replaced, not appended to —
  // otherwise the family collects a duplicate variant and the collision log fires
  // against the font's own former self. Done here rather than in the invalidation so
  // the registry keeps describing what is actually registered in `document.fonts`:
  // a reload that FAILS leaves the old variant listed, matching the old face that is
  // still rendering.
  forgetVariant(path);

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

  const promise: Promise<string> = doLoadFont(path).finally(() => {
    // Evict the in-flight entry once settled. On success the path is now in
    // loadedPaths (fast path above); on failure eviction allows a retry.
    // ONLY if this load still owns the slot: an invalidation mid-flight starts a
    // REPLACEMENT load for the same path, and an unconditional delete here would
    // evict that newer entry when this older load settles — so a concurrent caller
    // would miss the in-flight reload and start a third, redundant load. Harmless
    // before #276 (nothing removed a path from `loading` out of band, so an entry
    // could only ever be its own); reachable the moment invalidation exists.
    if (loading.get(path) === promise) loading.delete(path);
  });
  loading.set(path, promise);
  return promise;
}

/** Re-register a font whose bytes/settings changed, so DOM + PixiJS text picks up the new
 *  typeface without an editor restart — the browser-`FontFace` counterpart to
 *  fontAtlasLoader's `invalidateFont`, and the reason a re-import no longer leaves the
 *  two text systems disagreeing on screen about the same font (#276).
 *
 *  Only re-loads a font this module actually registered: a path that was never loaded has
 *  nothing stale to replace, and eagerly loading it here would FontFace-load fonts no scene
 *  asked for. The old face is not deleted here — {@link doLoadFont} deletes it once the
 *  replacement is registered, so a failed reload leaves the old typeface rendering rather
 *  than dropping the family to a system fallback. */
export function invalidateFontFace(path: string): void {
  // Keyed on `faces` (a registered face is what makes a re-import worth acting on) rather
  // than on `loadedPaths`, because a FAILED reload clears both `loadedPaths` and `loading`
  // and would otherwise read identically to "never loaded" — silently dropping every later
  // re-import and stranding the font on the stale face until an editor restart. `faces`
  // survives a failed reload precisely because the old face is still registered.
  if (!faces.has(path) && !loading.has(path)) return;
  liveness.invalidateAll();  // any in-flight load is now carrying the OLD bytes — refuse it
  loading.delete(path);
  loadedPaths.delete(path);
  void loadFont(path).catch(e => {
    console.warn(`[FontLoader] reload after re-import failed for ${path} — the previous ` +
      `typeface stays registered: ${e instanceof Error ? e.message : String(e)}`);
  });
}
// Re-register on any font re-import / Font-Inspector change, the same signal the SDF
// loader listens to. Resolves guid → path because this module is keyed by path.
onFontInvalidated(guid => {
  const path = resolveRef(guid);
  if (path) invalidateFontFace(path);
});

/** Full teardown — remove every registered face from `document.fonts` and clear the
 *  registry (called from disposeAllCachedResources, mirroring fontAtlasLoader's
 *  `disposeAllFonts`). Without the `document.fonts.delete` the faces outlive the
 *  registry that tracked them and can never be removed afterwards. */
export function disposeAllFontFaces(): void {
  if (typeof document !== 'undefined' && document.fonts) {
    for (const face of faces.values()) document.fonts.delete(face);
  }
  faces.clear();
  loadedPaths.clear();
  loadedFonts.clear();
  loading.clear();
  familyWarned.clear();
  liveness.invalidateAll();  // invalidate every in-flight load
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
  // In PARALLEL, not one family after another: this is awaited as a scene resource, and a stack
  // naming a Latin face plus a multi-megabyte CJK fallback would otherwise make scene load wait
  // for their SUM instead of the slower one. Every other scene resource is acquired in parallel.
  const counts = await Promise.all(candidates.map(loadOneFamily));
  return counts.reduce((a, b) => a + b, 0);
}

/** One family of a `font-family` value. Split out so {@link loadFontFamily} can run the
 *  candidates concurrently. */
async function loadOneFamily(family: string): Promise<number> {
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
          `[FontLoader] font family "${family}" matches no font asset, so nothing was registered for ` +
            `it — and the build's font scan uses the SAME rule, so it will not ship a source either. ` +
            `Expected if "${family}" is a system font. Otherwise check the FILENAME, which is where ` +
            `the family comes from, and its CASE — the match is exact: ` +
            `VarelaRound-Regular.ttf => "Varela Round".`,
        );
      }
    }
    return 0;
  }

  // It resolves now → forget the warning, so a genuine LATER break (an asset deleted
  // mid-session in the editor) warns again instead of being silenced for the session.
  // Same shape as fontAtlasLoader's `unknownSeen.delete`.
  familyWarned.delete(family);

  const results = await Promise.allSettled(loadable.map(a => loadFont(a.path)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn(
      `[FontLoader] ${failed.length}/${results.length} variants of "${family}" failed to load — ` +
        failed.map(f => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join('; '),
    );
  }
  return results.length - failed.length;
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

/** A `UIElement.fontFamily` REF → the CSS family name to put in a `font-family` style (#231).
 *
 *  The field holds a font-asset GUID like every other asset ref, so resolution is
 *  guid → manifest path → {@link fontFamilyFromPath}. Returns `undefined` when the GUID
 *  resolves to nothing (a deleted font, or a manifest that has not loaded yet) — the caller
 *  decides what to fall back to, since "no font" is not an error worth blanking text over.
 *
 *  ⚠️ A non-GUID value is LEGACY: before #231 this field stored the CSS family name itself.
 *  Such a value is returned unchanged (it is already a family name) — the migration's
 *  read-side fallback. The warn-once lives at the UI seam (`ui/fontFamilyRef.ts`), which is
 *  the only place that knows an *authored* value is being read rather than an internal call. */
export function familyForFontRef(ref: string): string | undefined {
  if (!ref) return undefined;
  if (!isGuid(ref)) return ref;                 // legacy CSS family name
  // ⚠️ The asset must actually BE a font. `fontFamilyFromPath` derives a family from any
  // filename — it never looks at the extension — so a texture GUID pasted into `fontFamily`
  // would resolve to the plausible-looking family "hero sprite" and be returned as a SUCCESS,
  // silently: the caller's "this ref resolves to nothing" warning never fires, the DOM gets an
  // inert `font-family`, and the text renders in the browser default with no diagnostic
  // anywhere. Typing a syntactically-valid GUID into the field is enough to reach this
  // (`isAcceptableTypedRef` checks GUID SHAPE, not the asset's type), so it is not a
  // hand-edit-only path.
  const entry = getAssetEntry(ref);
  if (!entry || entry.type !== 'font') return undefined;
  return fontFamilyFromPath(entry.path);
}

/** FontFace-register every variant of the family a `UIElement.fontFamily` ref names — the
 *  scene-resource acquire for a `type:'font-family'` entry (#231). Accepts a GUID or a legacy
 *  family name (see {@link familyForFontRef}). Returns the number of variants registered;
 *  never rejects, for the reasons {@link loadFontFamily} does not. */
export async function loadFontFamilyForRef(ref: string): Promise<number> {
  const family = familyForFontRef(ref);
  if (!family) {
    if (ref && isGuid(ref)) {
      console.warn(
        `[FontLoader] font ref ${ref} resolves to no FONT asset — DOM text using it falls back ` +
        `to the browser default. Either the font was deleted/moved without re-saving the scene, ` +
        `or the GUID names an asset of another type (a texture, a mesh) that was pasted into a ` +
        `font field.`,
      );
    }
    return 0;
  }
  return loadFontFamily(family);
}
