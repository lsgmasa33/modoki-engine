/** #1548 — every writer of the live world refuses while the world may be posed, and asks ONE question
 *  (`editor/scene/authoredWorld.ts`) to find out.
 *
 *  The run mode alone was the wrong question at exactly the dangerous moment: an envelope's exit reads
 *  'stopped' before its restore has swapped the posed world out. The first case is the review's repro
 *  verbatim — the agent `save-all` replied ok:true with the posed `x:7` in the written file. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { setRunMode, createTestWorld } from '@modoki/engine/runtime';
import { EntityAttributes } from '../../packages/modoki/src/runtime/core/traits/EntityAttributes';
import { Transform } from '../../packages/modoki/src/runtime/core/traits/Transform';
import * as tp from '../../packages/modoki/src/editor/scene/timelinePreview';
import { enterScrubMode, exitPreviewMode } from '../../packages/modoki/src/editor/scene/playMode';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefab';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { restoreAuthoredSnapshot } from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import { isWorldAuthored, whyWorldNotAuthored, registerPosedWorldSource } from '../../packages/modoki/src/editor/scene/authoredWorld';

registerAllTraits();
registerEditorAgentOps();

afterEach(async () => {
  vi.restoreAllMocks();
  if (tp.hasTimelinePreviewSession()) await tp.endTimelinePreviewSession({ restore: false });
  setRunMode('stopped');
});

/** Capture every `/api/*` write body instead of sending it. */
function captureWrites(): { bodies: string[]; restore: () => void } {
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    bodies.push(`${String(url)} :: ${String(init?.body ?? '')}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = realFetch; } };
}

describe('the agent save-all during an un-awaited ⏹ Exit restore (#1548)', () => {
  it('is refused while the posed world is still live, and saves once the restore has landed', async () => {
    const g = createTestWorld({});
    const w = captureWrites();
    let land: (() => void) | null = null;
    let released = false;                        // once set, a reload that has not started yet resolves at once
    let done: Promise<unknown> | null = null;
    try {
      const m = new Map<string, string>();
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); },
        removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0,
      };
      setCurrentScenePath('/assets/scenes/t.scene.json');
      const e = g.spawn(EntityAttributes({ name: 'Cam', guid: 'g-cam-1548' } as never), Transform({ x: 0 } as never));
      setRunMode('stopped');
      enterScrubMode('timeline');
      expect(await tp.beginTimelinePreviewSession()).toBe(true);
      e.set(Transform, { ...(e.get(Transform) as object), x: 7 } as never);        // the pose
      vi.spyOn(sceneManager, 'loadScene').mockImplementation(() => new Promise((r) => {
        land = () => r({} as never);
        if (released) land();
      }) as never);
      // TimelineEditor.exitPreview: fire the restore, flip the mode on the very next line.
      done = tp.endTimelinePreviewSession({ restore: true });
      exitPreviewMode('timeline');
      // The gap BEFORE the reload starts (the end is still awaiting `whenUndoIdle`): only the session's own
      // restore-in-flight source can see it. MUTATION TARGET: register that source as `() => false`.
      expect(whyWorldNotAuthored()).toMatch(/a preview restore is still landing/);
      // MUTATION TARGET: ask `getRunMode() !== 'stopped'` in saveScene again and this writes the pose.
      const reply = await runAgentOp('save-all', {}).catch((err: unknown) => ({ threw: String(err) }));
      expect(w.bodies.filter((b) => b.includes('g-cam-1548')), JSON.stringify(reply)).toEqual([]);
      expect((reply as { ok?: boolean }).ok).not.toBe(true);
      land!(); await done;
      // ACCEPT SIDE: the restore landed — the same save now writes.
      expect(isWorldAuthored()).toBe(true);
      await runAgentOp('save-all', {});
      expect(w.bodies.some((b) => b.includes('g-cam-1548'))).toBe(true);
    } finally {
      // Land a restore a failed assertion left hanging, or every later case reads "restore in progress".
      released = true;
      (land as (() => void) | null)?.(); await done;
      w.restore(); g.dispose();
    }
  });
});

describe('Apply to Prefab and Create Prefab refuse an unauthored world (#1548)', () => {
  it('Apply is refused with a reason inside a preview session, before touching anything', async () => {
    setRunMode('stopped');
    enterScrubMode('animation');
    // MUTATION TARGET: drop the gate from applyToPrefabSelective — the refusal becomes an ordinary
    // "not a prefab instance" no-op here, and with a real instance the pose was written to the template.
    const r = await applyToPrefabSelective(12345, new Set(['Transform.x']));
    expect(r.applied).toBe(false);
    expect(r.refused).toMatch(/not authored.*scrub/);
    exitPreviewMode('animation');
    // ACCEPT SIDE: authored again — no refusal (this id is simply not an instance).
    const ok = await applyToPrefabSelective(12345, new Set(['Transform.x']));
    expect(ok.refused).toBeUndefined();
  });

  it('Create Prefab is refused during Play, and writes nothing', async () => {
    const w = captureWrites();
    try {
      setRunMode('playing');
      // MUTATION TARGET: drop the gate from createPrefabFromEntity and this serializes the live (played) subtree.
      const r = await createPrefabFromEntity(1, '/assets/prefabs/x.prefab.json', 'Create', async () => true);
      expect(r && typeof r === 'object' && 'refused' in r ? r.refused : r).toMatch(/Create Prefab refused — run-mode is 'playing'/);
      expect(w.bodies).toEqual([]);
    } finally { w.restore(); }
  });
});

describe('whyWorldNotAuthored — the sources, and the Stop reload window (#1548)', () => {
  it('an authored restore in flight (Stop reads stopped while the Play world is still live) is not authored', async () => {
    setRunMode('stopped');
    let land!: () => void;
    vi.spyOn(sceneManager, 'loadScene').mockImplementation(() => new Promise((r) => { land = () => r({} as never); }) as never);
    const restoring = restoreAuthoredSnapshot({ primary: { entities: [] } as never, key: '/s.json', bases: new Map() });
    // MUTATION TARGET: drop the `_restoring` counter from restoreAuthoredSnapshot and this reads null.
    expect(whyWorldNotAuthored()).toMatch(/Play\/preview restore is still landing/);
    land(); await restoring;
    expect(whyWorldNotAuthored()).toBeNull();
  });

  it('a source that THROWS counts as posed — the write is refused, not waved through', () => {
    setRunMode('stopped');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPosedWorldSource('#1548 test source', () => { throw new Error('boom'); });
    try {
      // MUTATION TARGET: initialise `posed` to false and this is null — a broken source skips the check.
      expect(whyWorldNotAuthored()).toMatch(/#1548 test source/);
      expect(err).toHaveBeenCalled();
    } finally { registerPosedWorldSource('#1548 test source', () => false); }
    expect(isWorldAuthored()).toBe(true);
  });
});

describe('the live-world agent ops refuse an envelope instead of replying ok (#1552)', () => {
  it('create / duplicate / delete / reparent / prefab instantiate each refuse, change nothing, and name the exit', async () => {
    const g = createTestWorld({});
    try {
      const a = g.spawn(EntityAttributes({ name: 'A', guid: 'g-a-1552' } as never), Transform({} as never));
      const b = g.spawn(EntityAttributes({ name: 'B', guid: 'g-b-1552' } as never), Transform({} as never));
      const count = () => g.world.query(EntityAttributes).length;
      const before = count();
      setRunMode('stopped');
      enterScrubMode('animation');
      // MUTATION TARGET: drop `refuseEditOfPosedWorld` from any one op and its call resolves (or fails
      // for an unrelated reason that does not name the envelope).
      const calls: Array<[string, unknown]> = [
        ['create-entity', { spec: { kind: 'empty' } }],
        ['duplicate-entity', { guid: 'g-a-1552' }],
        ['delete-entities', { guids: ['g-a-1552'] }],
        ['reparent-entity', { guid: 'g-b-1552', parentGuid: 'g-a-1552' }],
        ['prefab', { action: 'instantiate', path: '/assets/prefabs/none.prefab.json' }],
        ['prefab', { action: 'detach', entityGuid: 'g-a-1552' }],
        ['prefab', { action: 'revert', entityGuid: 'g-a-1552' }],
      ];
      for (const [op, params] of calls) {
        const err = await runAgentOp(op, params).then(() => null, (e: unknown) => e as { message?: string; options?: string[] });
        expect(err?.message, op).toMatch(/refused: run-mode is 'scrub'.*owned by the animation panel.*Nothing was changed/);
        expect(err?.options?.[0], op).toMatch(/^modoki_exit_pose_envelope/);
      }
      expect(count()).toBe(before);
      expect(b.get(EntityAttributes)!.parentId).not.toBe(a.id());

      // ACCEPT SIDE: out of the envelope the same create goes through.
      exitPreviewMode('animation');
      await runAgentOp('create-entity', { spec: { kind: 'empty' } });
      expect(count()).toBe(before + 1);
      // …and Play is exempt on purpose: editing the play world is how an agent drives a running game.
      setRunMode('playing');
      await runAgentOp('create-entity', { spec: { kind: 'empty' } });
      expect(count()).toBe(before + 2);
    } finally { setRunMode('stopped'); g.dispose(); }
  });
});

describe('outside an envelope the refusal names the exit that exists (#1552 review)', () => {
  it('a restore still landing says retry; a FAILED restore says reload — neither offers ⏹ Exit Preview', async () => {
    const g = createTestWorld({});
    try {
      setRunMode('stopped');
      let land!: () => void;
      const load = vi.spyOn(sceneManager, 'loadScene').mockImplementation(() => new Promise((r) => { land = () => r({} as never); }) as never);
      const restoring = restoreAuthoredSnapshot({ primary: { entities: [] } as never, key: '/s.json', bases: new Map() });
      const landing = await runAgentOp('create-entity', { spec: { kind: 'empty' } }).then(() => null, (e: unknown) => e as { message?: string; options?: string[] });
      // MUTATION TARGET: hand every reason the envelope exits and this names ⏹ Exit Preview.
      expect(landing?.message).toMatch(/restore is still landing.*about to be replaced/);
      expect(landing?.options).toEqual([expect.stringMatching(/^retry in a moment/)]);
      land(); await restoring;

      load.mockImplementation(() => Promise.reject(new Error('disk gone')) as never);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await restoreAuthoredSnapshot({ primary: { entities: [] } as never, key: '/s.json', bases: new Map() }).catch(() => {});
      const failed = await runAgentOp('create-entity', { spec: { kind: 'empty' } }).then(() => null, (e: unknown) => e as { message?: string; options?: string[] });
      expect(failed?.message).toMatch(/FAILED/);
      expect(failed?.options).toEqual([expect.stringMatching(/^modoki_load_scene/)]);
      err.mockRestore();
    } finally {
      // A failed restore stays flagged until a world swap — make one, as a reload from disk would.
      const { getCurrentWorld, setCurrentWorld } = await import('../../packages/modoki/src/runtime/core/ecs/worldRegistry');
      const { createWorld } = await import('koota');
      const before = getCurrentWorld(); const scratch = createWorld();
      setCurrentWorld(scratch); setCurrentWorld(before); scratch.destroy();
      g.dispose();
    }
  });

  it('player-prefs-write: outside an envelope a set goes through', async () => {
    const { PlayerPrefs, InMemoryBackend, resetPlayerPrefsForTest } = await import('../../packages/modoki/src/runtime/storage');
    await PlayerPrefs.init({ namespace: 'refuse-1552', backend: new InMemoryBackend() });
    try {
      setRunMode('stopped');
      const r = await runAgentOp('player-prefs-write', { action: 'set', key: 'agentSetup', value: 1 }) as { ok?: boolean };
      expect(r.ok).toBe(true);
      expect(PlayerPrefs.get('agentSetup')).toBe(1);
    } finally { resetPlayerPrefsForTest(); }
  });
});

describe('refusals that depend on a HELD session, and prefab create (#1551/#1552 re-review)', () => {
  async function withSession(fn: () => Promise<void>): Promise<void> {
    const g = createTestWorld({});
    const m = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0,
    };
    const { PlayerPrefs, InMemoryBackend, resetPlayerPrefsForTest } = await import('../../packages/modoki/src/runtime/storage');
    await PlayerPrefs.init({ namespace: 'refuse-held', backend: new InMemoryBackend() });
    try {
      setCurrentScenePath('/assets/scenes/t.scene.json');
      g.spawn(EntityAttributes({ name: 'A', guid: 'g-held-a' } as never), Transform({} as never));
      setRunMode('stopped');
      await fn();
    } finally { resetPlayerPrefsForTest(); g.dispose(); }
  }
  const refusal = (op: string, params: unknown) =>
    runAgentOp(op, params).then(() => null, (e: unknown) => e as { message?: string; options?: string[] });

  it('player-prefs-write refuses inside a held session with the owner\'s exits', () => withSession(async () => {
    enterScrubMode('timeline');
    expect(await tp.beginTimelinePreviewSession()).toBe(true);
    const r = await refusal('player-prefs-write', { action: 'set', key: 'agentSetup', value: 1 });
    // MUTATION TARGET: drop refusePrefsWriteInSession from the wrapper and this resolves.
    expect(r?.message).toMatch(/player-prefs-write refused: a preview session is open \(owned by the timeline panel\)/);
    expect(r?.options?.[0]).toMatch(/^modoki_play_control/);
    // MUTATION TARGET: refuse flush too and this throws — a flush changes no value.
    await runAgentOp('player-prefs-write', { action: 'flush' });
  }));

  it('ACCEPT SIDE: a PlayerPrefs write while a Stop restore lands goes through — nothing will put it back', () => withSession(async () => {
    let land!: () => void;
    vi.spyOn(sceneManager, 'loadScene').mockImplementation(() => new Promise((r) => { land = () => r({} as never); }) as never);
    const restoring = restoreAuthoredSnapshot({ primary: { entities: [] } as never, key: '/s.json', bases: new Map() });
    expect(whyWorldNotAuthored()).toMatch(/restore is still landing/);
    // MUTATION TARGET: gate the wrapper on whyWorldNotAuthored() again and this is refused.
    const r = await runAgentOp('player-prefs-write', { action: 'set', key: 'agentSetup', value: 1 }) as { ok?: boolean };
    expect(r.ok).toBe(true);
    land(); await restoring;
  }));

  it('a session held with the mode already stopped names Stop, not "a restore is landing"', () => withSession(async () => {
    enterScrubMode('timeline');
    expect(await tp.beginTimelinePreviewSession()).toBe(true);
    exitPreviewMode('timeline');                  // the mode left; the session did not
    expect(whyWorldNotAuthored()).toMatch(/a preview session is open/);
    const r = await refusal('create-entity', { spec: { kind: 'empty' } });
    // MUTATION TARGET: drop the held-session arm of posedWorldExits and this says "retry in a moment".
    expect(r?.options).toEqual([expect.stringMatching(/^modoki_play_control \{action:'stop'\}/)]);
  }));

  it('prefab create: an envelope gets its owner\'s exits; Play is refused too, since a FILE is written', () => withSession(async () => {
    enterScrubMode('timeline');
    const inEnvelope = await refusal('prefab', { action: 'create', entityGuid: 'g-held-a', path: '/assets/prefabs/x.prefab.json' });
    // MUTATION TARGET: restore the old hard-coded "exit-pose-envelope" text and a timeline envelope is sent to an op that refuses it.
    expect(inEnvelope?.options?.[0]).toMatch(/^modoki_play_control/);
    exitPreviewMode('timeline');
    setRunMode('playing');
    const inPlay = await refusal('prefab', { action: 'create', entityGuid: 'g-held-a', path: '/assets/prefabs/x.prefab.json' });
    expect(inPlay?.message).toMatch(/prefab create refused: run-mode is 'playing'.*stop Play first/);
    setRunMode('stopped');
  }));
});
