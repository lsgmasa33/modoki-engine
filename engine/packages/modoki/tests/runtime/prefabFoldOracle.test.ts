/** #1880 T3: the fold's ORACLE. One field of one nested member is stated in some of the layers around it, through
 *  either carrier (the legacy path-keyed values, the member rows) or both, and the member must show the value of the
 *  OUTERMOST layer that states it. That is Unity's rule, not a comparison of two implementations: "an overridden property
 *  value on a Prefab instance always takes precedence over the value from the Prefab Asset", and across nesting levels an
 *  outer override stays until it is reverted (docs.unity3d.com Manual/PrefabInstanceOverrides, PrefabOverridesMultiLevel).
 *  Within ONE layer a member row beats that layer's own legacy value (#1880 § 2 F1, #1877 S4 option (b)).
 *
 *  Why an oracle and not a twin: the expansion-twin parity test compares the spawner with the pure fold, and both carry
 *  #1877's 3b S4 (every layer's legacy values folded first, then every layer's rows over them), so it could not see it.
 *  This test held S4 as KNOWN_OPEN on both readers until #1877's fix landed, and turned red then, as it was built to.
 *
 *  Both readers are asked: the pure fold (`effectivePrefabMemberTraitsAt`, what the editor's effective base and the
 *  validator read) and the spawner (`instantiatePrefabIntoWorld`, what a load builds). A random stack is drawn per case
 *  from a seeded generator, so a failure names its case and replays exactly. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0, nodeGuid: '' as string, parentNodeGuid: '' as string });

let testWorld: ReturnType<typeof createWorld>;

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: vi.fn(),
  findEntityById: (id: number, world: any) => [...world.entities].find((e: any) => e.id() === id),
  spawnEntity: (world: any, ...traits: any[]) => world.spawn(...traits),
  setStructureCallback: vi.fn(),
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: '', parentId: 0 } },
    { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: '', localId: 0, rootInstanceId: 0, parentLocalId: 0, nodeGuid: '', parentNodeGuid: '' } },
  ];
  return { getAllTraits: () => traits, getTraitByName: (n: string) => traits.find((t) => t.name === n) };
});
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  loadModelTemplates: vi.fn().mockResolvedValue(undefined),
  getCachedPrefab: () => null,
}));
vi.mock('../../src/runtime/ui/uiTreeStore', () => ({ markUIDirty: vi.fn() }));

beforeEach(() => { testWorld = createWorld(); });
afterEach(() => { testWorld.destroy(); });

// ── The chain ──────────────────────────────────────────────────────────────────────────────────────────────────────
// L0: root (localId 1) and the member M (localId 2) whose field is asked. Li (i ≥ 1): root (1) and a nested row (2)
// expanding L(i-1). The instance is of L<depth>; the outermost layer is the scene entry of that instance.

type Carrier = 'legacy' | 'row' | 'both';
type Field = 'x' | 'y' | 'z';
/** A layer's statement of the field: through which carrier, and the value (a `both` layer states two values). */
interface Statement { carrier: Carrier; legacy?: number; row?: number }
/** `layers[i]` is the layer at depth i: 1..depth are the nested rows (Li's row 2), depth + 1 is the scene entry. */
interface Case { depth: number; field: Field; base: number; layers: Record<number, Statement> }

const BASE = { x: 1, y: 1, z: 1 };
/** A row's nodeGuid: a REAL guid, since a member row names a row only through one (`docRows` indexes `isGuid` ids). */
const nodeGuid = (doc: number, what: 'N' | 'M' | 'R') => `0000000${'NMR'.indexOf(what)}-0000-4000-8000-${doc.toString(16).padStart(12, '0')}`;

/** The rows' localIds from the frame of Li (exclusive) down to L0: L(i-1)'s row 2, …, L1's row 2 — i - 1 steps. */
const rowPath = (fromDoc: number): number[] => Array.from({ length: fromDoc - 1 }, () => 2);
/** The member-row key from the frame BELOW Li's row down to M, by nodeGuid (`memberRowsIn`'s spelling). */
const memberKey = (fromDoc: number): string => `/${[...Array.from({ length: fromDoc - 1 }, (_, k) => nodeGuid(fromDoc - 1 - k, 'N')), nodeGuid(0, 'M')].join('/')}`;

/** A layer's two carriers as the fields of a row (or of the scene entry): legacy `overrides` when M is a DIRECT member of
 *  the frame below (the row at L1), else path-keyed `nestedOverrides`; and a member row keyed by nodeGuids. */
function channels(fromDoc: number, field: Field, s: Statement | undefined) {
  if (!s) return {};
  const out: Record<string, unknown> = {};
  if (s.legacy !== undefined) {
    const at = { 2: { Transform: { [field]: s.legacy } } };
    const path = rowPath(fromDoc);
    if (path.length === 0) out.overrides = at; else out.nestedOverrides = { [path.join('.')]: at };
  }
  if (s.row !== undefined) out.members = { [memberKey(fromDoc)]: { traits: { Transform: { [field]: s.row } } } };
  return out;
}

function docs(c: Case): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const root = (name: string, g: string) => ({ localId: 1, name, nodeGuid: g, traits: { EntityAttributes: { name, parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } });
  out.set('L0', { id: 'L0', rootLocalId: 1, entities: [
    root('L0R', nodeGuid(0, 'R')),
    { localId: 2, name: 'M', nodeGuid: nodeGuid(0, 'M'), traits: { EntityAttributes: { name: 'M', parentId: 1 }, Transform: { ...BASE, [c.field]: c.base } } },
  ] });
  for (let i = 1; i <= c.depth; i++) {
    out.set(`L${i}`, { id: `L${i}`, rootLocalId: 1, entities: [
      root(`L${i}R`, nodeGuid(i, 'R')),
      { localId: 2, name: `N${i}`, nodeGuid: nodeGuid(i, 'N'), prefab: `L${i - 1}`, traits: { EntityAttributes: { name: `N${i}`, parentId: 1 } }, ...channels(i, c.field, c.layers[i]) },
    ] });
  }
  return out;
}

