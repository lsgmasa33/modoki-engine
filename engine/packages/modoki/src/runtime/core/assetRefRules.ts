/** Asset-reference predicates — pure, ZERO imports, no DOM/Vite globals.
 *
 *  Lives apart from `assetManifest.ts` (which touches `window`/`import.meta.env`)
 *  so these can be imported from Node tooling — the Vite dev-server plugin and
 *  the scene validator/mutator — without dragging the browser runtime into a
 *  Node tsconfig. `assetManifest.ts` re-exports them to keep its public API. */

/** UUID v4 shape — 8-4-4-4-12 lowercase hex. We allow uppercase on read but
 *  always emit lowercase. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Managed asset file suffixes — the file kinds the asset pipeline tracks by GUID, and
 *  therefore the kinds a literal PATH must be rejected for (a path ref works in dev off
 *  disk and breaks once the build hashes/relocates the file — docs/build.md, the #53 class).
 *
 *  ⚠️ This duplicates `loaders/assetTypeClassifier.ts`'s `JSON_ASSET_SUFFIX_TYPE` +
 *  `BINARY_EXT_TYPE`, which are the single source of truth for "what is a managed asset".
 *  The duplication is forced, not sloppy: this file is L0 `core/` and may import NOTHING
 *  (docs/architecture-layers.md), while the classifier is L3 `loaders/`. So the lists are
 *  kept honest by a TEST instead of by an import —
 *  `tests/assets/assetPathPredicate.test.ts` fails if a kind is added there and not here.
 *
 *  That guard exists because this list had ALREADY drifted, silently, in both directions:
 *  it covered `.anim.json` but not `.animset.json` / `.spriteanim.json` / `.timeline.json` /
 *  `.rig2d.json`, and no audio or video extension at all — so a literal path in
 *  `SkeletalAnimator.animSet`, `SpriteAnimator.clipSet`, `Director.timeline`,
 *  `SkinnedSprite2D.rig`, `AudioSource.clip` or `VideoPlayer.clip` fell through every
 *  rejection site (`resolveRef`, the scene validator, `assertNoPathRefs`, `diagnose`) and
 *  was passed through as if it were a usable URL. Found by the #123 close-out sweep — the
 *  same "a ref the guard cannot see" pattern, one layer down.
 *
 *  FONTS (.ttf/.otf/.woff/.woff2) are in this list as of #231. They were excluded for one
 *  reason only: `UIElement.fontFamily` held a CSS family name (or a font path) rather than a
 *  manifest GUID, so the answer for a font path depended on the FIELD, not the extension —
 *  which is why the field-aware `isInternalFontPath` existed alongside this predicate
 *  (QA-INSP-0004). #231 made `fontFamily` a GUID ref like every other one, so there is no
 *  longer a field where a literal font path is legitimate, and the split has been retired. */
const JSON_ASSET_SUFFIXES = [
  'scene', 'atlas', 'mesh', 'mat', 'prefab', 'shader', 'particle',
  'animset', 'spriteanim', 'rig2d', 'anim', 'level', 'wave', 'timeline', 'court',
] as const;
const BINARY_ASSET_EXTS = [
  'glb', 'gltf', 'fbx',
  'ttf', 'otf', 'woff', 'woff2',
  'png', 'jpg', 'jpeg', 'webp',
  'hdr', 'exr',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac',
  'mp4', 'mov', 'm4v', 'webm', 'mkv',
] as const;
const ASSET_PATH_RE = new RegExp(
  `\\.(?:${JSON_ASSET_SUFFIXES.join('|')})\\.json$|\\.(?:${BINARY_ASSET_EXTS.join('|')})$`,
  'i',
);

/** Returns true if `ref` looks like a UUID (not a path, not a URL, not a sprite name). */
export function isGuid(ref: string | undefined | null): boolean {
  if (!ref) return false;
  return GUID_RE.test(ref);
}

/** A RUNTIME guid (#1210): the address `spawnEntity` mints for an entity spawned with an empty
 *  `EntityAttributes.guid`. Shape `00000000-GGGG-GGGG-0000-NNNNNNNNNNNN` — a 32-bit world
 *  generation, then a 48-bit per-generation spawn counter. Deterministic (same spawn order →
 *  same guids) and valid only until its world is swapped out.
 *
 *  It is an ADDRESS, never a persistent identity. Everything that treats a non-empty guid as
 *  "this entity is saved/anchored" must read it through {@link durableGuid}, and nothing may
 *  write one to a file or to storage that outlives the process — the counter restarts, so a
 *  persisted runtime guid names a DIFFERENT entity next session.
 *
 *  Cannot collide with a v4 (`newGuid`): a v4's fourth group starts with the variant nibble
 *  8-b, never `0`. The all-zero guid is excluded (generation 0 is never minted) because it is
 *  already a placeholder elsewhere. */
const RUNTIME_GUID_RE = /^00000000-([0-9a-f]{4})-([0-9a-f]{4})-0000-[0-9a-f]{12}$/i;

export function isRuntimeGuid(ref: string | undefined | null): boolean {
  if (!ref) return false;
  const m = RUNTIME_GUID_RE.exec(ref);
  return !!m && (m[1] !== '0000' || m[2] !== '0000');
}

