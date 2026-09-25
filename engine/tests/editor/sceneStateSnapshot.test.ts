/** Percept Phase 2 (Snapshot truth & safety) — dumpSceneState:
 *   S1: `where` surfaces parse/unknown errors instead of silently returning all;
 *       resource entities excluded by default; limit + truncated flag.
 *   S2: full-fidelity trait values (readTraitDataFull) via `full`; `where` queries
 *       the FULL field set (Decision A), so an uncurated field is still filterable. */

import { describe, it, expect, beforeAll } from 'vitest';
import { trait } from 'koota';
import { expectInOrder } from '@modoki/engine/testing/inOrder';
import { registerTrait, getCurrentWorld, EntityAttributes } from '@modoki/engine/runtime';
import { worldTransforms, deactivatedEntities } from '@modoki/engine/runtime';
import { dumpSceneState, DEFAULT_INDEX_LIMIT, DEFAULT_TARGETED_LIMIT } from '../../app/debug/agentBridge';

// SoA trait whose curated meta.fields OMITS `b` (present in the koota schema) — the
// exact shape that exposes the readTraitData-vs-readTraitDataFull discrepancy.
const P2Full = trait({ a: 0, b: 0 });
// A resource-category trait → its entity is flagged isResource.
const P2Res = trait({ path: '' });
// A queryable component for the `where` tests.
const P2Where = trait({ y: 0 });

let resId = -1;

beforeAll(() => {
  // getAllEntities reads names off EntityAttributes — register it so entities
  // resolve to their real names (not "Entity <id>").
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: {
      name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' },
      parentId: { type: 'number' }, layer: { type: 'string' }, guid: { type: 'string' },
    },
  });
  registerTrait({ name: 'P2Full', trait: P2Full, category: 'component', fields: { a: { type: 'number' } } });
  registerTrait({ name: 'P2Res', trait: P2Res, category: 'resource', fields: { path: { type: 'string' } } });
  registerTrait({ name: 'P2Where', trait: P2Where, category: 'component', fields: { y: { type: 'number' } } });

  const w = getCurrentWorld();
  w.spawn(EntityAttributes({ name: 'P2FullEnt', guid: 'p2-full' }), P2Full({ a: 1, b: 2 }));
  resId = w.spawn(EntityAttributes({ name: 'P2ResEnt', guid: 'p2-res' }), P2Res({ path: 'x' })).id();
  w.spawn(EntityAttributes({ name: 'P2HighEnt', guid: 'p2-high' }), P2Where({ y: 10 }));
  w.spawn(EntityAttributes({ name: 'P2LowEnt', guid: 'p2-low' }), P2Where({ y: 1 }));
});

const names = (d: ReturnType<typeof dumpSceneState>) => d.entities.map((e) => e.name);

describe('dumpSceneState — S2 full-fidelity trait values', () => {
  it('omits uncurated fields by default, includes them with full:true', () => {
    // `traits` is a dynamic per-entity bag (production types it `Record<string, unknown>`, its
    // real declared shape, agentBridge.ts) — TS can't know `P2Full` is a key without that cast.
    const compact = dumpSceneState({ name: 'P2FullEnt' });
    expect((compact.entities[0].traits as Record<string, unknown>).P2Full).toEqual({ a: 1 }); // `b` dropped (curated)

    const full = dumpSceneState({ name: 'P2FullEnt', full: true });
    expect((full.entities[0].traits as Record<string, unknown>).P2Full).toEqual({ a: 1, b: 2 }); // `b` surfaced
  });
});

describe('dumpSceneState — S1 resource exclusion', () => {
  it('excludes resource entities by default', () => {
    expect(names(dumpSceneState())).not.toContain('P2ResEnt');
  });
  it('includes them with resources:true', () => {
    expect(names(dumpSceneState({ resources: true }))).toContain('P2ResEnt');
  });
  it('returns a resource when requested by explicit id (bypasses the filter)', () => {
    const d = dumpSceneState({ id: resId });
    expect(names(d)).toEqual(['P2ResEnt']);
  });

  // C7 re-audit — the guid= filter (the addressing CLAUDE.md mandates), targeting a resource too.
  it('returns exactly the entity addressed by guid, including a resource', () => {
    expect(names(dumpSceneState({ guid: 'p2-res' }))).toEqual(['P2ResEnt']);
  });
  it('returns empty + a warning for a guid that matches no entity (not a silent full dump)', () => {
    const d = dumpSceneState({ guid: 'no-such-guid' }) as ReturnType<typeof dumpSceneState> & { warnings?: string[] };
    expect(d.entities).toEqual([]);
    expect(d.warnings?.some((warn) => /matched no entity/i.test(warn))).toBe(true);
  });

  // REGRESSION (Phase 2 review) — resource-category also covers config singletons
  // (Time/Physics/NPRPostFX). A TARGETING query on a resource trait must reach it,
  // not silently drop it (the S1 silent-empty trap the phase set out to kill).
  it('reaches a resource entity when its trait is targeted via trait=', () => {
    const d = dumpSceneState({ trait: 'P2Res' });
    const res = d.entities.find((e) => e.name === 'P2ResEnt');
    expect((res?.traits as Record<string, unknown> | undefined)?.P2Res).toEqual({ path: 'x' });
  });
  it('reaches a resource entity when queried via where= (no silent empty)', () => {
    const d = dumpSceneState({ where: 'P2Res.path~x' });
    expect(d.warnings).toBeUndefined();
    expect(names(d)).toContain('P2ResEnt');
  });
});

