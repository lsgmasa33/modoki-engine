// @vitest-environment jsdom
/** Every agent reply names an entity by guid — never by a bare runtime id (#1223 P2).
 *
 *  A runtime id is reassigned on every scene reload, and since #1223 D2 the mutating tools refuse it
 *  for an entity that has a guid, so a reply that hands one out hands out an address the next call
 *  refuses. The rule (docs/mcp-tool-conventions.md §3): an object carrying an entity keeps its id and
 *  gains the matching guid key beside it; an id list becomes a guid list plus `<field>NoGuidIds`; and a
 *  string never holds a stringified id (`id:<n>` is the one form for a guid-less entity).
 *
 *  This runs the REAL ops over one fixture and walks each reply generically, so a field added later
 *  is held to the rule without anyone remembering to list it. A stub cannot see reply fields, which
 *  is why #1217's "T2 guard" would not hold this. The fixture has the three kinds of entity a reply can
 *  meet: a durable guid, a runtime guid, and no guid at all (EntityAttributes removed, #1248). Their ids
 *  are pushed past 1000 so a count or an index in a reply cannot coincide with one.
 *
 *  Not reachable headless, and so not walked here: the `handles` meta (built in SceneView/UIResizeOverlay
 *  `.tsx`) and the pose ops' root guids (they need the Animation panel). Both add `guid` beside the id
 *  through the same `guidOfEntityId`. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestWorld, type TestWorld, EntityAttributes, Transform, setPlayState, destroyEntity,
  registerBoundsProvider, guidOfEntityId, recordUIOverflow, resetUIOverflowFindings, findEntityByGuid,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { deleteEntitiesLive } from '../../app/debug/liveLifecycle';

registerAllTraits();
registerEditorAgentOps();

const DURABLE = 'd1223000-0000-4000-8000-000000000001';

let game: TestWorld;
let durable: number, runtime: number, bare: number, child: number, bareChild: number, journalBare: number;
let unregister: () => void = () => {};
const fixture = new Map<number, string | null>();

// ── The walker ──

/** `parentId` → `parentGuid`, `boxEntityId` → `boxGuid`, `canvasId` → `canvasGuid`; `id`/`entityId`/`entity` → `guid`. */
function guidKeyFor(key: string): string | undefined {
  if (key === 'id' || key === 'entity' || key === 'entityId') return 'guid';
  const m = /^(.+?)(?:Entity)?Id$/.exec(key);
  return m ? `${m[1]}Guid` : undefined;
}

/** `entityIds` pairs with `guids`, `fooIds` with `fooGuids`. */
function guidListKeyFor(key: string): string | undefined {
  if (key === 'entityIds' || key === 'ids') return 'guids';
  const m = /^(.+?)(?:Entity)?Ids$/.exec(key);
  return m ? `${m[1]}Guids` : undefined;
}

