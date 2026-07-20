/** Asset-reference predicates — pure, ZERO imports, no DOM/Vite globals.
 *
 *  Lives apart from `assetManifest.ts` (which touches `window`/`import.meta.env`)
 *  so these can be imported from Node tooling — the Vite dev-server plugin and
 *  the scene validator/mutator — without dragging the browser runtime into a
 *  Node tsconfig. `assetManifest.ts` re-exports them to keep its public API. */

/** UUID v4 shape — 8-4-4-4-12 lowercase hex. We allow uppercase on read but
 *  always emit lowercase. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Managed asset file extensions — the file types the asset pipeline tracks by
 *  GUID. Fonts (.ttf/.woff) are intentionally excluded: `UIElement.fontFamily`
 *  is a CSS family name (or font path), not a manifest-asset GUID. */
const ASSET_PATH_RE =
  /\.(?:mesh|mat|prefab|scene|particle|shader|anim)\.json$|\.(?:glb|gltf|fbx|png|jpe?g|webp|hdr|exr)$/i;

/** Returns true if `ref` looks like a UUID (not a path, not a URL, not a sprite name). */
export function isGuid(ref: string | undefined | null): boolean {
  if (!ref) return false;
  return GUID_RE.test(ref);
}

/** Genuinely external resources that are NOT manifest assets and pass through
 *  reference resolution unchanged (remote CDN files, inline data/blob URIs). */
export function isExternalUrl(ref: string | undefined | null): boolean {
  if (!ref) return false;
  return /^(https?:|data:|blob:)/.test(ref);
}

/** Returns true if `ref` is a project-internal asset *path* (starts with `/`
 *  and ends with a managed asset extension). These are no longer valid
 *  references — everything must be a GUID. Used to reject path refs loudly. */
export function isInternalAssetPath(ref: string | undefined | null): boolean {
  if (!ref) return false;
  return ref.startsWith('/') && ASSET_PATH_RE.test(ref);
}

/** Generate a fresh UUID v4 string. (`crypto` is a global in both the browser
 *  and Node ≥ 19.) */
export function newGuid(): string {
  return crypto.randomUUID();
}

/** Deterministically derive a stable, GUID-shaped id from a seed string.
 *
 *  Used to give prefab-instance MEMBERS a stable per-instance identity so an entity outside the
 *  instance can reference them (UIAction `kind:'set'` targets). Same seed → same id every load;
 *  different instances seed from different root GUIDs, so members never collide.
 *
 *  ⚠️ **THE OUTPUT IS PERSISTED. THIS FUNCTION IS FROZEN.**
 *
 *  It is tempting to read "derived, so it need not be serialized" and conclude the algorithm is
 *  swappable. It is not. Two call sites write the result into files that outlive the process:
 *    - `SpritePicker.tsx` assigns `deriveGuid('sprite:' + textureGuid)` — the whole-image sprite id
 *      — into scene `Renderable2D`/UI refs. `asset-tree-shaker.ts` re-derives the same value to
 *      avoid shaking the texture out of a build, and `assetRefIntegrity.test.ts` validates against it.
 *    - Prefab-member ids are referenced from OUTSIDE the instance, and those referring entities
 *      are serialized.
 *  Change the seed format, the hash, or the layout, and every 2D sprite reference in every project
 *  silently dangles. It would need a migration of every scene, prefab and `.meta.json` first.
 *
 *  **Known-weak, deliberately contained.** This is four independent 32-bit FNV-1a hashes of
 *  `n + ':' + seed`, concatenated. FNV-1a was built for hash-table spread, not diffusion: after the
 *  final byte is XOR'd there is exactly one multiply left, and multiplication carries bits only
 *  upward — so a change in the LAST character of the seed barely reaches the high bits. Measured
 *  avalanche for a last-character change: the top output bit flips 6% of the time and the bottom bit
 *  99% (ideal is 50% for every bit; SHA-256 measures 0.49–0.52 across the board). Our seeds are
 *  `${anchor}|0.children.${i}` — siblings differ only in that suffix — so the leading hex chars of
 *  sibling ids are the least-diffused part of the hash.
 *
 *  In practice the four-way concatenation contains it: across 4,096 siblings the 3-hex prefix is 17%
 *  short of the uniform expectation (2,135 distinct vs 2,589), and by 4 hex it is indistinguishable
 *  from random. Full-length ids collide at random-UUID rates. So: fine as an identifier, but do NOT
 *  truncate a derived id below ~6 hex, and do not assume it has SHA-quality diffusion. If a migration
 *  ever happens for another reason, replace the body with truncated SHA-256 then. */
export function deriveGuid(seed: string): string {
  const fnv = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  const part = (n: number) => fnv(n + ':' + seed).toString(16).padStart(8, '0');
  const hex = part(0) + part(1) + part(2) + part(3); // 32 hex chars
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