describe('dumpSceneState — S1 where surfaces errors (no silent full dump)', () => {
  it('warns on an unparseable predicate', () => {
    const d = dumpSceneState({ where: 'garbage' });
    expect(d.warnings?.[0]).toMatch(/could not parse/);
  });
  it('warns on an unknown trait', () => {
    const d = dumpSceneState({ where: 'Nope.x=1' });
    expect(d.warnings?.[0]).toMatch(/unknown trait "Nope"/);
  });
  it('warns on an unknown field', () => {
    const d = dumpSceneState({ where: 'P2Where.zzz=1' });
    expect(d.warnings?.[0]).toMatch(/unknown field "P2Where.zzz"/);
  });
  it('applies a valid predicate (and reports no warnings)', () => {
    const d = dumpSceneState({ where: 'P2Where.y>5' });
    expect(d.warnings).toBeUndefined();
    expect(names(d)).toContain('P2HighEnt');
    expect(names(d)).not.toContain('P2LowEnt');
  });
  it('queries the FULL field set — an uncurated field is filterable (Decision A)', () => {
    // `b` is not in P2Full's curated meta.fields, but where reads readTraitDataFull.
    const d = dumpSceneState({ where: 'P2Full.b=2' });
    expect(d.warnings).toBeUndefined();
    expect(names(d)).toContain('P2FullEnt');
  });
});

// S3 — resolved world transform + activeInHierarchy, opt-in via world:true. The
// values come from transformPropagationSystem's module-global maps, seeded here.
describe('dumpSceneState — S3 world transform + activeInHierarchy', () => {
  const w = getCurrentWorld();
  const posed = w.spawn(EntityAttributes({ name: 'P3Posed', guid: 'p3-posed' })).id();
  const off = w.spawn(EntityAttributes({ name: 'P3Off', guid: 'p3-off' })).id();
  worldTransforms.set(posed, { x: 5, y: 6, z: 7, rx: 0, ry: 1, rz: 0, sx: 2, sy: 2, sz: 2 });
  deactivatedEntities.add(off);

  it('adds resolved world TRS + activeInHierarchy:true under world:true', () => {
    const e = dumpSceneState({ id: posed, world: true }).entities[0] as Record<string, unknown>;
    expect(e.world).toEqual({ position: [5, 6, 7], rotation: [0, 1, 0], scale: [2, 2, 2] });
    expect(e.activeInHierarchy).toBe(true);
  });

  it('reports activeInHierarchy:false for a hierarchy-deactivated entity', () => {
    const e = dumpSceneState({ id: off, world: true }).entities[0] as Record<string, unknown>;
    expect(e.activeInHierarchy).toBe(false);
  });

  it('omits world + activeInHierarchy by default (stable shape)', () => {
    const e = dumpSceneState({ id: posed }).entities[0] as Record<string, unknown>;
    expect(e.world).toBeUndefined();
    expect(e.activeInHierarchy).toBeUndefined();
  });
});

// S6 — screen-space geometry folded in, opt-in via bounds:true. Headless (no bounds
// providers / DOM) → screen null, but the keys must appear; real rects live-verified.
describe('dumpSceneState — S6 screen bounds (opt-in)', () => {
  it('adds screen + onScreen keys under bounds:true', () => {
    const e = dumpSceneState({ name: 'P2FullEnt', bounds: true }).entities[0] as Record<string, unknown>;
    expect('screen' in e).toBe(true);
    expect('onScreen' in e).toBe(true);
    expect(e.screen).toBeNull(); // no provider in the headless harness
    expect(e.onScreen).toBe(false);
  });
  it('omits screen/onScreen by default', () => {
    const e = dumpSceneState({ name: 'P2FullEnt' }).entities[0] as Record<string, unknown>;
    expect('screen' in e).toBe(false);
    expect('onScreen' in e).toBe(false);
  });
});

