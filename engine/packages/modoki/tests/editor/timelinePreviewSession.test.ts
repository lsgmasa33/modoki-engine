/** Timeline preview SESSION controller (Phase 6, T1 backfill) — the snapshot/restore half of
 *  "▶ Preview plays the cutscene for real". A full serialize→loadScene round-trip isn't loadable
 *  headlessly yet, so we stub serialize/SceneManager/openAssetInEditor and pin the controller's
 *  branching against the REAL runtime singletons (preview flag, skeletal seeks, control spawns):
 *   - begin() snapshots ONCE (idempotent across pause/resume),
 *   - end({restore}) reverts to that FIRST snapshot,
 *   - the scene-path guard refuses to clobber a DIFFERENT scene loaded since the snapshot,
 *   - end always clears the active flag + skeletal seeks + control spawns,
 *   - end returns the re-resolved Director root (entity ids change on the restore reload). */

import { describe, it, expect, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scenePath: 'A.json' as string | null,
  snapshots: [] as unknown[],
  loadCalls: [] as { path: string; preloaded: unknown }[],
  resolvedRoot: 42 as number | null,
}));

vi.mock('../../src/editor/scene/serialize', () => ({
  serializeScene: async () => { const s = { snap: h.snapshots.length }; h.snapshots.push(s); return s; },
  getCurrentScenePath: () => h.scenePath,
}));
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: async (path: string, opts: { preloaded: unknown }) => { h.loadCalls.push({ path, preloaded: opts.preloaded }); },
  },
}));
vi.mock('../../src/editor/panels/openAssetInEditor', () => ({
  resolveDirectorRootForTimeline: (_p: string) => h.resolvedRoot,
}));

import {
  beginTimelinePreviewSession, endTimelinePreviewSession, hasTimelinePreviewSession,
} from '../../src/editor/scene/timelinePreview';
import { isTimelinePreviewActive, setTimelinePreviewActive } from '../../src/runtime/systems/timelinePreview';
import { requestSkeletalSeek, hasSkeletalSeeks, clearSkeletalSeeks } from '../../src/runtime/systems/skeletalSeek';
import { setControlSpawn, hasControlSpawn, clearControlSpawns } from '../../src/runtime/systems/controlSpawnRegistry';

afterEach(async () => {
  // End any dangling session so the module-level snapshot doesn't leak to the next test.
  if (hasTimelinePreviewSession()) await endTimelinePreviewSession({ restore: false });
  setTimelinePreviewActive(false);
  clearSkeletalSeeks();
  clearControlSpawns();
  h.scenePath = 'A.json'; h.snapshots = []; h.loadCalls = []; h.resolvedRoot = 42;
});

describe('timeline preview session controller', () => {
  it('snapshots ONCE — begin is idempotent across pause/resume, and restore reverts the first snapshot', async () => {
    await beginTimelinePreviewSession();
    await beginTimelinePreviewSession(); // resume after a pause must NOT re-snapshot the mutated world
    expect(h.snapshots).toHaveLength(1);
    expect(hasTimelinePreviewSession()).toBe(true);

    await endTimelinePreviewSession({ restore: true });
    expect(h.loadCalls).toHaveLength(1);
    expect(h.loadCalls[0].preloaded).toBe(h.snapshots[0]); // reverts to the authored snapshot
    expect(hasTimelinePreviewSession()).toBe(false);
  });

  it('restore NO-OPS when the scene changed since the snapshot (path guard) — does not clobber the new scene', async () => {
    h.scenePath = 'A.json';
    await beginTimelinePreviewSession();
    h.scenePath = 'B.json'; // user loaded a different scene mid-preview
    const root = await endTimelinePreviewSession({ restore: true, timelinePath: 'tl' });
    expect(h.loadCalls).toHaveLength(0);
    expect(root).toBeNull();
  });

  it('end ALWAYS clears the preview flag, skeletal seeks, and control spawns', async () => {
    setTimelinePreviewActive(true);
    requestSkeletalSeek(7, [{ clip: 'x', time: 0, weight: 1 }]);
    setControlSpawn('dir:trk:0', 9);
    await beginTimelinePreviewSession();

    await endTimelinePreviewSession({ restore: false });
    expect(isTimelinePreviewActive()).toBe(false);
    expect(hasSkeletalSeeks()).toBe(false);
    expect(hasControlSpawn('dir:trk:0')).toBe(false);
  });

  it('returns the RE-RESOLVED Director root after a restore (entity ids change on the reload)', async () => {
    h.scenePath = 'A.json';
    h.resolvedRoot = 123;
    await beginTimelinePreviewSession();
    const root = await endTimelinePreviewSession({ restore: true, timelinePath: 'cutscene.timeline.json' });
    expect(root).toBe(123);
  });
});
