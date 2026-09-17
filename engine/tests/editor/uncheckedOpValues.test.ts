/** #1213 — an op that owns a vocabulary REFUSES a value outside it, with the table as `options`.
 *
 *  Every op here used to accept an unchecked value and answer ok: a gizmo typo was stored (and
 *  persisted), an unknown scene-view mode was dropped behind a state read, a journal `type` without
 *  its `!` matched nothing (so `wait-for-edit` parked its whole timeout), an unknown profiler action
 *  was served as a read, a registry name nobody knows was filtered out of `resolve-unsaved` so it
 *  answered "nothing is held", and an explicit `read-asset-def` type that contradicted the suffix
 *  peeked the wrong cache and blamed the scene.
 *
 *  The MCP `z.enum`s hide most of these from tool calls; `/api/editor-action`, `modoki_eval` and the
 *  device relay reach the ops directly, so this tier is the cover. Each op has a refusal case (state
 *  unchanged, `options` = the table) and an accept case (a valid value still works) — a refusal that
 *  refuses everything would pass the first alone. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useEditorStore, EDITOR_JOURNAL_TYPES, GIZMO_MODES, GIZMO_SPACES, SCENE_VIEW_MODES,
  editorEmit, clearEditorJournal, setEditorJournalEnabled, colliderEditBlocker, isColliderEditable,
} from '@modoki/engine/editor';
import { PLAY_STATES, RUN_MODES } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp, resolveAssetDefKind, READABLE_ASSET_DEF_TYPES } from '../../app/debug/agentBridge';
import { OpRefusal } from '../../app/debug/opRefusal';
import { conditionError } from '../../app/debug/waitFor';
import { PROFILER_ACTIONS } from '../../tools/shared/profilerActions';
import {
  setParticleEffect, registerAsset, createTestWorld, type TestWorld, EntityAttributes, Collider2D,
} from '@modoki/engine/runtime';

registerAllTraits();
registerEditorAgentOps();

/** The thrown refusal an op raised, or a failure naming what came back instead. */
async function refusalOf(op: string, params: unknown): Promise<OpRefusal> {
  try {
    const r = await runAgentOp(op, params);
    throw new Error(`${op} ${JSON.stringify(params)} answered instead of refusing: ${JSON.stringify(r).slice(0, 200)}`);
  } catch (e) {
    if (!(e instanceof OpRefusal)) throw e;
    return e;
  }
}

describe('set-gizmo (B-8, B-9)', () => {
  beforeEach(() => { useEditorStore.setState({ gizmoMode: 'translate', gizmoSpace: 'world' }); });

  it('REFUSES an unknown mode, and stores nothing', async () => {
    const e = await refusalOf('set-gizmo', { mode: 'rotat' });
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.options).toEqual([...GIZMO_MODES]);
    expect(useEditorStore.getState().gizmoMode).toBe('translate');
  });

  it('REFUSES an unknown space, and does not half-apply a good mode sent beside it', async () => {
    const e = await refusalOf('set-gizmo', { mode: 'scale', space: 'global' });
    expect(e.options).toEqual([...GIZMO_SPACES]);
    expect(useEditorStore.getState()).toMatchObject({ gizmoMode: 'translate', gizmoSpace: 'world' });
  });

  it('REFUSES an empty call — a no-op must not report success', async () => {
    const e = await refusalOf('set-gizmo', {});
    expect(e.message).toMatch(/nothing to set/);
  });

  it('still sets a valid mode and space', async () => {
    const r = await runAgentOp('set-gizmo', { mode: 'rotate', space: 'local' }) as { gizmoMode: string; gizmoSpace: string };
    expect(r).toMatchObject({ gizmoMode: 'rotate', gizmoSpace: 'local' });
    expect(useEditorStore.getState()).toMatchObject({ gizmoMode: 'rotate', gizmoSpace: 'local' });
  });
});

describe('set-scene-view-mode (B-7)', () => {
  beforeEach(() => { useEditorStore.setState({ sceneViewMode: '3d' }); });

  it('REFUSES an unknown or missing mode, and leaves the view alone', async () => {
    for (const params of [{ mode: '2d' }, {}]) {
      const e = await refusalOf('set-scene-view-mode', params);
      expect(e.options).toEqual([...SCENE_VIEW_MODES]);
    }
    expect(useEditorStore.getState().sceneViewMode).toBe('3d');
  });

  it('still switches to a valid mode', async () => {
    await runAgentOp('set-scene-view-mode', { mode: 'ui' });
    expect(useEditorStore.getState().sceneViewMode).toBe('ui');
  });
});