/** Unity's answer: the outermost layer that states the field; within it, its member row over its own legacy value. */
function oracle(c: Case): number {
  for (let i = c.depth + 1; i >= 1; i--) {
    const s = c.layers[i];
    if (s) return s.row ?? s.legacy!;
  }
  return c.base;
}

/** #1877 3b S4's shape: the winning layer states only the LEGACY value, and some layer inside it states a member row.
 *  Until #1877 the fold merged every layer's legacy values first and every layer's rows over them, so the inner row won
 *  (this test held it as KNOWN_OPEN, and went red when the fix landed). Kept so the premise can show the draw covers it. */
function isS4(c: Case): boolean {
  let winner = 0;
  for (let i = c.depth + 1; i >= 1 && !winner; i--) if (c.layers[i]) winner = i;
  if (!winner || c.layers[winner]!.row !== undefined) return false;
  for (let i = winner - 1; i >= 1; i--) if (c.layers[i]?.row !== undefined) return true;
  return false;
}

// ── The draw ───────────────────────────────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function draw(seed: number): Case {
  const r = mulberry32(seed);
  const depth = 1 + Math.floor(r() * 4);
  const field = (['x', 'y', 'z'] as const)[Math.floor(r() * 3)]!;
  const layers: Record<number, Statement> = {};
  let v = 10;
  for (let i = 1; i <= depth + 1; i++) {
    const k = r();
    if (k < 0.3) continue;
    const carrier: Carrier = k < 0.55 ? 'legacy' : k < 0.8 ? 'row' : 'both';
    layers[i] = { carrier, ...(carrier !== 'row' ? { legacy: v++ } : {}), ...(carrier !== 'legacy' ? { row: v++ } : {}) };
  }
  return { depth, field, base: 1, layers };
}

// ── The two readers ────────────────────────────────────────────────────────────────────────────────────────────────

async function pureFold(c: Case): Promise<number | undefined> {
  const { effectivePrefabMemberTraitsAt } = await import('../../src/runtime/loaders/prefabOverrides');
  const all = docs(c);
  const scene = channels(c.depth + 1, c.field, c.layers[c.depth + 1]);
  const traits = effectivePrefabMemberTraitsAt(all.get(`L${c.depth}`), Array.from({ length: c.depth }, () => 2), 2, (g) => all.get(g), {
    overrides: scene.overrides as never, nestedOverrides: scene.nestedOverrides as never, members: scene.members as never,
  });
  return (traits?.Transform as Record<string, number> | undefined)?.[c.field];
}

async function spawner(c: Case): Promise<number | undefined> {
  const { instantiatePrefabIntoWorld } = await import('../../src/runtime/loaders/loadSceneFile');
  const all = docs(c);
  const scene = channels(c.depth + 1, c.field, c.layers[c.depth + 1]);
  instantiatePrefabIntoWorld(testWorld, all.get(`L${c.depth}`) as never, 0, undefined, `L${c.depth}`,
    scene.overrides as never, scene.members ? { members: scene.members as never } : undefined, undefined,
    scene.nestedOverrides as never, undefined, { read: (g: string) => all.get(g) as never });
  let out: number | undefined;
  testWorld.query(PrefabInstance, Transform).updateEach(([pi, tf]) => {
    const p = pi as Record<string, unknown>;
    if (p.source === 'L0' && p.localId === 2) out = (tf as Record<string, number>)[c.field];
  });
  return out;
}

// ── The check ──────────────────────────────────────────────────────────────────────────────────────────────────────

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
const describeCase = (seed: number, c: Case) => `seed ${seed}: depth ${c.depth}, ${c.field}, layers ${JSON.stringify(c.layers)}`;

/** Every case, read one way; the disagreements with the oracle. */
async function sweep(read: (c: Case) => Promise<number | undefined>): Promise<string[]> {
  const wrong: string[] = [];
  for (const seed of SEEDS) {
    const c = draw(seed);
    testWorld.destroy(); testWorld = createWorld();
    const got = await read(c);
    const want = oracle(c);
    if (got === want) continue;
    wrong.push(`${describeCase(seed, c)}: got ${got}, want ${want}`);
  }
  return wrong;
}

describe('#1880 T3: the outermost layer that states a field wins, whichever carrier states it', () => {
  it('the draw covers every shape the oracle distinguishes (premise)', () => {
    const cases = SEEDS.map(draw);
    expect(cases.some((c) => c.depth >= 3)).toBe(true);
    for (const carrier of ['legacy', 'row', 'both'] as const) expect(cases.some((c) => Object.values(c.layers).some((s) => s.carrier === carrier))).toBe(true);
    // The two orders that matter: a legacy layer OUTSIDE a row layer (S4's shape), and a row layer outside a legacy one.
    expect(cases.some(isS4)).toBe(true);
    expect(cases.some((c) => { const ks = Object.keys(c.layers).map(Number).sort((a, b) => b - a); return ks.length >= 2 && c.layers[ks[0]!]!.row !== undefined && c.layers[ks[1]!]!.carrier === 'legacy'; })).toBe(true);
  });

  for (const [name, read] of [['the pure fold (effective base, validator)', pureFold], ['the spawner (a load)', spawner]] as const) {
    it(`${name}: every case matches the oracle`, async () => {
      const wrong = await sweep(read);
      expect(wrong, wrong.slice(0, 5).join('\n')).toEqual([]);
    });
  }
});
