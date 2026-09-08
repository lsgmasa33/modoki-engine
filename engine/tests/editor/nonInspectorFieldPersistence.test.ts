/** A persistent SoA field that is NOT in the trait's curated `meta.fields` must
 *  still survive the two PREFAB paths — `serializePrefab` (the prefab file) and
 *  `captureInstanceOverrides` (a scene's instance override map).
 *
 *  `meta.fields` is the INSPECTOR's field list, not the persistence list. A trait
 *  whose field is owned by a custom Inspector section omits it there on purpose —
 *  `Animator.clips`/`clip` (AnimatorClipsSection), `SpriteAnimator.clip`/`clips`
 *  (SpriteAnimatorSection), `UIElement.elementType`. Both prefab paths used
 *  `readTraitData` (a `meta.fields`-only read) for SoA traits, so those fields were
 *  silently dropped on save — the scene serialize path already walks the koota
 *  SCHEMA instead, which is the whole reason it doesn't have this bug.
 *
 *  Animator is the case that surfaced it, but the class is wider — every SoA field
 *  currently absent from its `meta.fields` was at risk on both prefab paths:
 *  `AudioSource.clips` (a whole clip bank), `Text3D`/`Text2D.opacity`+`outlineOpacity`,
 *  `Time.timeScale`, `EntityAttributes.editorFolder`, `SpriteAnimator.clip`. All
 *  are authored values, none runtime read-back — which is why keying persistence on
 *  the schema is right, not merely more permissive. (`UIElement`'s four min/max unit
 *  fields — `minWidthUnit`/`maxWidthUnit`/`minHeightUnit`/`maxHeightUnit` — used to be
 *  in this same "absent from meta.fields" class too; #549 registered them in the
 *  Inspector, so they are no longer an example here, but this schema-keyed
 *  persistence is still what carried them safely in the meantime. `Renderable2D.
 *  orderInLayer`, `VideoPlayer.fadeOutSec` and `UIElement.flexWrap` were three more
 *  siblings of the same gap — all three registered since, so they too are no longer
 *  examples of a field missing from `meta.fields`, only of why this schema-keyed
 *  persistence had to exist in the meantime.)
 *
 *  Live symptom that produced this test (2026-07-31, `games/3d-test/runtime/assets/
 *  scenes/skinned-test.json`): a load→save REMOVED `entities[10](Cone).overrides.1
 *  .Animator.clips` (a populated bank naming a real clip guid) and `.clip: "skin"`,
 *  while ADDING `fadeDuration: 0` — the exact signature of a `meta.fields`-keyed read
 *  standing in for the schema. */

import { describe, it, expect } from 'vitest';
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import {
  instantiatePrefab,
  captureInstanceOverrides,
  applyOverridesByRootInstance,
  serializePrefab,
  type PrefabFile,
} from '@modoki/engine/editor';

registerAllTraits();

const BANK = '[{"name":"skin","clip":"f1cc3b85-2c23-457b-938a-3470ada21b36"}]';

/** A prefab with NO Animator at localId 1 — so an Animator on the instance is an
 *  ADDED-TRAIT override, which is the case the live scene hit. */
function makePrefab(): PrefabFile {
  return {
    version: 1,
    name: 'non-inspector-fields',
    rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Cone', traits: {
        Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        EntityAttributes: { name: 'Cone', parentId: 0, layer: '3d' },
      } },
    ],
  };
}

function setTrait(ecsId: number, traitName: string, data: Record<string, unknown>): void {
  const meta = getTraitByName(traitName)!;
  const entity = [...getCurrentWorld().entities].find((e) => (e as { id(): number }).id() === ecsId)!;
  if (!(entity as { has(t: unknown): boolean }).has(meta.trait)) {
    (entity as { add(i: unknown): void }).add((meta.trait as (d: unknown) => unknown)(data));
  } else {
    const cur = (entity as { get(t: unknown): unknown }).get(meta.trait) as Record<string, unknown>;
    (entity as { set(t: unknown, d: unknown): void }).set(meta.trait, { ...cur, ...data });
  }
}