describe('journal `type` filters (B-5, and editor-journal beside it)', () => {
  beforeEach(() => { setEditorJournalEnabled(true); clearEditorJournal(); });

  it('editor-journal REFUSES a type outside the table', async () => {
    editorEmit('!edit');
    const e = await refusalOf('editor-journal', { type: 'edit' });
    expect(e.options).toEqual([...EDITOR_JOURNAL_TYPES]);
    expect(e.message).toMatch(/start with '!'/);
  });

  it('wait-for-edit REFUSES a type outside the table BEFORE parking', async () => {
    // A long timeout: if the refusal were not up front, this would sit it out and time the test out.
    const started = Date.now();
    const e = await refusalOf('wait-for-edit', { type: 'edit', timeoutMs: 60_000 });
    expect(e.options).toEqual([...EDITOR_JOURNAL_TYPES]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a valid type still filters', async () => {
    editorEmit('!edit'); editorEmit('!select');
    const r = await runAgentOp('editor-journal', { type: '!select' }) as { editor: Array<{ type: string }> };
    expect(r.editor.map((ev) => ev.type)).toEqual(['!select']);
  });
});

describe('wait-for editor condition values (B-11)', () => {
  const readers = { whereError: () => null };

  it('refuses a playState or runMode that can never match', () => {
    expect(conditionError({ editor: { playState: 'Playing' } }, readers)).toMatch(new RegExp(PLAY_STATES.join(', ')));
    expect(conditionError({ editor: { runMode: 'play' } }, readers)).toMatch(new RegExp(RUN_MODES.join(', ')));
  });

  it('accepts every member of both tables', () => {
    for (const playState of PLAY_STATES) expect(conditionError({ editor: { playState } }, readers)).toBeNull();
    for (const runMode of RUN_MODES) expect(conditionError({ editor: { runMode } }, readers)).toBeNull();
  });
});

describe('profiler actions (B-6)', () => {
  it('REFUSES an unknown action instead of serving a read', async () => {
    const r = await runAgentOp('profiler', { action: 'capture-strat' }) as { ok?: boolean; code?: string; options?: string[]; frame?: unknown };
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(r.options).toEqual([...PROFILER_ACTIONS]);
    expect(r.frame).toBeUndefined();
  });

  it('REFUSES a non-numeric limit instead of reading an empty slice', async () => {
    const r = await runAgentOp('profiler', { action: 'capture-read', limit: 'five' }) as { ok?: boolean; code?: string };
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
  });

  it('still runs a valid action', async () => {
    expect(await runAgentOp('profiler', { action: 'capture-clear' })).toEqual({ cleared: true });
  });
});

describe('resolve-unsaved registries', () => {
  it('REFUSES an unknown registry instead of checking nothing and answering "nothing held"', async () => {
    const e = await refusalOf('resolve-unsaved', { registries: ['bogus'] });
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.options?.length).toBeGreaterThan(0);
    expect(e.options).not.toContain('bogus');
  });

  it('REFUSES a registries value that is not a list, naming the shape rather than calling it unknown', async () => {
    const e = await refusalOf('resolve-unsaved', { registries: 'pendingMeta' });
    expect(e.message).toMatch(/must be a LIST/);
  });

  it('still answers with a valid registry', async () => {
    const valid = (await refusalOf('resolve-unsaved', { registries: ['bogus'] })).options![0];
    const r = await runAgentOp('resolve-unsaved', { registries: [valid] }) as { holds: unknown[] };
    expect(Array.isArray(r.holds)).toBe(true);
  });
});

describe('read-asset-def kind (C-23)', () => {
  const PARTICLE = '/assets/fx/c23.particle.json';

  it('REFUSES a type that contradicts the suffix, naming the suffix kind — both twins share this', async () => {
    setParticleEffect(PARTICLE, { maxParticles: 1 } as never);
    const shared = resolveAssetDefKind(PARTICLE, 'animation');
    expect(shared).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: ['particle'] });
    // The editor twin — the one that used to answer "nothing in the open scene has loaded it"
    // about a particle that WAS loaded.
    const e = await refusalOf('read-asset-def', { path: PARTICLE, type: 'animation' });
    expect(e.message).toMatch(/contradicts the path/);
    expect(e.options).toEqual(['particle']);
  });

  it('still reads with a matching type, with none, and with any type on a suffix-less path', async () => {
    setParticleEffect(PARTICLE, { maxParticles: 1 } as never);
    expect(await runAgentOp('read-asset-def', { path: PARTICLE, type: 'particle' })).toMatchObject({ ok: true });
    expect(await runAgentOp('read-asset-def', { path: PARTICLE })).toMatchObject({ ok: true });
    for (const t of READABLE_ASSET_DEF_TYPES) expect(resolveAssetDefKind('/assets/x/guidless', t)).toEqual({ kind: t });
  });
});

