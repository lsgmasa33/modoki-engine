// @vitest-environment jsdom
/** #1899 — a scene load READS its file, so it applies that file's held outside change (#1879's hold). The entry used to
 *  stay listed in `pendingOutsideChanges` until `modoki_refresh`, and the refresh then reloaded the scene a SECOND time
 *  (OBSERVED live on work-ai3's editor with the observer switched off: `[Editor] Loaded scene` from the load, then
 *  `hot-reloaded scene` from the refresh). `serialize.ts`'s load calls `outsideFileReadBegins` before its read and
 *  `outsideFileReadLanded` once its world is adopted (its side: openProjectScenePathSpelling.test.ts).
 *
 *  Mutations, each measured red here and restored: `outsideFileReadLanded` a no-op → "drops"; `outsideFileReadLanded` dropping every
 *  entry of the file rather than the covered holds → "held while the load was in flight"; the path compare dropped → "a prefab, and another scene's"; `begins`
 *  naming nothing → "names the holds"; the open questions left out of the covered set → "clears an open question". */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sceneManager } from '@modoki/engine/runtime';

const bridge = await import('../../app/debug/agentBridge');
const SCENE = '/assets/scenes/main.scene.json';

function rig() {
  bridge.enableOutsideChangeHold(true);
  const sceneFileChanged = vi.fn();
  bridge.setSceneAdoptionHooks({ capture: () => () => true, settled: () => true, sceneFileChanged });
  return { sceneFileChanged };
}

afterEach(() => {
  bridge.enableOutsideChangeHold(false);
  bridge._resetOutsideChangesForTests();
  bridge.setSceneAdoptionHooks(null);
  bridge.setSceneConflictResolver(null);
  vi.restoreAllMocks();
});

describe('a load applies the held change to the file it read (#1899)', () => {
  it('drops the held change once the load is adopted', () => {
    rig();
    bridge.holdOutsideChange({ urlPath: SCENE, kind: 'scene' });
    expect(bridge.pendingOutsideChanges()).toEqual([SCENE]);
    const covered = bridge.outsideFileReadBegins(SCENE);
    expect(bridge.pendingOutsideChanges()).toEqual([SCENE]); // not before the adopt: the load can still fail
    bridge.outsideFileReadLanded(SCENE, covered);
    expect(bridge.pendingOutsideChanges()).toEqual([]);
  });

  it('matches the file however it is spelled (case, /@fs/ form)', () => {
    rig();
    bridge.holdOutsideChange({ urlPath: '/assets/scenes/Main.scene.json', kind: 'scene' });
    bridge.outsideFileReadLanded(SCENE, bridge.outsideFileReadBegins(SCENE));
    expect(bridge.pendingOutsideChanges()).toEqual([]);
  });

  it('keeps a change held while the load was in flight — its bytes may postdate the read', () => {
    rig();
    const covered = bridge.outsideFileReadBegins(SCENE);
    bridge.holdOutsideChange({ urlPath: SCENE, kind: 'scene' });
    bridge.outsideFileReadLanded(SCENE, covered);
    expect(bridge.pendingOutsideChanges()).toEqual([SCENE]);
  });

  it('keeps a prefab change, and another scene\'s: the load read neither file', () => {
    rig();
    bridge.holdOutsideChange({ urlPath: '/assets/prefabs/p.prefab.json', kind: 'prefab' });
    bridge.holdOutsideChange({ urlPath: '/assets/scenes/other.scene.json', kind: 'scene' });
    bridge.outsideFileReadLanded(SCENE, bridge.outsideFileReadBegins(SCENE));
    expect(bridge.pendingOutsideChanges()).toEqual(['/assets/prefabs/p.prefab.json', '/assets/scenes/other.scene.json']);
  });

  it('names the holds its read covers, and raises NO debt of its own (close-out review F1, F2)', () => {
    const { sceneFileChanged } = rig();
    expect(bridge.outsideFileReadBegins(SCENE)).toEqual([]);
    bridge.holdOutsideChange({ urlPath: SCENE, kind: 'scene' });
    const covered = bridge.outsideFileReadBegins(SCENE);
    expect(covered).toHaveLength(1);
    bridge.outsideFileReadLanded(SCENE, covered);
    // The load's own adopt starts the history fresh (`freshIncoming`); a debt raised here could only be paid by the NEXT
    // adopt of the scene — the pairing test is sceneLoadAppliesHeldHistory.test.ts.
    expect(sceneFileChanged).not.toHaveBeenCalled();
  });

  it('clears an open "Reload / Keep mine" question for the file (close-out review F4)', async () => {
    rig();
    vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE } as never);
    vi.spyOn(sceneManager, 'getLoadedScenes').mockReturnValue(new Map([['main', { path: SCENE, role: 'primary', guid: 'main' }]]) as never);
    bridge.setSceneConflictResolver(async () => 'asking');
    bridge.holdOutsideChange({ urlPath: SCENE, kind: 'scene' });
    await bridge.releaseOutsideChanges();
    expect(bridge.awaitingSceneDecisions()).toEqual([SCENE]);
    bridge.outsideFileReadLanded(SCENE, bridge.outsideFileReadBegins(SCENE));
    expect(bridge.awaitingSceneDecisions()).toEqual([]);
    expect(bridge.pendingOutsideChanges()).toEqual([]);
  });
});
