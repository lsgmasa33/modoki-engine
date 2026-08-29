/** materialExtras — the ONE place engine-added material properties are stored, so they survive
 *  every clone route this engine takes (#351).
 *
 *  ## The bug this exists to prevent
 *
 *  The engine augments `THREE.Material.prototype` with properties three does not know about
 *  (`lineColor`, `nprColorPreserve` — installed by `ensureLineColorOnMaterials`, below). Those
 *  accessors used to store into `_`-prefixed backing fields on the material, and **a `_` field
 *  survives no clone route in this engine**:
 *
 *    - `Material.copy()` (what a bare `.clone()` runs) copies a hand-written field list and has
 *      never heard of ours;
 *    - `cloneDerived` carries own properties across generically but skips `/^(is[A-Z]|_)/`,
 *      because `_` is also three's own convention for internals and copying those by reference is
 *      how a clone starts sharing state it should own.
 *
 *  So a mesh that was BOTH tinted and light-masked lost its tint amount: `tintedMaterial` set
 *  `nprColorPreserve` on the tint clone, `applyLightMask` then cloned THAT into a variant, and the
 *  variant's getter fell through to its `?? 0` default — full NPR greyscale fill, ignoring the
 *  authored `Tint.amount`. It failed in the confusing direction, because `.color` (a field
 *  `Material.copy()` DOES know) survived: the object looked tinted but the preserve strength was
 *  wrong, which reads as an NPR/lighting bug rather than a Tint one.
 *
 *  ## Why `userData`, and why that needed a change to `cloneDerived`
 *
 *  `userData` is the sanctioned place for "properties three does not own", and it is the one
 *  three's own `Material.copy()` carries. But note carefully: **`cloneDerived` deliberately
 *  SUPPRESSES `userData` across the clone** (#325 — `lightMaskVariants` parks a whole material
 *  object in `userData.__lightMaskBase`, and letting that through `Material.copy`'s
 *  `JSON.parse(JSON.stringify(...))` serialises an entire material graph, image data and all).
 *  So "put it in userData and the existing machinery carries it" is only HALF true, and the half
 *  that was missing is the exact route the bug takes. `cloneDerived` therefore carries THIS
 *  namespace explicitly and nothing else — a whitelist, not a relaxation of its userData rule.
 *
 *  ## ⚠️ The contract: JSON-SAFE PRIMITIVES ONLY
 *
 *  A bare `.clone()` carries `userData` through `JSON.parse(JSON.stringify(...))`, so anything
 *  stored here is round-tripped. A number, string or boolean survives that losslessly; **a class
 *  instance does not** — a `THREE.Color` comes back as a prototype-less `{r,g,b}`, which then
 *  fails the moment something calls `.getHex()` on it. That is why `lineColor` is stored as a hex
 *  NUMBER here and materialised into a `THREE.Color` by its accessor, rather than stored as the
 *  Color it presents as. `materialExtrasAreJsonSafe` pins the rule; a test drives it.
 *
 *  ## ⚠️ What this DOES change: the pipeline cache key, for exactly the repaired materials
 *
 *  An earlier version of this comment claimed the opposite — that `getMaterialCacheKey()` skips
 *  `/^(is[A-Z]|_)/` and `userData`, so these values were invisible to it before and after. **That
 *  was a category error, measured wrong.** The skip regex (`RenderObject.js:701`) tests the
 *  PROPERTY NAME, and `getKeys` (`RenderObject.js:5-37`) walks the prototype chain pushing every
 *  key that has a GETTER, enumerable or not. `lineColor` and `nprColorPreserve` are getters named
 *  without a `_`, so they were never skipped — where the BACKING field lives was always irrelevant
 *  to that loop.
 *
 *  The consequence is real, not just a wrong sentence. A number contributes
 *  `value !== 0 ? '1' : '0'` (`RenderObject.js:715`). A light-mask variant of a tint clone used to
 *  read `nprColorPreserve === 0` and contribute `'0'`; now it reads the carried `0.7` and
 *  contributes `'1'`. So those draws hash to a DIFFERENT pipeline than before — which is the
 *  correct direction (the variant now agrees with the tint clone it was cloned from, and #136 is
 *  the precedent for why a collision there is dangerous), but it is a change, and anyone reading
 *  first-frame compile counts should know it happened.
 *
 *  Second-order, accepted rather than fixed: `getMaterialCacheKey` now invokes a getter with a
 *  SIDE EFFECT — the first `lineColor` read allocates a Color and writes the `_lineColorCache`
 *  memo. Bounded (once per hex per material) and both memo keys are `_`-prefixed, so every loop
 *  that matters skips them; but it is new behaviour inside three's hot path.
 *
 *  What genuinely does not change: these reach the shader as per-material UNIFORMS via
 *  `materialReference(...)`, so one pipeline still serves many VALUES.
 */