function violations(reply: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, path: string, holder: Record<string, unknown> | unknown[] | undefined, key: string, idx = -1) => {
    // The one exemption: `traits.EntityAttributes.parentId` is the trait's own stored field, echoed as
    // the component holds it (set-traits reads the same shape back). The ROW carries `parentGuid` for it.
    if (/\.traits\.EntityAttributes\.parentId$/.test(path)) return;
    if (typeof v === 'number' && fixture.has(v)) {
      const guid = fixture.get(v)!;
      if (Array.isArray(holder)) {
        // An element of an id list: allowed only in `<field>NoGuidIds` for a guid-less entity, or in an
        // id list whose parallel guid list (`entityIds` ↔ `guids`) carries this element's guid.
        const listKey = key;
        const parent = (holder as unknown as { __parent?: Record<string, unknown> }).__parent;
        if (/(?:^n|N)oGuidIds$/.test(listKey)) { if (guid) out.push(`${path}: entity ${v} has guid ${guid} but is listed in ${listKey}`); return; }
        const pairKey = guidListKeyFor(listKey);
        const pair = pairKey && parent ? parent[pairKey] : undefined;
        if (!Array.isArray(pair) || pair[idx] !== guid) out.push(`${path}: bare id ${v} in list "${listKey}" (guid ${guid})`);
        return;
      }
      const gk = guidKeyFor(key);
      if (!gk || !holder || !(gk in holder)) { out.push(`${path}: bare id ${v} in "${key}" with no ${gk ?? 'guid'} beside it`); return; }
      if ((holder as Record<string, unknown>)[gk] !== guid) out.push(`${path}: ${gk} is ${JSON.stringify((holder as Record<string, unknown>)[gk])}, expected ${JSON.stringify(guid)}`);
      return;
    }
    if (typeof v === 'string') {
      for (const id of fixture.keys()) if (v === String(id)) out.push(`${path}: "${v}" is a stringified id`);
      return;
    }
    if (Array.isArray(v)) {
      (v as unknown as { __parent?: unknown }).__parent = holder;
      v.forEach((el, i) => visit(el, `${path}[${i}]`, v, key, i));
      delete (v as unknown as { __parent?: unknown }).__parent;
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, el] of Object.entries(v)) visit(el, `${path}.${k}`, v as Record<string, unknown>, k);
    }
  };
  visit(JSON.parse(JSON.stringify(reply ?? null)), '$', undefined, '');
  return out;
}

// ── The fixture ──

const uiRect = (id: number, rect: { x: number; y: number; w: number; h: number }) => {
  const el = document.createElement('div');
  el.setAttribute('data-entity-id', String(id));
  el.getBoundingClientRect = () => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h, right: rect.x + rect.w, bottom: rect.y + rect.h, x: rect.x, y: rect.y, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
};

beforeAll(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  // Ids past 1000: a reply's counts and indexes stay small, so one cannot pass for a fixture id.
  const fillers = Array.from({ length: 1000 }, () => game.spawn(Transform()));
  durable = game.spawn(Transform({ sx: 0 }), EntityAttributes({ guid: DURABLE, name: 'Durable', layer: 'ui' })).id();
  runtime = game.spawn(Transform({ x: Number.NaN }), EntityAttributes({ name: 'Runtime', layer: 'ui' })).id();
  child = game.spawn(Transform(), EntityAttributes({ name: 'Child', parentId: durable, layer: 'ui' })).id();
  const b = game.spawn(Transform({ sx: 0 }));
  b.remove(EntityAttributes); // the one way an entity has no guid since #1248
  bare = b.id();
  bareChild = game.spawn(Transform(), EntityAttributes({ name: 'BareChild', parentId: bare, layer: 'ui' })).id();
  const jb = game.spawn(Transform());
  jb.remove(EntityAttributes);
  journalBare = jb.id();
  for (const f of fillers) destroyEntity(f);
  for (const id of [durable, runtime, child, bare, bareChild, journalBare]) fixture.set(id, guidOfEntityId(id));

  // UI rects: the durable and runtime entities overlap and are zero-size/off-screen in turn; the bare
  // entity (no EntityAttributes, so no layer) reaches layout through a 2D bounds provider with a canvas.
  uiRect(durable, { x: 0, y: 0, w: 0, h: 50 });
  uiRect(runtime, { x: 0, y: 0, w: 100, h: 100 });
  uiRect(child, { x: 50, y: 50, w: 100, h: 100 });
  uiRect(bareChild, { x: 60, y: 60, w: 100, h: 100 });
  unregister = registerBoundsProvider(() => [
    { id: bare, layer: '2d', screen: { x: 0, y: 0, w: 0, h: 0 }, onScreen: false, canvasId: runtime },
    // A provider row for an entity WITH a guid, or a provider row reporting `guid: null` goes unseen.
    { id: runtime, layer: '2d', screen: { x: 400, y: 400, w: 10, h: 10 }, onScreen: true },
  ], 'game-2d');
  // A UI text overflow whose text sits in the runtime entity and whose box is the durable one.
  recordUIOverflow('reply-naming', {
    kind: 'spill', boxEntityId: durable, overflowPx: 6, availablePx: 100, textPx: 106, clipped: false,
    entityId: runtime, guid: fixture.get(runtime)!, text: 'Wide', viewport: { w: 375, h: 667 },
  });
});

