/** GUARD: engine trait fields must be SCALAR (number / string / boolean), with a
 *  small, explicit allowlist of the array/object ("array-of-structure") fields
 *  that exist today.
 *
 *  Why this exists: a non-scalar trait field (array or object) is opaque to
 *  serialize, prefab-override diffing, and change-tracking, and must be deep-cloned
 *  at every boundary (undo snapshot, duplicate, prefab capture/apply/revert,
 *  set-after-mutate). That invariant isn't enforced in one place, so each new such
 *  field is a fresh chance to reintroduce the same class of bug. This test freezes
 *  the known set: add a new array/object field and the build goes red, pointing you
 *  at the alternatives (child entities / koota relation() / a JSON-string scalar
 *  like Collider2D.points / a GUID-referenced asset). See the audit for the full
 *  reasoning + migration recommendations.
 *
 *  A field encoded as a JSON *string* (e.g. Collider2D.points = "[[x,y],…]") is a
 *  SCALAR here and passes automatically — that's the sanctioned escape hatch.
 *
 *  Note: Koota REJECTS an array/object default in a plain `trait({…})` outright
 *  ("… is an array, which is not supported in traits"), so the only way to add a
 *  non-scalar field is the deliberate AoS callback form `trait(() => ({…}))` —
 *  which is exactly what this guard inspects (via the resolved default instance). */

import { describe, it, expect } from 'vitest';
import { assertExemptionLedger } from '../helpers/exemptionLedger';
import { createWorld, $internal, type Trait } from 'koota';
import * as RuntimeTraits from '../../src/runtime/traits';
import { Environment } from '../../src/three/traits/Environment';
import { Light } from '../../src/three/traits/Light';

// `TraitName.field` for every array/object field that legitimately exists today.
// Adding to this list is a deliberate act — prefer an escape hatch (see the header)
// before you do. Removing a field (e.g. SpriteAnimator.clips → asset ref) should
// also remove its entry; the ledger reports a row blessing a field that is gone.
const ALLOWLIST: ReadonlyArray<{ item: string; reason: string }> = [
  { item: 'UIAction.bindings', reason: 'UIActionBinding[] — inline per-instance button behaviour' },
  { item: 'MaterialInstance.overrides', reason: 'MaterialParamOverride[] — inline per-instance material param drivers (target + source per channel). Like UIAction.bindings: a small authored array, rewritten wholesale, and the array shape is what lets the Phase 4 Inspector/timeline bind each channel individually (a JSON-string blob would hide the channels).' },
  { item: 'AnimationLibrary.animSets', reason: 'string[] of animset GUID refs' },
  { item: 'AnimationLibrary.boneMaps', reason: 'Record<string,Record<string,string>> — retarget config' },
  { item: 'SkinnedMeshRenderer.materials', reason: 'Record<string,string> — per-instance submesh material refs' },
  // Input resource — a transient, runtime-only frame snapshot (axes + per-action
  // held/pressed/released maps). The bug class this guard protects against does NOT
  // apply: Input is spawned at runtime like Time and tagged Transient, so it is never
  // serialized; since #1248 it is a registered resource, and every duplicate path (the
  // Hierarchy, both agent duplicate-entity ops) refuses a resource, and it is never prefabbed. The nested maps mirror InputFrame
  // and are rewritten wholesale by inputSystem each frame. See runtime/traits/Input.ts.
  { item: 'Input.axes', reason: 'Record<Axis,number> — analog axis values this frame' },
  { item: 'Input.held', reason: 'Record<DigitalAction,boolean> — level state' },
  { item: 'Input.pressed', reason: 'Record<DigitalAction,boolean> — rising edges' },
  { item: 'Input.released', reason: 'Record<DigitalAction,boolean> — falling edges' },
  { item: 'Input.pointer', reason: 'PointerFrame — pos/down/drag of the active pointer, rewritten each frame' },
  { item: 'Input.gesture', reason: 'GestureFrame — multi-touch pan/pinch/tap, rewritten each frame (#443)' },
  // AudioSource.clips is a JSON-STRING scalar bank (like Collider2D.points), NOT a
  // non-scalar field — so it passes the guard automatically, no allowlist entry.
  // SpriteAnimator.clips was migrated to a GUID-referenced .spriteanim.json asset
  // (clipSet), so SpriteAnimator is now a fully-scalar trait — no allowlist entry.
];

/** A koota trait is a function carrying the internal symbol. */
function isTrait(v: unknown): v is Trait {
  return typeof v === 'function' && !!(v as unknown as Record<symbol, unknown>)[$internal];
}

/** Collect every engine trait as [name, trait], from the runtime barrel + the
 *  Three.js traits (which live outside it). */
function allEngineTraits(): [string, Trait][] {
  const out: [string, Trait][] = [];
  for (const [name, val] of Object.entries(RuntimeTraits)) {
    if (isTrait(val)) out.push([name, val]);
  }
  out.push(['Environment', Environment], ['Light', Light]);
  return out;
}

/** A value is scalar unless it's a non-null object or array. */
const isScalar = (v: unknown): boolean => v === null || typeof v !== 'object';

/** All non-scalar `TraitName.field` keys across the engine traits, read from the
 *  resolved default instance (works for both plain and AoS `trait(() => …)` forms). */
function nonScalarFields(): string[] {
  const world = createWorld();
  const found: string[] = [];
  for (const [name, trait] of allEngineTraits()) {
    const inst = world.spawn(trait).get(trait) as Record<string, unknown> | undefined;
    if (!inst) continue;
    for (const [field, value] of Object.entries(inst)) {
      if (!isScalar(value)) found.push(`${name}.${field}`);
    }
  }
  return found;
}

describe('engine trait fields are scalar (array-of-structure guard)', () => {
  it('discovers a non-trivial set of traits (sanity: barrel resolved)', () => {
    expect(allEngineTraits().length).toBeGreaterThan(30);
  });

  it('has no array/object trait field outside the explicit allowlist, and no stale entry', () => {
    // Two-way exact since it was written; on the shared ledger since #1140 so the rule is stated
    // once — a migrated field (SpriteAnimator.clips → an asset ref) reports its row as blessing
    // more than exists.
    assertExemptionLedger({
      label: 'ALLOWLIST in traitScalarFields',
      population: nonScalarFields().map((k) => ({ item: k, site: k })),
      exempt: ALLOWLIST,
      floor: 1,
      fix: 'Array-of-structure trait fields are a known bug source (see the file header). Prefer child '
        + 'entities / koota relation() / a JSON-string scalar / a GUID asset ref. If it is truly '
        + 'warranted, add it to ALLOWLIST in this test with a reason; a row blessing more than exists '
        + 'was migrated — remove it.',
    });
  });
});