import * as THREE from 'three';

/** `userData` key holding this engine's added material properties.
 *
 *  Namespaced under one key rather than spread across `userData` so `cloneDerived` can carry the
 *  whole set with a single whitelist entry — a per-field carry list is the thing that goes stale
 *  invisibly on the first field somebody adds. */
export const MATERIAL_EXTRAS_KEY = '__modokiMaterialExtras';

/** The engine-added properties. Every value must be a JSON-safe primitive — see the header. */
export interface MaterialExtras {
  /** NPR outline colour as a HEX NUMBER (not a `THREE.Color` — see the contract above). */
  lineColor?: number;
  /** NPR colour-preserve amount, 0..1. 0 = full NPR greyscale fill, 1 = keep the material colour. */
  nprColorPreserve?: number;
}

type WithUserData = { userData?: Record<string, unknown> };

/** The extras recorded on `m`, or `undefined` when it has none. Never allocates. */
export function readMaterialExtras(m: THREE.Material | WithUserData): MaterialExtras | undefined {
  const bag = (m as WithUserData).userData?.[MATERIAL_EXTRAS_KEY];
  // A bare `.clone()` round-trips this through JSON, so what comes back is a plain object — which
  // is exactly what we want, and why nothing here may be an instance of a class.
  return (bag && typeof bag === 'object' ? bag : undefined) as MaterialExtras | undefined;
}

/** Set one extra on `m`, creating the namespace if needed.
 *
 *  Writes a FRESH namespace object rather than mutating in place, matching `markDerived`: a
 *  material whose extras were carried from a base must not write back through a shared object and
 *  silently retune the base too. */
export function writeMaterialExtra<K extends keyof MaterialExtras>(
  m: THREE.Material | WithUserData, key: K, value: MaterialExtras[K],
): void {
  const target = m as WithUserData;
  const next = { ...readMaterialExtras(m), [key]: value };
  // THE SEAM for the JSON-safe contract, so it is enforced where extras are actually written
  // rather than only asserted in a test on hand-built objects. DEV-only: a violation costs a
  // silent `{r,g,b}` at render time in prod, which is bad, but throwing there would be worse.
  if (import.meta.env?.DEV && !materialExtrasAreJsonSafe(next)) {
    console.error(
      `[materialExtras] "${String(key)}" is not a JSON-safe primitive. userData is carried through `
      + 'JSON.parse(JSON.stringify(...)) by Material.copy(), so a class instance comes back '
      + 'prototype-less and fails on its next method call. Store a primitive (e.g. a hex number) '
      + 'and materialise the object in the accessor, the way lineColor does.', value,
    );
  }
  target.userData = { ...target.userData, [MATERIAL_EXTRAS_KEY]: next };
}

/** Copy `from`'s extras onto `to`, if it has any. Called by `cloneDerived` — the clone route that
 *  suppresses `userData` wholesale and so cannot pick these up on its own.
 *
 *  Shallow-copies the namespace so the clone owns its own bag: the two materials are independent
 *  from here on, and a later `writeMaterialExtra` on either cannot reach the other. */
export function carryMaterialExtras(from: THREE.Material | WithUserData, to: THREE.Material | WithUserData): void {
  const extras = readMaterialExtras(from);
  if (!extras) return;
  const target = to as WithUserData;
  target.userData = { ...target.userData, [MATERIAL_EXTRAS_KEY]: { ...extras } };
}

/** Does `value` obey the JSON-safe-primitive contract? Called by `writeMaterialExtra` under DEV —
 *  that is its seam — and exported so a test can assert the rule rather than restate it. */
export function materialExtrasAreJsonSafe(extras: unknown): boolean {
  if (extras == null || typeof extras !== 'object' || Array.isArray(extras)) return false;
  return Object.values(extras as Record<string, unknown>).every((v) => {
    const t = typeof v;
    // `undefined` is allowed as "not set" (JSON drops the key entirely, which reads back the same).
    return v === undefined || t === 'number' || t === 'string' || t === 'boolean';
  });
}

// Default outline color for materials that don't explicitly set one. Shared so
// the prototype getter doesn't allocate per access — which means EVERY material
// without an explicit `lineColor` returns the SAME Color instance (F8). If a
// caller mutated it in place (e.g. `mat.lineColor.setHex(...)` instead of
// `mat.lineColor = new Color(...)`), it would shift the default for all
// materials process-wide. `Object.freeze` makes that aliasing footgun throw
// (in strict mode) / no-op instead of silently corrupting the shared default.
// THREE.Color's mutators write `.r/.g/.b` directly, so freezing the instance
// blocks every in-place edit path. Read-only use (passing it to the Sobel/MRT
// node graph, copying via `.clone()`/`new Color().copy(default)`) is unaffected.
//
// ⚠️ The frozen default is only HALF the aliasing story since #351. A material that HAS an
// authored lineColor returns a per-material, NON-frozen memo, so `mat.lineColor.setHex(...)`
// succeeds — and diverges: it mutates the memo (the mesh renders the new colour) while the stored
// hex is unchanged, so every clone taken afterwards outlines in the OLD one. Before hex storage
// that call was at least coherent. **Always assign a fresh Color (`mat.lineColor = new Color(x)`),
// never mutate the one you read back.** No writer in this repo does the latter — `meshTemplateCache`
// and space-console's matcap/planet/stripes all assign — so this is an API footgun, not a live bug.
const _DEFAULT_LINE_COLOR = Object.freeze(new THREE.Color(0x000000)) as THREE.Color;