afterAll(() => {
  unregister();
  resetUIOverflowFindings();
  document.querySelectorAll('[data-entity-id]').forEach((el) => el.remove());
  game.dispose();
});

describe('the fixture is what the guard needs', () => {
  it('has a durable guid, a runtime guid and a guid-less entity, all with ids past 1000', () => {
    expect(fixture.get(durable)).toBe(DURABLE);
    expect(fixture.get(runtime)).toMatch(/^00000000-/);
    expect(fixture.get(bare)).toBeNull();
    expect(Math.min(...fixture.keys())).toBeGreaterThanOrEqual(1000);
  });

  // Accept side of the walker: without these, a walker that flags nothing passes every case below.
  it('the walker flags a bare id, a bare id list, a wrong guid and a stringified id', () => {
    expect(violations({ id: runtime })).toHaveLength(1);
    expect(violations({ deleted: [runtime] })).toHaveLength(1);
    expect(violations({ parentId: durable, parentGuid: null })).toHaveLength(1);
    expect(violations({ entity: String(durable) })).toHaveLength(1);
    expect(violations({ deletedNoGuidIds: [durable] })).toHaveLength(1);
    expect(violations({ id: bare, guid: null, deletedNoGuidIds: [bare], entity: `id:${bare}`, entityIds: [durable], guids: [DURABLE] })).toEqual([]);
  });
});

