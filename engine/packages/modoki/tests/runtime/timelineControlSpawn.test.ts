/** Control track — the actual SPAWN path (T3 backfill). The plain `timelineControl.test.ts` runs
 *  with no cached prefab, so `controlSpawn` journals but is a no-op. Here we seed `getCachedPrefab`
 *  and spy `spawnPrefabInstance`/`deleteEntity` to prove the Phase-C glue really fires:
 *   - crossing a clip start invokes `spawnPrefabInstance` exactly once, under the resolved parent,
 *   - with a DETERMINISTIC `guidSeed` built from the Director's stable guid (not a runtime id),
 *   - the spawned id is tracked and DESTROYED at the clip end,
 *   - and a wrong-parent / random-seed regression would now fail.
 *
 *  Module mocks are file-scoped (hoisted), so this lives in its own file — the no-op assertions in
 *  timelineControl.test.ts depend on `getCachedPrefab` returning undefined. */

import { describe, it, expect, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prefabDef: null as unknown,
  spawnCalls: [] as { parentId?: number; guidSeed?: string; rootTransform?: Record<string, number> }[],
  spawnReturns: [] as number[],
  deleted: [] as number[],
  nextId: 500,
}));

vi.mock('../../src/runtime/loaders/meshTemplateCache', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCachedPrefab: () => h.prefabDef,
}));
vi.mock('../../src/runtime/loaders/loadSceneFile', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  spawnPrefabInstance: (_w: unknown, _p: unknown, opts: { parentId?: number; guidSeed?: string; rootTransform?: Record<string, number> }) => {
    h.spawnCalls.push({ parentId: opts.parentId, guidSeed: opts.guidSeed, rootTransform: opts.rootTransform });
    const id = h.nextId++;
    h.spawnReturns.push(id);
    return id;
  },
}));
vi.mock('../../src/runtime/ecs/entityUtils', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  deleteEntity: (id: number) => { h.deleted.push(id); },
}));

import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { timelineSystem, previewControlAt, clearPreviewControls } from '../../src/runtime/systems/timelineSystem';
import { clearControlSpawns } from '../../src/runtime/systems/controlSpawnRegistry';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline } from '../../src/runtime/timeline/types';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'control-spawn.timeline.json';
const DT = 1 / 30;

let tw: TestWorld | undefined;
afterEach(() => {
  clearControlSpawns();
  if (tw) { tw.dispose(); tw = undefined; }
  clearTimelineCache();
  h.prefabDef = null; h.spawnCalls = []; h.spawnReturns = []; h.deleted = []; h.nextId = 500;
});

function makeTimeline() {
  return normalizeTimeline({
    id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
    tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 1, prefab: 'prefab-guid-x' }] }],
  });
}

