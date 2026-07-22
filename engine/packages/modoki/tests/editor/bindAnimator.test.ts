/** Binding an open .anim.json to an entity from the Animation panel's
 *  "No Animator bound" warning.
 *
 *  The load-bearing property: an entity WITHOUT an Animator must get the component
 *  and the clip in ONE step (the trait is added pre-populated), because a bound root
 *  whose bank is still empty is exactly the "animation data not assigned" state the
 *  button exists to clear. Re-binding a clip already in the bank must not append a
 *  duplicate entry. Mocks the world/undo layer (like addPropertyPicker.test) so no
 *  live koota world is needed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Fake world ──────────────────────────────────────────────────────────────
const ANIM = Symbol('AnimatorTrait');
const animMeta = { name: 'Animator', trait: ANIM } as unknown as { name: string; trait: symbol };

/** entityId → live Animator data ({} present, undefined = no Animator). */
let animData: Record<number, { clips?: string } | undefined> = {};
let missingTrait = false;

const findEntity = (id: number) => {
  if (!(id in animData)) return null; // entity doesn't exist
  const data = animData[id];
  return { has: () => data !== undefined, get: () => data };
};

vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  findEntity: (id: number) => findEntity(id),
  getAllEntities: () => [], // BindAnimatorPicker imports it; buildEntityRows takes entities as an arg
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => (missingTrait || n !== 'Animator' ? undefined : animMeta),
}));

const addTrait = vi.fn();
const writeField = vi.fn();
vi.mock('../../src/editor/undo/entityActions', () => ({
  addTraitToEntitiesWithUndo: (...a: unknown[]) => addTrait(...a),
  writeTraitFieldPerEntityWithUndo: (...a: unknown[]) => writeField(...a),
}));

const setAnimatorRoot = vi.fn();
const selectEntity = vi.fn();
vi.mock('../../src/editor/store/editorStore', () => ({
  useEditorStore: { getState: () => ({ setAnimatorRoot, selectEntity }) },
}));

const { planClipBinding, uniqueClipName, bindClipToEntity } = await import('../../src/editor/animation/bindAnimator');
const { buildEntityRows } = await import('../../src/editor/panels/animation/BindAnimatorPicker');

