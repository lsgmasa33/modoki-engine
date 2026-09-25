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
