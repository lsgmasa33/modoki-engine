/** P9 integration top-up of the module-boundaries layering work (see `docs/architecture-layers.md`)
 *  — prefab instantiate + timeline
 *  + zone triggers, exercising cross-subsystem wiring the old cycles used to carry implicitly
 *  (this is exactly the seam P7's `timeline/assetProvider.ts` now injects instead).
 *
 *  A Director's control track spawns a prefab (mocked cache lookup + REAL `spawnPrefabInstance`,
 *  same style as `timelineControlSpawn.test.ts`) whose root entity is a `ZoneOccupant` landing
 *  inside a `Zone2D`. One `zone2DSystem` step must see the freshly-spawned entity's world pose
 *  and fire an `@zone` enter — proving prefab spawn → transform propagation → zone containment
 *  → the declarative `OnZone2D` action all hand off correctly in one frame budget. */

import { describe, it, expect, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prefabDef: null as unknown,
}));

// timelineSystem reaches getTimeline/getCachedPrefab/spawnPrefabInstance via the
// timeline/assetProvider slot (P7 C14). getTimeline routes to the REAL loaders/timelineCache
// (this test seeds it via setTimeline); getCachedPrefab is stubbed (no real asset fetch
// headless); spawnPrefabInstance stays REAL so the actual entity-instantiation path is exercised.
vi.mock('../../src/runtime/timeline/assetProvider', async () => {
  const { getTimeline } = await import('../../src/runtime/loaders/timelineCache');
  const { spawnPrefabInstance } = await import('../../src/runtime/loaders/loadSceneFile');
  const impl = { getTimeline, getCachedPrefab: () => h.prefabDef, spawnPrefabInstance };
  return { timelineAssetProvider: { get: () => impl } };
});

import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { registerTrait, getAllTraits } from '../../src/runtime/core/ecs/traitRegistry';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { Zone2D } from '../../src/runtime/traits/Zone2D';
import { ZoneOccupant } from '../../src/runtime/traits/ZoneOccupant';
import { OnZone2D } from '../../src/runtime/traits/OnZone2D';
import { timelineSystem } from '../../src/runtime/timeline/timelineSystem';
import { zone2DSystem } from '../../src/runtime/zones/zone2DSystem';
import { transformPropagationSystem } from '../../src/runtime/core/ecs/transformPropagationSystem';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline } from '../../src/runtime/timeline/types';
import { zone2DEvents } from '../../src/runtime/zones/Zone2DEvents';
import { emit } from '../../src/runtime/core/journal';

function ensureTraitsRegistered() {
  const names = new Set(getAllTraits().map((m) => m.name));
  if (!names.has('Transform'))
    registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' } } });
  if (!names.has('EntityAttributes'))
    registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' } } });
  // Needed so the prefab-JSON spawn path (instantiatePrefabIntoWorld) can resolve this trait
  // by name — traits only assigned directly via tw.spawn() (Zone2D, OnZone2D below) don't need it.
  if (!names.has('ZoneOccupant'))
    registerTrait({ name: 'ZoneOccupant', trait: ZoneOccupant, category: 'tag', fields: {} });
}

const DT = 1 / 30;
const TIMELINE_PATH = 'zone-spawn.timeline.json';

let tw: TestWorld | undefined;

afterEach(() => {
  if (tw) {
    zone2DEvents.__clear(tw.world);
    tw.dispose();
    tw = undefined;
  }
  clearTimelineCache();
});

describe('prefab + timeline + zone triggers (P9 integration top-up)', () => {
  it('a control-track prefab spawn lands inside a Zone2D and fires the zone-enter action', () => {
    ensureTraitsRegistered();
    h.prefabDef = {
      id: 'spark-prefab',
      rootLocalId: 1,
      entities: [
        {
          localId: 1,
          traits: {
            EntityAttributes: { name: 'Spark' },
            Transform: { x: 0, y: 0 }, // spawned at the parent's local origin, inside the zone below
            ZoneOccupant: {},
          },
        },
      ],
    };

    tw = createTestWorld({
      dt: DT,
      systems: [
        { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 },
        { name: 'transformPropagation', fn: transformPropagationSystem, priority: SYSTEM_PRIORITY.TRANSFORM },
        { name: 'zone2D', fn: zone2DSystem, priority: SYSTEM_PRIORITY.TRANSFORM + 2 },
      ],
      actions: {
        'zone.entered': (ctx) => {
          emit('@test.zoneEntered', {}, (ctx.world ?? undefined) as never);
        },
      },
    });

    setTimeline(TIMELINE_PATH, normalizeTimeline({
      id: 'zs', name: 'ZoneSpawn', duration: 2, frameRate: 30,
      // start > 0 so the FIRST step observes "before the clip" and the second crosses INTO it —
      // a control clip starting exactly at t=0 never sees a "before" state to cross from (same
      // t=0-edge class timelineSystem.test.ts's dedicated marker tests cover).
      tracks: [{ id: 'ctl', name: 'Spawn', target: '', type: 'control', clips: [{ start: 0.05, duration: 2, prefab: 'spark-prefab' }] }],
    }));

    // Director root sits at the zone's centre, so the prefab (spawned at local x:0,y:0) lands inside.
    tw.spawn(
      EntityAttributes({ name: 'director' }),
      Transform({ x: 0, y: 0 }),
      Director({ timeline: TIMELINE_PATH }),
    );
    tw.spawn(
      EntityAttributes({ name: 'zone' }),
      Transform({ x: 0, y: 0, sx: 100, sy: 100 }),
      Zone2D({ shape: 'box' }),
      OnZone2D({ onEnter: 'zone.entered' }),
    );

    tw.step(1); // t ≈ 0.033 — before the clip's 0.05 start, no spawn yet
    tw.step(1); // t ≈ 0.067 — crosses the clip's start → spawns the prefab; same-frame zone containment

    const enterEvents = tw.events().filter((e) => e.type === '@zone');
    expect(enterEvents.length).toBeGreaterThan(0);
    expect(enterEvents[0].payload).toMatchObject({ phase: 'enter' });

    const actionEvents = tw.events().filter((e) => e.type === '@test.zoneEntered');
    expect(actionEvents).toHaveLength(1);
  });
});
