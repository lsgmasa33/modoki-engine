/** Stable prefab-instance member GUIDs — deriveGuid + deriveInstanceMemberGuids. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes, PrefabInstance } from '../../src/runtime/traits';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { deriveInstanceMemberGuids } from '../../src/runtime/loaders/loadSceneFile';
import { deriveGuid, isGuid } from '../../src/runtime/loaders/assetManifest';

// deriveInstanceMemberGuids resolves traits via the registry (like loadSceneFile).
registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} });
registerTrait({ name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: {} });

describe('deriveGuid', () => {
  it('is deterministic and GUID-shaped', () => {
    const a = deriveGuid('root-1|2.3');
    expect(a).toBe(deriveGuid('root-1|2.3'));
    expect(isGuid(a)).toBe(true);
  });
  it('different seeds → different ids', () => {
    expect(deriveGuid('a')).not.toBe(deriveGuid('b'));
    expect(deriveGuid('root|1')).not.toBe(deriveGuid('root|2'));
  });
});

describe('deriveInstanceMemberGuids', () => {
  let world: ReturnType<typeof createWorld>;
  beforeEach(() => { world = createWorld(); });
  afterEach(() => { world.destroy(); });

  /** A scene-placed instance root (has a real guid) with two members lacking one. */
  function buildInstance(rootGuid: string) {
    const root = world.spawn(
      EntityAttributes({ guid: rootGuid, parentId: 0, name: 'Root' }),
      PrefabInstance({ localId: 1, rootInstanceId: 0 }),
    );
    const a = world.spawn(
      EntityAttributes({ guid: '', parentId: root.id(), name: 'A' }),
      PrefabInstance({ localId: 2, rootInstanceId: root.id() }),
    );
    const b = world.spawn(
      EntityAttributes({ guid: '', parentId: root.id(), name: 'B' }),
      PrefabInstance({ localId: 3, rootInstanceId: root.id() }),
    );
    return { root, a, b };
  }

  it('fills empty member guids deterministically; preserves the root guid', () => {
    const { root, a, b } = buildInstance('11111111-1111-1111-1111-111111111111');
    deriveInstanceMemberGuids(world);
    const ga = (a.get(EntityAttributes) as any).guid;
    const gb = (b.get(EntityAttributes) as any).guid;
    expect(isGuid(ga)).toBe(true);
    expect(isGuid(gb)).toBe(true);
    expect(ga).not.toBe(gb);                       // distinct members
    expect((root.get(EntityAttributes) as any).guid).toBe('11111111-1111-1111-1111-111111111111'); // root untouched
    // deterministic — derived from root guid + member localId
    expect(ga).toBe(deriveGuid('11111111-1111-1111-1111-111111111111|2'));
  });

  it('two instances of the same prefab give members non-colliding guids', () => {
    buildInstance('aaaaaaaa-1111-1111-1111-111111111111');
    buildInstance('bbbbbbbb-2222-2222-2222-222222222222');
    deriveInstanceMemberGuids(world);
    const guids = new Set<string>();
    world.query(EntityAttributes).updateEach(([ea]: any[]) => { if (ea.guid) guids.add(ea.guid); });
    // 2 roots + 4 members = 6 distinct guids, no collisions
    expect(guids.size).toBe(6);
  });

  it('is idempotent — a second pass does not change derived guids', () => {
    const { a } = buildInstance('33333333-3333-3333-3333-333333333333');
    deriveInstanceMemberGuids(world);
    const first = (a.get(EntityAttributes) as any).guid;
    deriveInstanceMemberGuids(world);
    expect((a.get(EntityAttributes) as any).guid).toBe(first);
  });

  it('leaves a member with no scene-anchored ancestor unaddressable (no throw)', () => {
    // An instance whose ROOT lacks a guid (nothing up the chain is scene-anchored)
    // — derivation has no anchor, so members stay empty rather than guessing.
    const orphanRoot = world.spawn(
      EntityAttributes({ guid: '', parentId: 0, name: 'OrphanRoot' }),
      PrefabInstance({ localId: 1, rootInstanceId: 0 }),
    );
    const orphanMember = world.spawn(
      EntityAttributes({ guid: '', parentId: orphanRoot.id(), name: 'OrphanMember' }),
      PrefabInstance({ localId: 2, rootInstanceId: orphanRoot.id() }),
    );
    expect(() => deriveInstanceMemberGuids(world)).not.toThrow();
    expect((orphanMember.get(EntityAttributes) as any).guid).toBe('');
  });

  it('never touches a non-PrefabInstance entity (only instance members get derived guids)', () => {
    const plain = world.spawn(EntityAttributes({ guid: '', parentId: 0, name: 'Plain' }));
    deriveInstanceMemberGuids(world);
    expect((plain.get(EntityAttributes) as any).guid).toBe('');
  });
});