describe('control track — spawn path (cached prefab)', () => {
  it('spawns once under the Director root with a deterministic guidSeed, then destroys it at the clip end', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, makeTimeline());
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), Director({ timeline: PATH }));

    tw.step(27); // t ≈ 0.9 — before start
    expect(h.spawnCalls).toHaveLength(0);

    tw.step(6);  // t ≈ 1.1 — crossed start
    expect(h.spawnCalls).toHaveLength(1);
    // target '' → parent is the Director root; seed is derived from the Director's STABLE guid.
    expect(h.spawnCalls[0].parentId).toBe(root.id());
    expect(h.spawnCalls[0].guidSeed).toBe('control:dir-guid:ctl:0');

    tw.step(30); // t ≈ 2.1 — crossed end (start+duration=2)
    expect(h.deleted).toEqual([h.spawnReturns[0]]); // the tracked instance is the one destroyed
    expect(h.spawnCalls).toHaveLength(1);            // no second spawn
  });

  it('passes a clip transform through as the spawned root override', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, prefab: 'prefab-guid-x', transform: { x: 2, y: 3, sx: 0.5 } }] }],
    }));
    tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), Director({ timeline: PATH }));

    tw.step(40); // past start
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0].rootTransform).toEqual({ x: 2, y: 3, sx: 0.5 }); // only the authored fields
  });

  it('guidSeed is byte-identical across two runs — deterministic spawn identity', () => {
    const seedOf = () => {
      h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
      h.spawnCalls = []; h.spawnReturns = []; h.deleted = []; h.nextId = 500;
      const w = createTestWorld({ dt: DT, systems: [TIMELINE] });
      setTimeline(PATH, makeTimeline());
      w.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), Director({ timeline: PATH }));
      w.step(40); // past start
      const seed = h.spawnCalls[0]?.guidSeed;
      w.dispose(); clearTimelineCache(); clearControlSpawns();
      return seed;
    };
    const a = seedOf();
    const b = seedOf();
    expect(a).toBe('control:dir-guid:ctl:0');
    expect(a).toBe(b);
  });

  // ── Editor SCRUB: control-prefab presence by span containment (previewControlAt) ──

  it('previewControlAt spawns a prefab inside its clip span and despawns it outside — idempotent', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [] });
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }));
    const def = normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 1, prefab: 'prefab-guid-x' }] }],
    });

    previewControlAt(tw.world, root.id(), def, 0.5); // before the span → nothing
    expect(h.spawnCalls).toHaveLength(0);

    previewControlAt(tw.world, root.id(), def, 1.5); // inside [1,2) → spawn once
    expect(h.spawnCalls).toHaveLength(1);
    previewControlAt(tw.world, root.id(), def, 1.8); // still inside → NOT re-spawned (idempotent)
    expect(h.spawnCalls).toHaveLength(1);

    previewControlAt(tw.world, root.id(), def, 3); // outside → despawn the tracked instance
    expect(h.deleted).toEqual([h.spawnReturns[0]]);

    previewControlAt(tw.world, root.id(), def, 1.2); // scrub back inside → spawn again
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('previewControlAt skips particle/subdirector clips (impulses/nested, not scrubbable)', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: {} }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [] });
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }));
    const def = normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 2, particle: true }] }],
    });
    previewControlAt(tw.world, root.id(), def, 1.5);
    expect(h.spawnCalls).toHaveLength(0); // particle clip → no scrub spawn
  });

  it('reconciles a NESTED sub-director control prefab OFF when the scrub leaves the parent span (review C4)', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [] });
    const parent = tw.spawn(EntityAttributes({ name: 'Parent', guid: 'parent-guid' }), Director({ timeline: 'parent.tl' }));
    tw.spawn(EntityAttributes({ name: 'Child', guid: 'child-guid', parentId: parent.id() }), Director({ timeline: 'child.tl' }));
    // Parent drives Child across [1,3); Child spawns a prefab across its whole (2s) local span.
    const parentDef = normalizeTimeline({
      id: 'p', name: 'P', duration: 6, frameRate: 30,
      tracks: [{ id: 'sub', name: 'Sub', target: 'Child', type: 'control', clips: [{ start: 1, duration: 2, subdirector: true }] }],
    });
    setTimeline('child.tl', normalizeTimeline({
      id: 'c', name: 'C', duration: 2, frameRate: 30,
      tracks: [{ id: 'fx', name: 'FX', target: '', type: 'control', clips: [{ start: 0, duration: 2, prefab: 'prefab-guid-x' }] }],
    }));

    previewControlAt(tw.world, parent.id(), parentDef, 1.5); // inside the sub span → child active → its prefab spawns
    expect(h.spawnCalls).toHaveLength(1);

    previewControlAt(tw.world, parent.id(), parentDef, 5); // parent leaves the sub span → child inactive
    expect(h.deleted).toEqual([h.spawnReturns[0]]); // the nested prefab is despawned, not left lingering
  });

  it('clearPreviewControls destroys every scrub-spawned prefab', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: {} }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [] });
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }));
    const def = normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 1, prefab: 'prefab-guid-x' }] }],
    });
    previewControlAt(tw.world, root.id(), def, 1.5);
    expect(h.spawnCalls).toHaveLength(1);
    clearPreviewControls();
    expect(h.deleted).toContain(h.spawnReturns[0]);
  });
});