describe('dumpSceneState — S1 limit + truncated', () => {
  it('caps entities and flags truncated + totalCount', () => {
    const d = dumpSceneState({ limit: 1 });
    expect(d.entities).toHaveLength(1);
    expect(d.truncated).toBe(true);
    expect(d.totalCount).toBeGreaterThan(1);
  });
  // #1223 D3 (§2): `totalCount` is present whether or not the limit bit — a total that exists only
  // when truncation happened cannot be told from "nothing was left out".
  it('omits the truncated flag when under the limit, and still reports both counts', () => {
    const d = dumpSceneState({ limit: 100000 });
    expect(d.truncated).toBeUndefined();
    expect(d.totalCount).toBe(d.entities.length);
    expect(d.returnedCount).toBe(d.entities.length);
  });
});

/** Phase 3 of docs/mcp-response-budget.md. A bare `get_scene_state` used to serialize every field
 *  of every trait — ~40k tokens on a 135-entity scene. The untargeted default is now an INDEX:
 *  identity + trait NAMES + a hint. Any explicit target or enricher opts back into values. */
describe('dumpSceneState — index mode (untargeted default)', () => {
  const entOf = (d: ReturnType<typeof dumpSceneState>, name: string) =>
    d.entities.find((e) => e.name === name) as unknown as Record<string, unknown>;

  it('untargeted: trait NAMES, no values', () => {
    const e = entOf(dumpSceneState(), 'P2FullEnt');
    expect(e.traits).toEqual(expect.arrayContaining(['P2Full', 'EntityAttributes']));
    expect(Array.isArray(e.traits)).toBe(true); // the shape change: array, not object
  });

  it('untargeted: exposes the hot-reload-stable guid at top level', () => {
    // Runtime ids are reassigned on every scene reload; the guid is the only safe handle,
    // and it used to be buried in traits.EntityAttributes where an index couldn't show it.
    expect(entOf(dumpSceneState(), 'P2FullEnt').guid).toBe('p2-full');
  });

  it('untargeted: carries a hint naming the drill-down params', () => {
    const d = dumpSceneState() as { hint?: string };
    expect(d.hint).toContain('full=1');
    expect(d.hint).toContain('trait=');
    expect(d.hint).toContain('where=');
  });

  for (const [label, params] of [
    ['id', { id: 0 }],
    ['trait', { trait: 'P2Full' }],
    ['name', { name: 'P2FullEnt' }],
    ['where', { where: 'P2Full.a=1' }],
    ['full', { full: true }],
  ] as const) {
    it(`${label}= opts back into trait VALUES (object, not names)`, () => {
      const d = dumpSceneState(label === 'id' ? { id: entOf(dumpSceneState(), 'P2FullEnt').id as number } : params);
      const e = d.entities.find((x) => x.name === 'P2FullEnt') as unknown as Record<string, unknown>;
      expect(e).toBeDefined();
      expect(Array.isArray(e.traits)).toBe(false);
      expect((e.traits as Record<string, { a: number }>).P2Full.a).toBe(1);
    });
  }

  it('an enricher (bounds/world/contacts) also opts back into values', () => {
    const e = entOf(dumpSceneState({ world: true }), 'P2FullEnt');
    expect(Array.isArray(e.traits)).toBe(false);
    expect('activeInHierarchy' in e).toBe(true);
  });

  it('resources=1 alone stays an index (it selects rows, it does not ask for values)', () => {
    const d = dumpSceneState({ resources: true });
    expect(names(d)).toContain('P2ResEnt');
    expect(Array.isArray(entOf(d, 'P2ResEnt').traits)).toBe(true);
  });

  it('index mode applies a DEFAULT limit', () => {
    const d = dumpSceneState({ limit: 1 });
    expect(d.truncated).toBe(true);
    // and the default fires with no limit at all, once past DEFAULT_INDEX_LIMIT — asserted
    // via the constant rather than by spawning 200 entities.
    expect(DEFAULT_INDEX_LIMIT).toBeGreaterThan(0);
  });

  it('an EXPLICIT limit still overrides the default, targeted or not', () => {
    // This is why sceneStateSnapshot's pre-existing `limit:100000` case survived Phase 3:
    // the default only applies when the caller gave no limit.
    const d = dumpSceneState({ limit: 100000 });
    expect(d.truncated).toBeUndefined();
  });

  it('a TARGETED query under its cap is not truncated', () => {
    const d = dumpSceneState({ name: 'P2' });
    expect(d.truncated).toBeUndefined();
    expect(d.returnedCount).toBe(d.totalCount);
  });

  it('the DEFAULT index limit actually fires past DEFAULT_INDEX_LIMIT entities', () => {
    // Previously asserted only via the constant's positivity — which passes whether or not the
    // cap is wired. Spawn past it and check the real path.
    const w = getCurrentWorld();
    for (let i = 0; i < DEFAULT_INDEX_LIMIT + 5; i++) w.spawn(EntityAttributes({ name: `Bulk${i}`, guid: `bulk-${i}` }));

    const d = dumpSceneState() as { entities: unknown[]; truncated?: boolean; totalCount?: number; hint?: string };
    expect(d.entities).toHaveLength(DEFAULT_INDEX_LIMIT);
    expect(d.truncated).toBe(true);
    expect(d.totalCount).toBeGreaterThan(DEFAULT_INDEX_LIMIT);
    expect(d.hint).toContain('limit=');
  });

  it('a MALFORMED where does not flip the response into an uncapped full dump', () => {
    // A predicate that failed to parse selected nothing, so it must not count as "targeting".
    // Otherwise `where=Transform.y >> 3` (a typo) silently turns a capped names-only index into
    // the largest payload the tool can produce: every field of every trait of every entity.
    const d = dumpSceneState({ where: 'garbage' }) as {
      entities: Array<Record<string, unknown>>; warnings?: string[]; hint?: string;
    };
    expect(d.warnings?.[0]).toMatch(/could not parse/);        // still surfaced
    expect(Array.isArray(d.entities[0].traits)).toBe(true);     // index shape, not values
    expect(d.hint).toContain('Index only');
  });

  it('a VALID where still returns values (it is a real target)', () => {
    const d = dumpSceneState({ where: 'P2Where.y>5' }) as { entities: Array<Record<string, unknown>> };
    expect(Array.isArray(d.entities[0].traits)).toBe(false);
  });
});