// Augment THREE.Material with `lineColor` + `nprColorPreserve` properties —
// every material answers to them, defaulting to black / 0. This lets us write
// `materialReference('lineColor','color')` and `materialReference('nprColorPreserve',
// 'float')` into the MRT and have them work for ALL materials (including ones
// imported from GLB) without patching every creation site. A material that
// wants a custom outline or to keep its color through NPR just assigns its own.
//
// PERMANENT, GLOBAL & IRREVERSIBLE (F8): this defines accessors on
// `THREE.Material.prototype` — the single shared prototype for EVERY material
// in the process. The patch is:
//   - global: it affects materials in other renderers/scenes, not just this
//     NPR instance, the moment any NPRPostProcess is constructed (or
//     nprFragmentOutput is called during prewarm);
//   - permanent: it is NEVER removed — `dispose()` does not (and cannot safely)
//     undo it, because other live materials may already depend on the accessors;
//   - idempotent: guarded by the module-level `_lineColorPatched` flag so it
//     runs exactly once regardless of how many NPR instances exist.
// Accept this as a one-time, process-lifetime contract. The accessors are
// `configurable: true` only so a future redefinition isn't fatal; do not rely
// on re-defining them. The shared default returned by the getter is frozen
// (see `_DEFAULT_LINE_COLOR`) so no consumer can mutate it through the alias.
//
// ⚠️ STORAGE: both values live in `userData` via `materialExtras`, NOT in `_`-prefixed
// backing fields (#351). A `_` field survives NEITHER clone route in this engine —
// `Material.copy()` doesn't know it and `cloneDerived` skips it as private — so a mesh
// that was both tinted and light-masked silently lost its `Tint.amount` and rendered at
// full NPR greyscale fill. `materialExtras.ts` has the full mechanism and the
// JSON-safe-primitives contract that makes it work through a bare `.clone()`.
let _lineColorPatched = false;
export function ensureLineColorOnMaterials() {
  if (_lineColorPatched) return;
  _lineColorPatched = true;
  Object.defineProperty(THREE.Material.prototype, 'lineColor', {
    // Presents as a `THREE.Color` but STORES a hex number, because a class instance cannot
    // survive `userData`'s JSON round-trip (it comes back a prototype-less `{r,g,b}` and then
    // throws on `.getHex()`). The materialised Color is memoised in a `_` field keyed on the hex
    // it was built from: that cache is derived state, so both clone routes dropping it is
    // CORRECT — the next read rebuilds it from the value that did survive.
    get(this: THREE.Material & { _lineColorCache?: THREE.Color; _lineColorCacheHex?: number }) {
      const hex = readMaterialExtras(this)?.lineColor;
      if (hex === undefined) return _DEFAULT_LINE_COLOR;
      if (!this._lineColorCache || this._lineColorCacheHex !== hex) {
        this._lineColorCache = new THREE.Color(hex);
        this._lineColorCacheHex = hex;
      }
      return this._lineColorCache;
    },
    // Takes a snapshot of the Color's hex rather than aliasing the instance. The one production
    // writer (`meshTemplateCache`, from a hex in the material JSON) constructs a fresh Color and
    // drops it, so nothing relies on the old by-reference behaviour — and by-reference is what
    // made the frozen shared default a footgun in the first place.
    set(this: THREE.Material & { _lineColorCache?: THREE.Color; _lineColorCacheHex?: number }, v: THREE.Color) {
      writeMaterialExtra(this, 'lineColor', v.getHex());
      this._lineColorCache = undefined;
      this._lineColorCacheHex = undefined;
    },
    configurable: true,
  });
  // Per-material NPR color-preserve amount (0..1). 0 = full NPR (grayscale fill),
  // 1 = keep the material's true color. Read into the lineColor MRT target's
  // alpha; the composite uses it to lerp the fill toward the lit color.
  Object.defineProperty(THREE.Material.prototype, 'nprColorPreserve', {
    get(this: THREE.Material) {
      return readMaterialExtras(this)?.nprColorPreserve ?? 0;
    },
    set(this: THREE.Material, v: number) {
      writeMaterialExtra(this, 'nprColorPreserve', v);
    },
    configurable: true,
  });
}