describe('set-collider-edit (B-2) — the op asks the predicate SceneView\'s button asks', () => {
  let tw: TestWorld | undefined;
  afterEach(() => { tw?.dispose(); tw = undefined; useEditorStore.setState({ colliderEditMode: false, selectedEntityId: null }); });
  const select = (e: { id(): number } | null) => useEditorStore.setState({ selectedEntityId: e ? e.id() : null, colliderEditMode: false });

  it('REFUSES on:true with nothing, or a non-point collider, selected — the mode stays off', async () => {
    tw = createTestWorld({});
    const box = tw.spawn(EntityAttributes({ name: 'Box', guid: 'b2-box' }), Collider2D({ shape: 'box' }));
    for (const target of [null, box]) {
      select(target);
      const e = await refusalOf('set-collider-edit', { on: true });
      expect(e.message).toMatch(target ? /shape 'box'/ : /nothing is selected/);
      expect(useEditorStore.getState().colliderEditMode).toBe(false);
      expect(colliderEditBlocker(useEditorStore.getState().selectedEntityId)).not.toBeNull();
    }
  });

  it('REFUSES a missing or non-boolean on — even with an editable collider selected', async () => {
    tw = createTestWorld({});
    select(tw.spawn(EntityAttributes({ name: 'Poly', guid: 'b2-poly-nb' }), Collider2D({ shape: 'polygon' })));
    for (const params of [{}, { on: 'true' }]) {
      const e = await refusalOf('set-collider-edit', params);
      expect(e.message).toMatch(/on must be true or false/);
    }
    expect(useEditorStore.getState().colliderEditMode).toBe(false);
  });

  it('enters the mode for a point-list collider, and on:false always works', async () => {
    tw = createTestWorld({});
    const poly = tw.spawn(EntityAttributes({ name: 'Poly', guid: 'b2-poly' }), Collider2D({ shape: 'polygon' }));
    select(poly);
    expect(isColliderEditable(poly.id())).toBe(true);
    await expect(runAgentOp('set-collider-edit', { on: true })).resolves.toMatchObject({ ok: true, colliderEditMode: true });
    select(null);
    await expect(runAgentOp('set-collider-edit', { on: false })).resolves.toMatchObject({ ok: true, colliderEditMode: false });
  });
});

describe('set-playhead — a clip must be open, and t must be a number', () => {
  afterEach(() => { useEditorStore.setState({ editingAnimationClip: null, editingTimelineDoc: null, editingTimelineAsset: null, playheadTime: 0 }); });

  it('REFUSES with no clip and no timeline open, and does not move the playhead', async () => {
    useEditorStore.setState({ editingAnimationClip: null, editingTimelineDoc: null, playheadTime: 0 });
    const e = await refusalOf('set-playhead', { t: 1 });
    expect(e.code).toBe('NOT_FOUND');
    expect(e.options?.[0]).toMatch(/modoki_open_animation_editor/);
    expect(useEditorStore.getState().playheadTime).toBe(0);
  });

  it('REFUSES a non-number t instead of reading it as 0', async () => {
    useEditorStore.setState({ editingAnimationClip: { name: 'walk', duration: 2 } as never, playheadTime: 1 });
    await refusalOf('set-playhead', { t: 'half' });
    expect(useEditorStore.getState().playheadTime).toBe(1);
  });

  it('an open TIMELINE is enough — the Timeline editor reads the same playhead', async () => {
    useEditorStore.setState({
      editingAnimationClip: null,
      editingTimelineDoc: { tracks: [] } as never,
      editingTimelineAsset: { path: '/assets/timelines/intro.timeline.json', type: 'timeline', name: 'intro' },
    });
    await expect(runAgentOp('set-playhead', { t: 3 })).resolves.toMatchObject({ ok: true, playhead: 3, boundTimeline: '/assets/timelines/intro.timeline.json' });
  });

  it('still moves the playhead on an open clip, clamping visibly', async () => {
    useEditorStore.setState({ editingAnimationClip: { name: 'walk', duration: 2 } as never });
    await expect(runAgentOp('set-playhead', { t: 5 })).resolves.toMatchObject({ ok: true, playhead: 2, clampedFrom: 5 });
  });
});

