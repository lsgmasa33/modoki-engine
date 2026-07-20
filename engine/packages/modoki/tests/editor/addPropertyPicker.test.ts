/** AddPropertyPicker pure builders — collectCandidates + buildPropertyTree.
 *  Guards the "which fields are animatable / how the entity tree prunes" logic, the only
 *  path to authoring new tracks. Mocks the entity index + trait registry (like
 *  animEntityIndex.test) so no live world is needed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Entities: Root(1) → Arm(2) → Hand(3). Hand has no animatable fields (should prune).
let entities: { id: number; name: string; parentId: number }[] = [];
let version = 0;

// Per-entity trait metas the picker reads via getEntityTraits.
const traitsById: Record<number, { name: string; category?: string; fields: Record<string, { type: string; options?: string[]; readOnly?: boolean }> }[]> = {
  1: [
    { name: 'EntityAttributes', category: 'core', fields: { name: { type: 'string' } } }, // excluded trait
    { name: 'Transform', category: 'core', fields: { x: { type: 'number' }, y: { type: 'number' }, locked: { type: 'number', readOnly: true }, label: { type: 'string' } } },
  ],
  2: [
    { name: 'Transform', category: 'core', fields: { x: { type: 'number' } } },
    { name: 'Flag', category: 'tag', fields: { on: { type: 'boolean' } } }, // tag category excluded
  ],
  3: [
    { name: 'Label', category: 'core', fields: { text: { type: 'string' } } }, // string → not animatable → node pruned
  ],
};

// MaterialInstance override data the picker reads via readTraitData (per entity id).
const materialDataById: Record<number, { overrides: unknown[] }> = {};

vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getAllEntities: () => entities,
  getStructureVersion: () => version,
  getEntityTraits: (id: number) => traitsById[id] ?? [],
  readTraitData: (id: number, meta: { name: string }) =>
    meta.name === 'MaterialInstance' ? materialDataById[id] : undefined,
}));

const { clearAnimEntityIndex } = await import('../../src/editor/animation/entityIndex');
const { collectCandidates, buildPropertyTree } = await import('../../src/editor/panels/animation/AddPropertyPicker');

beforeEach(() => {
  clearAnimEntityIndex();
  version = 0;
  entities = [
    { id: 1, name: 'Root', parentId: 0 },
    { id: 2, name: 'Arm', parentId: 1 },
    { id: 3, name: 'Hand', parentId: 2 },
  ];
});

describe('collectCandidates', () => {
  it('includes animatable fields under the root, excluding excluded traits / tags / readOnly / non-animatable types', () => {
    const cands = collectCandidates(1);
    const labels = cands.map((c) => `${c.path}::${c.label}`).sort();
    expect(labels).toEqual(['::Transform.x', '::Transform.y', 'Arm::Transform.x']);
    // EntityAttributes (excluded), Transform.locked (readOnly), Transform.label (string),
    // Flag (tag category), Label.text (string) are all absent.
  });

  it('exposes only CONSTANT-source MaterialInstance overrides as nested-path candidates', () => {
    // Entity 4 (child of Root) has a MaterialInstance with 3 overrides: a constant color prop,
    // a constant scalar prop, and a time-driven uniform. Only the two CONSTANT ones are keyframeable.
    entities.push({ id: 4, name: 'Glow', parentId: 1 });
    traitsById[4] = [{ name: 'MaterialInstance', category: 'component', fields: { overrides: { type: 'materialOverrides' } } }];
    materialDataById[4] = { overrides: [
      { target: 'color', kind: 'prop', source: { type: 'constant' } },     // → color candidate
      { target: 'roughness', kind: 'prop', source: { type: 'constant' } }, // → number candidate
      { target: 'glow', kind: 'uniform', source: { type: 'time' } },       // procedurally driven → excluded
    ] };
    const mat = collectCandidates(1).filter((c) => c.trait === 'MaterialInstance');
    expect(mat.map((c) => `${c.field}::${c.label}::${c.type}`).sort()).toEqual([
      'overrides.0.source.value::Material.color::color',
      'overrides.1.source.value::Material.roughness::number',
    ]);
    delete traitsById[4];
    delete materialDataById[4];
  });
});

describe('buildPropertyTree', () => {
  it('builds the root subtree, attaches addable fields, and prunes empty branches (Hand)', () => {
    const tree = buildPropertyTree(collectCandidates(1), 1, new Set(), '');
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root.id).toBe(1);
    expect(root.fields.map((f) => f.label).sort()).toEqual(['Transform.x', 'Transform.y']);
    expect(root.children.map((c) => c.name)).toEqual(['Arm']);
    const arm = root.children[0];
    expect(arm.path).toBe('Arm');
    expect(arm.fields.map((f) => f.label)).toEqual(['Transform.x']);
    expect(arm.children).toHaveLength(0); // Hand pruned (no animatable fields)
  });

  it('hides already-tracked fields (existing set)', () => {
    const tree = buildPropertyTree(collectCandidates(1), 1, new Set(['|Transform|x']), '');
    expect(tree[0].fields.map((f) => f.label)).toEqual(['Transform.y']); // x hidden
  });

  it('filters by query and prunes non-matching branches', () => {
    // Only the Arm entity matches "arm"; the root has no matching field → whole tree is Arm-rooted-or-empty.
    const tree = buildPropertyTree(collectCandidates(1), 1, new Set(), 'arm');
    // Root node survives only as a path to Arm (root's own fields don't match, but Arm does).
    const armNode = tree[0]?.children.find((c) => c.name === 'Arm') ?? (tree[0]?.name === 'Arm' ? tree[0] : undefined);
    expect(armNode?.fields.map((f) => f.label)).toEqual(['Transform.x']);
  });
});