/** #1557 — the read tail. Two months of transcripts put targeted reads at the top of the MCP result
 *  tax: `trait=CourtConfig` answered 274 rows (273 of them `traits:{}`) for one config entity, and a
 *  `name=` substring matching 17+ UI entities answered 36k chars because targeted reads were uncapped. */
describe('dumpSceneState — #1557 trait= selects, targeted reads carry a disclosed cap', () => {
  const T1557 = trait({ v: 0 });
  beforeAll(() => {
    registerTrait({ name: 'T1557', trait: T1557, category: 'component', fields: { v: { type: 'number' } } });
    const w = getCurrentWorld();
    w.spawn(EntityAttributes({ name: 'T1557Carrier', guid: 't1557-carrier' }), T1557({ v: 7 }));
    for (let i = 0; i < DEFAULT_TARGETED_LIMIT + 5; i++) w.spawn(EntityAttributes({ name: `Cap1557-${i}`, guid: `cap1557-${i}` }));
  });

  it('trait= returns only the entities that carry the trait', () => {
    const d = dumpSceneState({ trait: 'T1557' });
    expect(names(d)).toEqual(['T1557Carrier']);
    expect(d.totalCount).toBe(1);
    expect((d.entities[0].traits as Record<string, { v: number }>).T1557.v).toBe(7);
  });

  it('an unregistered trait= selects nothing, and the warning says the NAME is wrong', () => {
    const d = dumpSceneState({ trait: 't1557' }) as ReturnType<typeof dumpSceneState> & { warnings?: string[]; hint?: string };
    expect(d.entities).toEqual([]);
    expect(d.warnings?.[0]).toMatch(/not a REGISTERED trait.*Did you mean: T1557/);
    expect(d.hint).toBeUndefined(); // the warning already explains the empty answer
  });

  it(`a targeted read past ${DEFAULT_TARGETED_LIMIT} matches is capped, and says how many more there are`, () => {
    const d = dumpSceneState({ name: 'Cap1557-' }) as ReturnType<typeof dumpSceneState> & { hint?: string };
    expect(d.entities).toHaveLength(DEFAULT_TARGETED_LIMIT);
    expect(d.totalCount).toBe(DEFAULT_TARGETED_LIMIT + 5);
    expect(d.truncated).toBe(true);
    expect(d.hint).toContain('5 MORE are not shown');
    expect(d.hint).toContain(`limit=${DEFAULT_TARGETED_LIMIT + 5}`);
    // The disclosure comes BEFORE the rows, so a reader skimming the payload meets it first.
    expectInOrder(Object.keys(d), ['truncated', 'entities']);
    expectInOrder(Object.keys(d), ['hint', 'entities']);
  });

  it("an empty trait= filters nothing (an eval body passing a blank field through)", () => {
    const d = dumpSceneState({ trait: '', name: 'T1557Carrier' }) as ReturnType<typeof dumpSceneState> & { warnings?: string[] };
    expect(names(d)).toEqual(['T1557Carrier']);
    expect(d.warnings).toBeUndefined();
  });

  it('an explicit limit beats the targeted cap', () => {
    const d = dumpSceneState({ name: 'Cap1557-', limit: 1000 });
    expect(d.entities).toHaveLength(DEFAULT_TARGETED_LIMIT + 5);
    expect(d.truncated).toBeUndefined();
  });
});