describe('open-particle-editor waits for its panel to mount', () => {
  const PATH = '/assets/fx/wait.particle.json';
  registerAsset('00000012-0000-4000-8000-000000000012', PATH, 'particle');
  afterEach(() => { vi.useRealTimers(); useEditorStore.setState({ editorMounts: {}, editingParticleAsset: null }); });

  it('answers ok once the panel publishes the asset', async () => {
    const unsub = useEditorStore.subscribe((st) => {
      const path = st.editingParticleAsset?.path ?? null;
      if (path && st.editorMounts.particle?.path !== path) st.setEditorMount('particle', { path });
    });
    try {
      await expect(runAgentOp('open-particle-editor', { path: PATH })).resolves.toMatchObject({ ok: true, openEditors: { particle: PATH } });
    } finally { unsub(); }
  });

  it('REFUSES when nothing mounts', async () => {
    vi.useFakeTimers();
    const pending = runAgentOp('open-particle-editor', { path: PATH }).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await pending).toMatchObject({ code: 'NOT_AVAILABLE_HERE' });
  });
});

describe('attribution across an opener\'s wait (#1213 reviews)', () => {
  const PATH = '/assets/fx/attr.particle.json';
  registerAsset('00000013-0000-4000-8000-000000000013', PATH, 'particle');
  beforeEach(() => { setEditorJournalEnabled(true); clearEditorJournal(); });
  afterEach(() => { vi.useRealTimers(); useEditorStore.setState({ editorMounts: {}, editingParticleAsset: null }); });

  it('the editor\'s REACTION to the open is the agent\'s, and two overlapping openers leave the actor human once both settle', async () => {
    vi.useFakeTimers();
    // The effect that reacts to the store (EditorApp selecting the tab → `!focus`) runs AFTER the
    // op's synchronous part — attributing only that part tagged the agent's own open as the human's.
    const unsub = useEditorStore.subscribe((st, prev) => {
      if (st.editingParticleAsset !== prev.editingParticleAsset) queueMicrotask(() => editorEmit('!focus', { reaction: true }));
    });
    try {
      // Overlapping, and both time out: the save/restore interleaving that stuck the actor on 'agent'.
      const a = runAgentOp('open-particle-editor', { path: PATH }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      const b = runAgentOp('open-particle-editor', { path: PATH }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_500);
      await a;                                  // A settles while B is still waiting
      await vi.advanceTimersByTimeAsync(1_500);
      await b;
    } finally { unsub(); }
    editorEmit('!select', { after: true });
    const tagged = (await runAgentOp('editor-journal', {}) as { editor: Array<{ type: string; source: string }> })
      .editor.map((e) => [e.type, e.source]);
    // One reaction per open (each re-points the store), both the agent's; the edit after both is the human's.
    expect(tagged).toEqual([['!focus', 'agent'], ['!focus', 'agent'], ['!select', 'human']]);
  });
});

describe('openEditors lists only editors SHOWING an asset', () => {
  afterEach(() => useEditorStore.setState({ editorMounts: {} }));

  it('omits a panel mounted with nothing loaded, which requireEditorOpen would refuse', async () => {
    useEditorStore.setState({ editorMounts: { skin: { path: null }, particle: { path: '/assets/fx/a.particle.json' } } });
    const s = await runAgentOp('editor-state', {}) as { openEditors: Record<string, string> };
    expect(s.openEditors).toEqual({ particle: '/assets/fx/a.particle.json' });
  });
});

describe('setEditorMount — a late cleanup must not erase a newer mount', () => {
  afterEach(() => useEditorStore.setState({ editorMounts: {} }));

  // React runs one instance's cleanup before its next setup, so this ordering needs TWO instances of
  // an editor (a second tab of the same panel) — the guard is for that, not for a single panel.
  it('ignores a clear for a path that is no longer the published one', () => {
    const st = useEditorStore.getState();
    st.setEditorMount('skin', { path: '/b.rig2d.json' });
    st.setEditorMount('skin', null, '/a.rig2d.json'); // the OLD asset's cleanup, landing late
    expect(useEditorStore.getState().editorMounts.skin?.path).toBe('/b.rig2d.json');
    st.setEditorMount('skin', null, '/b.rig2d.json');
    expect(useEditorStore.getState().editorMounts.skin).toBeUndefined();
  });
});