/** Nested prefab instances — the case the `parentLocalId` step exists for. A
 *  nested-instance ROOT is distinguished by `parentLocalId` (which outer row
 *  produced it), NOT its (shared) inner localId. Without that, two sibling
 *  instances of the same prefab would derive colliding member guids. */
describe('deriveInstanceMemberGuids — nested instances', () => {
  let world: ReturnType<typeof createWorld>;
  beforeEach(() => { world = createWorld(); });
  afterEach(() => { world.destroy(); });

  /** Spawn an instance member exactly as instantiatePrefabIntoWorld leaves it:
   *  `localId` = its position in its own prefab; `parentLocalId` = the outer row
   *  that produced it (non-zero only on a nested-instance root). */
  const member = (guid: string, parentId: number, localId: number, parentLocalId = 0) =>
    world.spawn(
      EntityAttributes({ guid, parentId, name: 'm' }),
      PrefabInstance({ localId, parentLocalId, rootInstanceId: 0 }),
    );

  const ROOT = '11111111-2222-3333-4444-555555555555';

  it('derives a nested instance member through its parentLocalId-stepped root', () => {
    const outerRoot = member(ROOT, 0, 1);                 // scene-anchored
    const innerRoot = member('', outerRoot.id(), 1, 5);   // produced by outer row 5
    const innerMember = member('', innerRoot.id(), 2);    // ordinary inner member

    deriveInstanceMemberGuids(world);

    // innerRoot's step is its parentLocalId (5), not its localId (1).
    expect((innerRoot.get(EntityAttributes) as any).guid).toBe(deriveGuid(`${ROOT}|5`));
    // innerMember chains through innerRoot's step: ROOT|5.2.
    expect((innerMember.get(EntityAttributes) as any).guid).toBe(deriveGuid(`${ROOT}|5.2`));
  });

  it('gives two SIBLING nested instances of the same prefab non-colliding member guids', () => {
    const outerRoot = member(ROOT, 0, 1);
    // Two instances of the SAME inner prefab — identical inner localIds (1 root, 2
    // member) — distinguished only by the outer row (parentLocalId 2 vs 3).
    const aRoot = member('', outerRoot.id(), 1, 2);
    const aMember = member('', aRoot.id(), 2);
    const bRoot = member('', outerRoot.id(), 1, 3);
    const bMember = member('', bRoot.id(), 2);

    deriveInstanceMemberGuids(world);

    const g = (e: typeof aRoot) => (e.get(EntityAttributes) as any).guid;
    // Roots differ by the producing row.
    expect(g(aRoot)).toBe(deriveGuid(`${ROOT}|2`));
    expect(g(bRoot)).toBe(deriveGuid(`${ROOT}|3`));
    // Members — the headline: identical inner localIds, yet DISTINCT guids.
    expect(g(aMember)).toBe(deriveGuid(`${ROOT}|2.2`));
    expect(g(bMember)).toBe(deriveGuid(`${ROOT}|3.2`));
    expect(g(aMember)).not.toBe(g(bMember));
    // All four derived ids are unique + well-formed.
    const all = [g(aRoot), g(aMember), g(bRoot), g(bMember)];
    expect(new Set(all).size).toBe(4);
    expect(all.every(isGuid)).toBe(true);
  });

  it('accumulates the localId chain across two nesting levels', () => {
    // scene → outer instance → middle member → inner instance (3 deep).
    const outerRoot = member(ROOT, 0, 1);
    const outerMember = member('', outerRoot.id(), 4);    // ordinary member, localId 4
    const innerRoot = member('', outerMember.id(), 1, 7); // nested under that member, row 7
    const innerMember = member('', innerRoot.id(), 2);

    deriveInstanceMemberGuids(world);

    const g = (e: typeof outerMember) => (e.get(EntityAttributes) as any).guid;
    expect(g(outerMember)).toBe(deriveGuid(`${ROOT}|4`));
    expect(g(innerRoot)).toBe(deriveGuid(`${ROOT}|4.7`));
    expect(g(innerMember)).toBe(deriveGuid(`${ROOT}|4.7.2`));
  });

  it('is idempotent across nesting (a second pass is a no-op)', () => {
    const outerRoot = member(ROOT, 0, 1);
    const innerRoot = member('', outerRoot.id(), 1, 2);
    const innerMember = member('', innerRoot.id(), 2);
    deriveInstanceMemberGuids(world);
    const before = [innerRoot, innerMember].map((e) => (e.get(EntityAttributes) as any).guid);
    deriveInstanceMemberGuids(world);
    const after = [innerRoot, innerMember].map((e) => (e.get(EntityAttributes) as any).guid);
    expect(after).toEqual(before);
  });
});