beforeEach(() => {
  animData = {};
  missingTrait = false;
  addTrait.mockReset(); writeField.mockReset(); setAnimatorRoot.mockReset(); selectEntity.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('uniqueClipName', () => {
  it('uses the preferred name when free, then suffixes', () => {
    expect(uniqueClipName([], 'walk')).toBe('walk');
    expect(uniqueClipName([{ name: 'walk', clip: 'g' }], 'walk')).toBe('walk2');
    expect(uniqueClipName([{ name: 'walk', clip: 'g' }, { name: 'walk2', clip: 'h' }], 'walk')).toBe('walk3');
  });
  it('falls back to "clip" for a blank preference', () => {
    expect(uniqueClipName([], '   ')).toBe('clip');
  });
});

describe('planClipBinding', () => {
  it('appends a new entry', () => {
    const plan = planClipBinding([{ name: 'idle', clip: 'g1' }], 'g2', 'walk');
    expect(plan.added).toBe(true);
    expect(plan.name).toBe('walk');
    expect(plan.bank).toEqual([{ name: 'idle', clip: 'g1' }, { name: 'walk', clip: 'g2' }]);
  });
  it('is a no-op when the GUID is already banked (re-bind adds no duplicate)', () => {
    const bank = [{ name: 'idle', clip: 'g1' }];
    const plan = planClipBinding(bank, 'g1', 'walk');
    expect(plan.added).toBe(false);
    expect(plan.name).toBe('idle');
    expect(plan.bank).toBe(bank);
  });
});

describe('bindClipToEntity', () => {
  it('adds the Animator PRE-POPULATED with the clip when the entity has none', () => {
    animData[7] = undefined; // entity exists, no Animator
    expect(bindClipToEntity(7, 'guid-1', 'spin')).toBe(true);
    expect(writeField).not.toHaveBeenCalled();
    expect(addTrait).toHaveBeenCalledTimes(1);
    const [ids, meta, values] = addTrait.mock.calls[0];
    expect(ids).toEqual([7]);
    expect(meta).toBe(animMeta);
    expect(JSON.parse((values as { clips: string }).clips)).toEqual([{ name: 'spin', clip: 'guid-1' }]);
    expect(setAnimatorRoot).toHaveBeenCalledWith(7);
    expect(selectEntity).toHaveBeenCalledWith(7);
  });

  it('appends to an existing Animator bank instead of re-adding the trait', () => {
    animData[3] = { clips: JSON.stringify([{ name: 'idle', clip: 'g0' }]) };
    expect(bindClipToEntity(3, 'guid-1', 'spin')).toBe(true);
    expect(addTrait).not.toHaveBeenCalled();
    expect(writeField).toHaveBeenCalledTimes(1);
    const [ids, , field, compute] = writeField.mock.calls[0];
    expect(ids).toEqual([3]);
    expect(field).toBe('clips');
    expect(JSON.parse((compute as () => string)())).toEqual([
      { name: 'idle', clip: 'g0' }, { name: 'spin', clip: 'guid-1' },
    ]);
    expect(setAnimatorRoot).toHaveBeenCalledWith(3);
  });

  it('re-binding an already-banked clip only sets the root — no write', () => {
    animData[3] = { clips: JSON.stringify([{ name: 'spin', clip: 'guid-1' }]) };
    expect(bindClipToEntity(3, 'guid-1', 'spin')).toBe(true);
    expect(addTrait).not.toHaveBeenCalled();
    expect(writeField).not.toHaveBeenCalled();
    expect(setAnimatorRoot).toHaveBeenCalledWith(3);
  });

  it('refuses (without touching the world) on a missing entity, trait, or GUID', () => {
    expect(bindClipToEntity(99, 'guid-1', 'spin')).toBe(false); // no such entity
    animData[1] = undefined;
    missingTrait = true;
    expect(bindClipToEntity(1, 'guid-1', 'spin')).toBe(false);  // Animator not registered
    missingTrait = false;
    expect(bindClipToEntity(1, '', 'spin')).toBe(false);        // clip has no GUID
    expect(addTrait).not.toHaveBeenCalled();
    expect(writeField).not.toHaveBeenCalled();
    expect(setAnimatorRoot).not.toHaveBeenCalled();
  });
});

describe('buildEntityRows', () => {
  const ents = [
    { id: 1, name: 'Root', traits: ['Transform'], parentId: 0, sortOrder: 0 },
    { id: 2, name: 'Arm', traits: ['Transform', 'Animator'], parentId: 1, sortOrder: 1 },
    { id: 3, name: 'Hand', traits: ['Transform'], parentId: 2, sortOrder: 0 },
    { id: 4, name: 'Config', traits: ['Transform'], parentId: 0, sortOrder: 2, isResource: true },
    { id: 5, name: '', traits: [], parentId: 999, sortOrder: 0 }, // orphan + unnamed
  ];

  it('nests by parent, marks Animators, and drops resource singletons', () => {
    const rows = buildEntityRows(ents, '', new Set([1, 2]));
    // Roots sort by sortOrder then name — the orphan (parent 999 → shown as a root)
    // ties with Root on sortOrder 0 and wins on name.
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ['Entity 5', 0], ['Root', 0], ['Arm', 1], ['Hand', 2],
    ]);
    expect(rows.find((r) => r.name === 'Arm')?.hasAnimator).toBe(true);
    expect(rows.find((r) => r.name === 'Root')?.hasChildren).toBe(true);
    expect(rows.some((r) => r.name === 'Config')).toBe(false);
  });

  it('collapses subtrees of unexpanded parents', () => {
    expect(buildEntityRows(ents, '', new Set()).map((r) => r.name)).toEqual(['Entity 5', 'Root']);
  });

  it('filters to a flat list so a deep match is never hidden by a collapsed parent', () => {
    const rows = buildEntityRows(ents, 'han', new Set());
    expect(rows.map((r) => [r.name, r.depth])).toEqual([['Hand', 0]]);
  });
});