describe('replies name every entity by guid (#1223 P2)', () => {
  // Mutation: drop `parentGuid` from dumpSceneState's rows.
  it('scene-state, index and full rows', async () => {
    expect(violations(await runAgentOp('scene-state', {}))).toEqual([]);
    expect(violations(await runAgentOp('scene-state', { name: 'Child', trait: 'Transform', world: true, bounds: true }))).toEqual([]);
    // Close-out review: the trait echo is a different shape from the row, and was never walked.
    expect(violations(await runAgentOp('scene-state', { full: true }))).toEqual([]);
    expect(violations(await runAgentOp('scene-state', { trait: 'EntityAttributes' }))).toEqual([]);
  });

  // Mutation: in computeLayoutBounds, list `offScreen` by id again (`.map((e) => e.id)`).
  it('layout-bounds rows, overlap pairs, offScreen and zeroSize', async () => {
    const r = await runAgentOp('layout-bounds', { entities: true, overlaps: true }) as { overlapsCount: number; offScreenNoGuidIds?: number[] };
    expect(r.overlapsCount).toBeGreaterThan(0);
    expect(r.offScreenNoGuidIds).toEqual([bare]);
    expect(violations(r)).toEqual([]);
  });

  // Mutations: drop `guid` from diagnose's TransformIssue rows; drop `boxGuid` from its overflow findings.
  it('diagnose issues, zeroScale, offScreen and UI overflow findings', async () => {
    const r = await runAgentOp('diagnose', {}) as { transforms: { nan: unknown[]; zeroScale: string[]; zeroScaleNoGuidIds?: number[] }; uiOverflow: { findings: unknown[] } };
    expect(r.uiOverflow.findings).toHaveLength(1);
    expect(r.transforms.nan.length).toBeGreaterThan(0);
    expect(r.transforms.zeroScale).toContain(DURABLE);
    expect(r.transforms.zeroScaleNoGuidIds).toEqual([bare]);
    expect(violations(r)).toEqual([]);
  });

  // Close-out review: `boxGuid` was added in diagnose only, so the same finding reached the game journal
  // with a bare `boxEntityId`. Mutation: compute boxGuid in diagnose again instead of in recordUIOverflow.
  it('the @ui.overflow journal event names its box by guid', async () => {
    const r = await runAgentOp('journal-events', { type: '@ui.overflow' }) as { events: Array<{ payload?: { boxGuid?: unknown } }> };
    expect(r.events.at(-1)?.payload?.boxGuid).toBe(DURABLE);
    // The events only: the reply's counts include the fixture's 1000 filler @spawns, which a count walk would flag.
    expect(violations(r.events)).toEqual([]);
  });

  it('editor-state selection', async () => {
    await runAgentOp('set-selection', { guids: [DURABLE], ids: [bare] });
    expect(violations(await runAgentOp('editor-state', {}))).toEqual([]);
  });

  // Mutation: return `String(id)` from journalRefOf.
  it('the editor journal names a guid-less entity id:<n>, never String(id)', async () => {
    await runAgentOp('delete-entities', { ids: [journalBare] });
    const j = await runAgentOp('editor-journal', { type: '!delete' }) as { editor: Array<{ payload?: { entities?: string[] } }> };
    expect(j.editor.at(-1)?.payload?.entities).toEqual([`id:${journalBare}`]);
    expect(violations(j)).toEqual([]);
  });

  // Mutation: in the editor delete-entities op, return the resolved id list as `deleted`.
  it('editor delete-entities', async () => {
    const r = await runAgentOp('delete-entities', { guids: [fixture.get(child)!] }) as { deleted: string[] };
    expect(r.deleted).toHaveLength(1);
    expect(violations(r)).toEqual([]);
  });

  // Close-out review: the op wrote a DURABLE guid over the runtime one before snapshotting, after the reply
  // had already named the runtime one — so the journal named a guid the reply never did, and after undo
  // the reply's guid resolved to nothing. Mutation: drop the `ensureGuid` loop before `guidListFields`.
  it('editor delete-entities names the guid its journal event and its undo use', async () => {
    const e = game.spawn(Transform(), EntityAttributes({ name: 'RtDel' }));
    expect(guidOfEntityId(e.id())).toMatch(/^00000000-/);
    const r = await runAgentOp('delete-entities', { guid: guidOfEntityId(e.id())! }) as { deleted: string[] };
    const j = await runAgentOp('editor-journal', { type: '!delete' }) as { editor: Array<{ payload?: { entities?: string[] } }> };
    expect(j.editor.at(-1)?.payload?.entities).toEqual(r.deleted);
    await runAgentOp('undo', {});
    expect(findEntityByGuid(r.deleted[0])).toBeDefined();
  });

  // Re-review: a LISTED DESCENDANT is not a root, so `deleteEntitiesWithUndo` never mints it — the op's own
  // loop must, or its runtime guid is re-minted when undo respawns the subtree and the reply's guid names
  // nothing. Mutation: mint only the first listed id (`deleted.slice(0, 1)`).
  it('editor delete-entities: every listed guid resolves after undo, a listed descendant included', async () => {
    const p = game.spawn(Transform(), EntityAttributes({ name: 'DelP' }));
    const c = game.spawn(Transform(), EntityAttributes({ name: 'DelC', parentId: p.id() }));
    const g = game.spawn(Transform(), EntityAttributes({ name: 'DelG', parentId: c.id() }));
    const guids = [g, p, c].map((e) => guidOfEntityId(e.id())!);
    const r = await runAgentOp('delete-entities', { guids }) as { deleted: string[] };
    expect(r.deleted).toHaveLength(3);
    await runAgentOp('undo', {});
    for (const guid of r.deleted) expect(findEntityByGuid(guid), guid).toBeDefined();
  });

  // Mutation: in deleteEntitiesLive, return `deleted: targets` (the id list).
  it('device delete-entities', () => {
    const r = deleteEntitiesLive({ ids: [bare] }) as { deleted: string[]; deletedNoGuidIds?: number[] };
    expect(r).toMatchObject({ deleted: [], deletedNoGuidIds: [bare] });
    expect(violations(r)).toEqual([]);
  });
});