/** Format a runtime guid. `generation` must be ≥ 1; both parts are masked to their widths. */
export function formatRuntimeGuid(generation: number, ordinal: number): string {
  // Generation 0 formats as the all-zero placeholder shape, which `isRuntimeGuid` REJECTS — so a
  // 0 (or a wrapped 2^32) would pass every durableGuid guard and tripwire as if it were durable.
  if (!Number.isInteger(generation) || generation < 1 || generation > 0xffffffff) {
    throw new RangeError(`formatRuntimeGuid: generation must be 1..0xffffffff (got ${generation})`);
  }
  const g = generation.toString(16).padStart(8, '0');
  // 48 bits exceed the 32-bit ops, so split into a high 16 and low 32.
  const hi = Math.floor(ordinal / 0x100000000) & 0xffff;
  const lo = ordinal >>> 0;
  const n = hi.toString(16).padStart(4, '0') + lo.toString(16).padStart(8, '0');
  return `00000000-${g.slice(0, 4)}-${g.slice(4)}-0000-${n}`;
}

/** Parse a runtime guid back into its parts, or null when `ref` is not one. */
export function parseRuntimeGuid(ref: string | undefined | null): { generation: number; ordinal: number } | null {
  if (!isRuntimeGuid(ref)) return null;
  const s = ref as string;
  const generation = parseInt(s.slice(9, 13) + s.slice(14, 18), 16);
  const ordinal = parseInt(s.slice(24), 16);
  return { generation, ordinal };
}

/** The entity guid if it is DURABLE — safe to persist, to anchor a derivation on, or to treat as
 *  "this entity already has an identity" — else `''`. A runtime guid reads as `''` here, so every
 *  fill-if-empty site that routes through this mints a real guid over it instead of keeping it. */
export function durableGuid(guid: string | undefined | null): string {
  return guid && !isRuntimeGuid(guid) ? guid : '';
}

/** Every runtime guid anywhere inside `value` — strings, array items, object values AND object
 *  keys (`+added.<guid>`-style keys) — with the path it was found at. The tripwire for files and
 *  storage: a runtime guid must never be persisted (see {@link isRuntimeGuid}). */
export function findRuntimeGuids(value: unknown, path = ''): { path: string; guid: string }[] {
  const out: { path: string; guid: string }[] = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (depth > 64) return;
    if (typeof v === 'string') {
      // Cheap prefix test first: a scene file holds thousands of strings.
      if (v.length >= 36 && v.includes('00000000-')) {
        for (const m of v.matchAll(/00000000-[0-9a-f]{4}-[0-9a-f]{4}-0000-[0-9a-f]{12}/gi)) {
          if (isRuntimeGuid(m[0])) out.push({ path: p, guid: m[0] });
        }
      }
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((item, i) => walk(item, `${p}[${i}]`, depth + 1)); return; }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const cp = p ? `${p}.${k}` : k;
      walk(k, `${cp} (key)`, depth + 1);
      walk(child, cp, depth + 1);
    }
  };
  walk(value, path, 0);
  return out;
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
 *    - `editor/panels/spritePickerGroups.ts` derives `deriveGuid('sprite:' + textureGuid)` — the
 *      whole-image sprite id — for the SpritePicker's "whole" button and SkinEditor's drag-drop,
 *      which write it into scene `Renderable2D`/UI refs and rig2d `parts[].sprite`.
 *      `asset-tree-shaker.ts` re-derives the same value to avoid shaking the texture out of a
 *      build, and `assetRefIntegrity.test.ts` validates against it. (Both editor callers go
 *      through `wholeImageSpriteRef`, which returns undefined when the sprite does not exist —
 *      a sliced sheet has none. See docs/textures.md § Gotchas.)
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

/** The guid a prefab-instance MEMBER derives on load: `anchor` is the durable guid of its nearest
 *  guid-carrying ancestor, `path` the step ids from just below that ancestor down to the member
 *  ({@link memberStepId}). The ONE spelling of the rule — `deriveInstanceMemberGuids` applies it on
 *  load, and both duplicate paths (`remintSceneEntityGuids` for a scene file, `regenerateSnapshotGuids`
 *  for an editor subtree) predict it with it, so a copy's refs land where a reload puts the members. */
export function deriveMemberGuid(anchor: string, path: readonly number[]): string {
  return deriveGuid(`${anchor}|${path.join('.')}`);
}

/** A member's step in {@link deriveMemberGuid}'s path: its `PrefabInstance.localId` — EXCEPT a
 *  nested-instance root, whose localId is the (shared) inner root id; its distinguishing position is
 *  `parentLocalId` (which OUTER row produced it). An entity with no `PrefabInstance` steps by 0. */
export function memberStepId(pi: { localId?: number; parentLocalId?: number } | null | undefined): number {
  return pi ? (pi.parentLocalId || pi.localId || 0) : 0;
}

/** `value` with every string VALUE that is a key of `remap` replaced by its mapped value — the
 *  reference half of a duplicate, wherever the reference sits (`parentId`, any registry `entityRef`
 *  field including a game's own, `UIAction.bindings[].target`). A walk rather than a field list, so a
 *  newly registered ref field needs nothing kept in sync. Object KEYS are not rewritten. Arrays and
 *  PLAIN objects are copied only where something inside them changed; anything else (a class
 *  instance, a typed array) is returned as-is, because the editor hands the result to live trait
 *  stores. Callers must not put `''` in `remap`, or every empty string would be rewritten. */
export function remapGuidValues(value: unknown, remap: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return remap.get(value) ?? value;
  if (Array.isArray(value)) {
    const out = value.map((v) => remapGuidValues(v, remap));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const entries = Object.entries(value);
    const mapped = entries.map(([, v]) => remapGuidValues(v, remap));
    if (mapped.every((v, i) => v === entries[i]![1])) return value;
    // Every key is DEFINED, not assigned: a parsed document can carry an own `__proto__` key, which
    // `out[k] = v` would turn into a prototype assignment instead of a copied field.
    const out: Record<string, unknown> = {};
    entries.forEach(([k], i) => {
      Object.defineProperty(out, k, { value: mapped[i], enumerable: true, writable: true, configurable: true });
    });
    return out;
  }
  return value;
}