describe('non-Inspector SoA fields survive prefab persistence', () => {
  it('captureInstanceOverrides keeps Animator.clips/clip on an added-trait override', () => {
    const prefab = makePrefab();
    const rootId = instantiatePrefab(prefab);
    setTrait(rootId, 'Animator', { clips: BANK, clip: 'skin', playing: true, loop: true });

    const captured = captureInstanceOverrides(rootId, prefab);

    expect(captured[1]?.Animator).toBeDefined();
    expect(captured[1].Animator.clips).toBe(BANK);
    expect(captured[1].Animator.clip).toBe('skin');
    // The curated fields that DID survive before are still there.
    expect(captured[1].Animator.playing).toBe(true);
    // Runtime read-backs stay out (they are runtimeOnly in meta.fields).
    expect(captured[1].Animator.activeClip).toBeUndefined();
    expect(captured[1].Animator.fadeFrom).toBeUndefined();
  });

  it('applyOverridesByRootInstance writes Animator.clips/clip back onto the instance', () => {
    // The READ side of the same bug, and the one the live run exposed after the write
    // side was fixed: the stored fields round-tripped through save but came back
    // EMPTY, because apply gated on `meta.fields` and dropped them on load.
    const prefab = makePrefab();
    const rootId = instantiatePrefab(prefab);

    applyOverridesByRootInstance(rootId, { 1: { Animator: { clips: BANK, clip: 'skin' } } });

    const meta = getTraitByName('Animator')!;
    const entity = [...getCurrentWorld().entities].find((e) => (e as { id(): number }).id() === rootId)!;
    const live = (entity as { get(t: unknown): unknown }).get(meta.trait) as Record<string, unknown>;
    expect(live.clips).toBe(BANK);
    expect(live.clip).toBe('skin');

    // …and a genuinely unknown key from an older file is still dropped.
    applyOverridesByRootInstance(rootId, { 1: { Animator: { notAField: 7 } } });
    const after = (entity as { get(t: unknown): unknown }).get(meta.trait) as Record<string, unknown>;
    expect(after.notAField).toBeUndefined();
  });

  it('applyOverridesByRootInstance keeps EntityAttributes.editorFolder', () => {
    // Before the schema rule, this field needed a hand-written escape hatch in BOTH
    // apply paths (`|| (meta.name === 'EntityAttributes' && field === 'editorFolder')`)
    // because it is a real per-instance field with no Inspector metadata. The schema
    // check subsumes it, so the special case is gone — this pins the behaviour it used
    // to buy: a foldered prefab instance keeps its Hierarchy folder when the tag rides
    // the override map (e.g. an /api/scene-mutate edit).
    const prefab = makePrefab();
    const rootId = instantiatePrefab(prefab);

    applyOverridesByRootInstance(rootId, { 1: { EntityAttributes: { editorFolder: 'Props/Rocks' } } });

    const meta = getTraitByName('EntityAttributes')!;
    const entity = [...getCurrentWorld().entities].find((e) => (e as { id(): number }).id() === rootId)!;
    const live = (entity as { get(t: unknown): unknown }).get(meta.trait) as Record<string, unknown>;
    expect(live.editorFolder).toBe('Props/Rocks');
  });

  it('serializePrefab keeps Animator.clips/clip in the prefab file', async () => {
    const prefab = makePrefab();
    const rootId = instantiatePrefab(prefab);
    setTrait(rootId, 'Animator', { clips: BANK, clip: 'skin' });

    const out = await serializePrefab(rootId, 'non-inspector-fields');
    expect(out).not.toBeNull();
    const root = out!.entities.find((e) => e.localId === out!.rootLocalId)!;
    const animator = root.traits.Animator as Record<string, unknown>;

    expect(animator).toBeDefined();
    expect(animator.clips).toBe(BANK);
    expect(animator.clip).toBe('skin');
    expect(animator.activeClip).toBeUndefined(); // runtimeOnly, still dropped
  });
});
