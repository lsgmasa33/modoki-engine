/** `collectComparableTraits` — the bag `getOverrideValues` diffs against the prefab base.
 *
 *  Extracted during the QA-CTX-0003 close-out sweep, because the two call sites had drifted:
 *  the serializer (`captureInstanceOverrides`) built it with `readTraitDataFull`, while the
 *  Apply/Revert DIALOG built its own with `readTraitData` — the curated `meta.fields` subset.
 *  So every persistent field a custom Inspector section owns (`Animator.clips`) and every AoS
 *  field (`SkinnedMeshRenderer.materials`, `AnimationLibrary.animSets`) was absent from the
 *  dialog's comparison and reported as un-overridden whatever its value, leaving the user
 *  unable to apply it while the scene file recorded it correctly.
 *
 *  These tests pin what the SHARED builder must include and exclude. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';
import { setCurrentWorld, registerEntity } from '../../src/runtime/core/ecs/world';
import type { TraitMeta } from '../../src/runtime/core/ecs/traitRegistry';

// SoA trait whose persistent `clips` is owned by a custom Inspector section, so it is
// deliberately absent from meta.fields — the real Animator's shape.
const AnimBank = trait({ clips: '[]' as string, clip: '' as string, time: 0, activeClip: '' as string });
// AoS trait — schema is a function, so readTraitDataFull falls back to the live object's keys.
const Materials = trait(() => ({ overrides: [] as string[], slot: 0 }));
const Marker = trait();

const animMeta = {
  name: 'AnimBank', trait: AnimBank, category: 'component' as const,
  fields: {
    time: { type: 'number' as const },
    // Read-back only — must be STRIPPED, or a live playhead reads as an override.
    activeClip: { type: 'string' as const, runtimeOnly: true },
  },
} as unknown as TraitMeta;
const matMeta = {
  name: 'Materials', trait: Materials, category: 'component' as const,
  fields: { slot: { type: 'number' as const } },
} as unknown as TraitMeta;
const markerMeta = { name: 'Marker', trait: Marker, category: 'tag' as const, fields: {} } as unknown as TraitMeta;
const piMeta = {
  name: 'PrefabInstance', trait: trait({ source: '', localId: 0 }), category: 'component' as const,
  fields: { source: { type: 'string' as const }, localId: { type: 'number' as const } },
} as unknown as TraitMeta;

let world: ReturnType<typeof createWorld>;
beforeEach(() => { world = createWorld(); setCurrentWorld(world); });
afterEach(() => { world.destroy(); });

async function collect(entityId: number, metas: TraitMeta[]) {
  const { collectComparableTraits } = await import('../../src/editor/scene/prefab');
  return collectComparableTraits(entityId, metas);
}

describe('collectComparableTraits', () => {
  it('includes a persistent field that is NOT in meta.fields (Animator.clips shape)', async () => {
    const e = world.spawn(AnimBank({ clips: '[{"name":"idle"}]', clip: 'idle', time: 0, activeClip: '' }));
    registerEntity(e);
    const out = await collect(e.id(), [animMeta]);
    expect(out.AnimBank.clips).toBe('[{"name":"idle"}]');
    expect(out.AnimBank.clip).toBe('idle');
  });

  it('includes an AoS object/array field', async () => {
    const e = world.spawn(Materials({ overrides: ['guid-a', 'guid-b'], slot: 1 }));
    registerEntity(e);
    const out = await collect(e.id(), [matMeta]);
    expect(out.Materials.overrides).toEqual(['guid-a', 'guid-b']);
  });

  it('STRIPS runtime-only read-back fields — a live playhead is not an override', async () => {
    const e = world.spawn(AnimBank({ clips: '[]', clip: '', time: 0, activeClip: 'idle' }));
    registerEntity(e);
    const out = await collect(e.id(), [animMeta]);
    expect('activeClip' in out.AnimBank).toBe(false);
  });

  it('excludes PrefabInstance — the instance link is never an override of itself', async () => {
    const e = world.spawn(AnimBank({ clips: '[]', clip: '', time: 0, activeClip: '' }));
    registerEntity(e);
    const out = await collect(e.id(), [animMeta, piMeta]);
    expect('PrefabInstance' in out).toBe(false);
  });

  it('omits a trait the entity does not carry, rather than emitting an empty bag', async () => {
    const e = world.spawn(AnimBank({ clips: '[]', clip: '', time: 0, activeClip: '' }));
    registerEntity(e);
    const out = await collect(e.id(), [animMeta, matMeta]);
    expect('Materials' in out).toBe(false);
  });

  it('includes a tag trait as an empty bag (present is the whole signal)', async () => {
    const e = world.spawn(AnimBank({ clips: '[]', clip: '', time: 0, activeClip: '' }), Marker);
    registerEntity(e);
    const out = await collect(e.id(), [animMeta, markerMeta]);
    expect(out.Marker).toEqual({});
  });
});
