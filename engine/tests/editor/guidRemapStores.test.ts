/** Every store keyed by an entity guid follows `applyGuidRemap`'s rename (#1785).
 *
 *  `applyGuidRemap` (runtime/core/ecs/memberHome.ts) is the one rename — Create Prefab's stamp and its undo, unpack,
 *  a detach's relink. It re-keyed the world and, since #1778, R2's kept rows through a direct call; every other store
 *  held under the entity's old guid was then read under the new one and missed. The fix is one registry
 *  (`guidRemap.ts`) the rename walks, with each store registering from its own module.
 *
 *  Three of the stores are localStorage prefs, so a Map-backed one is installed before any module loads. Each case
 *  names the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
});
import {
  createTestWorld, type TestWorld, setPlayState, Transform, EntityAttributes, getCurrentWorld, applyOps, type MutableScene,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, undo, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { applyGuidRemap } from '../../packages/modoki/src/runtime/core/ecs/memberHome';
import { onGuidRemap, _guidRemapListenerNames } from '../../packages/modoki/src/runtime/core/ecs/guidRemap';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { saveCollapsedGuids, loadCollapsedGuids } from '../../packages/modoki/src/editor/panels/hierarchyCollapse';
import '../../packages/modoki/src/editor/animation/lastAnimationClip';
import { projectScopedKey } from '../../packages/modoki/src/editor/projectScopedKey';
import { _viewStatesForTest } from '../../packages/modoki/src/runtime/ui/entriesSystem';
import { useFocusStore, setFocus, pushScope, resetFocus } from '../../packages/modoki/src/runtime/ui/focusManager';
import { registerEditorRefLiveness, _heldPointerGuids } from '../../packages/modoki/src/editor/store/editorRefLiveness';
import { _sessionRowsForTest } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { startWatch, listWatches, clearWatch } from '../../app/debug/watch';

registerAllTraits();
registerEditorAgentOps();

const A = 'aaaaaaaa-0000-4000-8000-000000001785';
const B = 'bbbbbbbb-0000-4000-8000-000000001785';
const C = 'cccccccc-0000-4000-8000-000000001785';
const rename = (from = A, to = B) => applyGuidRemap(new Map([[from, to]]));

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory(); markSceneSaved();
  localStorage.clear();
  useEditorStore.setState({ cameraGizmoShown: new Set() });
});
afterEach(() => { game?.dispose(); game = undefined; });

const spawn = (name: string, guid: string, parentId = 0) =>
  (game!.spawn(Transform(), EntityAttributes({ name, guid, parentId })) as unknown as { id(): number }).id();

describe('the registry applyGuidRemap walks (#1785)', () => {
  // Mutation: drop the `notifyGuidRemap` call from applyGuidRemap — the listener never hears it.
  it('a registered listener hears the rename and the world it happened in', () => {
    spawn('X', A);
    const heard: Array<[string[], unknown]> = [];
    const off = onGuidRemap('test:hears', (remap, world) => heard.push([[...remap].flat(), world]));
    rename();
    off();
    expect(heard).toEqual([[[A, B], getCurrentWorld()]]);
  });

  // HMR re-executes a registering module: a second registration under one name must REPLACE, not add.
  // Mutation: keep the listeners in a Set/array (add instead of set) — the old closure runs too.
  it('a second registration under the same name replaces the first', () => {
    spawn('X', A);
    const calls: string[] = [];
    onGuidRemap('test:hmr', () => calls.push('old'));
    const off = onGuidRemap('test:hmr', () => calls.push('new'));
    rename();
    off();
    expect(calls).toEqual(['new']);
    expect(_guidRemapListenerNames()).not.toContain('test:hmr');
  });

  // Mutation: fan out with a bare `for (const fn of listeners.values()) fn(...)` instead of notifyListeners.
  it('one listener throwing is reported, and the stores after it still follow', () => {
    spawn('X', A);
    useEditorStore.getState().setCameraGizmoShown(A, true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The registry iterates in registration order, so `test:after` runs AFTER the thrower: it is starved unless each
    // listener is isolated. The gizmo store, registered at module load, runs before both.
    const offThrow = onGuidRemap('test:throws', () => { throw new Error('boom'); });
    const seen: string[] = [];
    const offAfter = onGuidRemap('test:after', (remap) => seen.push(...remap.values()));
    // Unregistered in `finally`: were the fan-out not isolated, the throw would escape `rename()` and leave the
    // thrower registered for every later test.
    try { rename(); } finally { offThrow(); offAfter(); }
    expect(seen).toEqual([B]);
    expect(err.mock.calls.some((c) => String(c.join(' ')).includes('boom'))).toBe(true);
    err.mockRestore();
    expect(useEditorStore.getState().cameraGizmoShown.has(B)).toBe(true);
  });
});

describe('each guid-keyed store follows the rename (#1785)', () => {
  // The issue's first row. Mutation: drop the `editor:cameraGizmoShown` registration in editorStore.ts.
  it('camera gizmo pref: the set and its localStorage copy name the new guid', () => {
    spawn('Cam', A);
    useEditorStore.getState().setCameraGizmoShown(A, true);
    rename();
    const s = useEditorStore.getState().cameraGizmoShown;
    expect([s.has(A), s.has(B)]).toEqual([false, true]);
    expect(JSON.parse(localStorage.getItem('editor-camframe-gizmo')!)).toEqual([B]);
  });

  // Mutation: drop the `editor:hierarchyCollapse` registration in hierarchyCollapse.ts.
  it('persisted Hierarchy collapse: every scene\'s saved list names the new guid', () => {
    spawn('Node', A);
    saveCollapsedGuids('/assets/scenes/One.json', [A, C]);
    rename();
    expect(loadCollapsedGuids('/assets/scenes/One.json')).toEqual([B, C]);
  });

  // Mutation: drop the `editor:lastAnimationClip` registration in lastAnimationClip.ts.
  it('last animation clip: the remembered Animator root names the new guid', () => {
    spawn('Rig', A);
    const key = projectScopedKey('editor:lastAnimationClip');
    localStorage.setItem(key, JSON.stringify({ path: '/a.anim.json', name: 'a', animatorGuid: A, scenePath: '/s.json' }));
    rename();
    expect(JSON.parse(localStorage.getItem(key)!).animatorGuid).toBe(B);
  });

  // Mutation: drop the `entriesSystem` registration in entriesSystem.ts.
  it('a pooled view\'s window state moves to the new guid, and the old key is gone', () => {
    spawn('View', A);
    const st = { marker: 1 };
    _viewStatesForTest().set(A, st);
    rename();
    expect(_viewStatesForTest().get(B)).toBe(st);
    expect(_viewStatesForTest().has(A)).toBe(false);
    _viewStatesForTest().clear();
  });

  // Mutation: drop the `focusManager` registration in focusManager.ts.
  it('UI focus: the focused element and the scope stack name the new guid', () => {
    spawn('Button', A); spawn('Modal', C);
    pushScope(C); setFocus(A);
    applyGuidRemap(new Map([[A, B], [C, 'dddddddd-0000-4000-8000-000000001785']]));
    const s = useFocusStore.getState();
    expect(s.focusedGuid).toBe(B);
    expect(s.scopeStack).toEqual(['', 'dddddddd-0000-4000-8000-000000001785']);
    resetFocus();
  });

  // The HeldEntity row: a hold's guid is only read after a respawn, so the fix re-takes the hold at the rename.
  // Mutation: drop the `editor:refLiveness` registration in editorRefLiveness.ts.
  it('editor pointers (selection, Animator root) are re-held under the new guid', () => {
    registerEditorRefLiveness();
    const id = spawn('Sel', A);
    useEditorStore.setState({ selectedEntityIds: [id], selectedEntityId: id, animatorRootEntityId: id });
    rename();
    expect(_heldPointerGuids()).toMatchObject({ selection: [B], animatorRoot: B });
    useEditorStore.setState({ selectedEntityIds: [], selectedEntityId: null, animatorRootEntityId: null });
  });

  // A PARKED pointer (its entity despawned, not back yet) has no id to re-take from (close-out review): re-taking put
  // null into the selection and every later reconcile threw. Mutation: re-take from `take(p.id)` instead of rewriting
  // the hold — the listing throws.
  it('a parked pointer keeps its hold, under the new guid, and reconcile still runs', async () => {
    registerEditorRefLiveness();
    const a = spawn('Kept', A);
    const c = spawn('Parked', C);
    useEditorStore.setState({ selectedEntityIds: [a, c], selectedEntityId: a });
    const { deleteEntity } = await import('../../packages/modoki/src/runtime/core/ecs/entityUtils');
    deleteEntity(c);   // the structure change parks C's pointer
    applyGuidRemap(new Map([[C, 'dddddddd-0000-4000-8000-000000001785']]));
    expect(_heldPointerGuids().selection).toEqual([A, 'dddddddd-0000-4000-8000-000000001785']);
    const { reconcileEditorRefs } = await import('../../packages/modoki/src/editor/store/editorRefLiveness');
    expect(() => reconcileEditorRefs()).not.toThrow();
    useEditorStore.setState({ selectedEntityIds: [], selectedEntityId: null });
  });

  // A remap whose values are also its keys (a ↔ b) swaps, never collapses (close-out review). Mutations: apply the gizmo
  // remap pair by pair (delete from, add to) — {A} ends as {A}; loop retargetFocusedGuid per pair — focus ends on A.
  it('a swapping remap swaps the gizmo pref and the focus', () => {
    spawn('X', A); spawn('Y', B);
    useEditorStore.getState().setCameraGizmoShown(A, true);
    setFocus(A);
    applyGuidRemap(new Map([[A, B], [B, A]]));
    expect([...useEditorStore.getState().cameraGizmoShown]).toEqual([B]);
    expect(useFocusStore.getState().focusedGuid).toBe(B);
    resetFocus();
  });

  // Mutation: drop the `agentWatch` registration in app/debug/watch.ts.
  it('an agent watch scoped to the guid keeps watching it under the new one', () => {
    spawn('Mover', A);
    const w = startWatch({ component: 'Transform', guids: [A], fields: ['x'] });
    expect(w.ok).toBe(true);
    rename();
    const listed = listWatches() as { watches: Array<{ id: string; guids: string[] }> };
    expect(listed.watches.find((x) => x.id === w.id)!.guids).toEqual([B]);
    clearWatch(w.id);
  });

  // Saved identity: the nodeGuid a prefab-edit save restores for a member brought back by an undo.
  // Mutation: drop the `prefabEdit:sessionRows` registration in prefabEdit.ts.
  it('prefab-edit session rows follow the rename of the edit world\'s entity', () => {
    spawn('Member', A);
    _sessionRowsForTest().set('prefab-1785', { rows: new Map([[A, { localId: 4, nodeGuid: 'n4' }]]), floor: 4 });
    rename();
    const rows = _sessionRowsForTest().get('prefab-1785')!.rows;
    expect([rows.has(A), rows.get(B)]).toEqual([false, { localId: 4, nodeGuid: 'n4' }]);
    _sessionRowsForTest().delete('prefab-1785');
  });
});

describe('Create Prefab end to end, and undo refs left alone on purpose (#1785)', () => {
  const NEW_PATH = '/assets/prefabs/Rig1785.prefab.json';
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    // Backend API calls succeed; an asset GET is absent (the prefab being created is not on disk yet).
    globalThis.fetch = (async (url: unknown) => (
      String(url).includes('/api/')
        ? { ok: true, status: 200, json: async () => ({ ok: true, files: [] }), text: async () => '{}' } as Response
        : { ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response
    )) as typeof globalThis.fetch;
    registerAsset('eeeeeeee-0000-4000-8000-000000001785', '/assets/scenes/Unused1785.json', 'scene');
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  const guidOf = (id: number) => (getCurrentWorld().entities.find((e) => e.id() === id)!.get(EntityAttributes) as { guid: string }).guid;

  /** R ── Hull (a held instance of a pre-v5 Child prefab: no nodeGuid rows) ── Bolt. Create Prefab from R swallows Hull,
   *  and Bolt — whose guid the reload would now derive through R — is renamed by the stamp. That is the rename a real
   *  Create Prefab performs; a plain child keeps its guid. */
  const CHILD = 'ffffffff-0000-4000-8000-000000001785';
  function heldInstanceTree(): { r: number; bolt: number; boltGuid: string } {
    registerAsset(CHILD, '/assets/prefabs/Child1785.prefab.json', 'prefab');
    setPrefabCache(CHILD, {
      id: CHILD, version: 3, name: 'Child', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'Hull', traits: { Transform: {}, EntityAttributes: { name: 'Hull', parentId: 0, guid: '' } } },
        { localId: 2, name: 'Bolt', traits: { Transform: {}, EntityAttributes: { name: 'Bolt', parentId: 1, guid: '' } } },
      ],
    } as never);
    const r = spawn('R', A);
    const hull = spawn('Hull', 'eeeeeeee-0000-4000-8000-00000000a785', r);
    const bolt = spawn('Bolt', C, hull);
    const pi = getTraitByName('PrefabInstance')!.trait;
    const at = (id: number) => getCurrentWorld().entities.find((e) => e.id() === id)!;
    at(hull).add(pi({ source: CHILD, localId: 1, rootInstanceId: hull }));
    at(bolt).add(pi({ source: CHILD, localId: 2, rootInstanceId: hull }));
    return { r, bolt, boltGuid: C };
  }
  afterEach(() => { setPrefabCache(CHILD, null); });

  // The issue's symptom through the real rename. Mutation: drop the `editor:cameraGizmoShown` registration.
  it('a gizmo pref on a swallowed member follows Create Prefab\'s stamp, and its undo', async () => {
    const { bolt } = heldInstanceTree();
    useEditorStore.getState().setCameraGizmoShown(C, true);
    const res = await runAgentOp('prefab', { action: 'create', entityGuid: A, path: NEW_PATH }) as { ok: boolean };
    expect(res.ok).toBe(true);
    const stamped = guidOf(bolt);
    expect(stamped).not.toBe(C);
    expect([...useEditorStore.getState().cameraGizmoShown]).toEqual([stamped]);
    await undo();
    expect(guidOf(bolt)).toBe(C);
    expect([...useEditorStore.getState().cameraGizmoShown]).toEqual([C]);
  });

  // Undo entries address entities by guid and are NOT re-keyed: each rename is itself an entry whose undo reverses
  // it before any older entry resolves (LIFO). Mutation: make the agent create's undo skip `unstampMemberGuids` — the
  // older edit then looks Bolt up by its original guid, finds nothing, and its x stays 9.
  it('an edit made before Create Prefab still undoes after the create is undone', async () => {
    const { bolt } = heldInstanceTree();
    writeTraitFieldWithUndo(bolt, getTraitByName('Transform')!, 'x', 9);
    await runAgentOp('prefab', { action: 'create', entityGuid: A, path: NEW_PATH });
    expect(guidOf(bolt)).not.toBe(C);
    await undo();   // the create: Bolt is C again
    await undo();   // the edit, addressed by C
    expect((getCurrentWorld().entities.find((e) => e.id() === bolt)!.get(Transform) as { x: number }).x).toBe(0);
  });
});

/** A durable guid changes only through `applyGuidRemap`; a generic field write of it is refused (#1785 close-out sweep).
 *  set-traits and apply-scene-ops wrote `EntityAttributes.guid` raw: the entity was renamed with no ref remap and no
 *  store told. One predicate, `fieldWriteRefusal`, answers all three generic paths. Mutation for the refusals: drop the
 *  `guid` branch at the top of fieldWriteRefusal — every refusal case below goes red and the accept cases stay green. */
describe('a generic write of a durable EntityAttributes.guid is refused (#1785)', () => {
  const attrsOf = (id: number) => getCurrentWorld().entities.find((e) => e.id() === id)!.get(EntityAttributes) as { guid: string };

  it('set-traits: refused, the entity keeps its guid', async () => {
    const id = spawn('X', A);
    const r = await runAgentOp('set-traits', { guid: A, set: { 'EntityAttributes.guid': B } }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/EntityAttributes\.guid is the entity's identity .*cannot rename it/);
    expect(attrsOf(id).guid).toBe(A);
  });

  it('apply-scene-ops setTrait: refused, the entity keeps its guid', async () => {
    const id = spawn('X', A);
    const r = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { guid: A }, trait: 'EntityAttributes', fields: { guid: B } }] }) as { errors: string[] };
    expect(r.errors.join('\n')).toMatch(/cannot rename it/);
    expect(attrsOf(id).guid).toBe(A);
  });

  it('file-direct scene-mutate: refused, the file keeps its guid', () => {
    const scene = (): MutableScene => ({ entities: [{ id: 1, name: 'X', traits: { EntityAttributes: { name: 'X', guid: A, parentId: 0 } } }] });
    const r = applyOps(scene(), [{ op: 'setTrait', entity: { guid: A }, trait: 'EntityAttributes', fields: { guid: B } }]);
    expect(r.errors.join('\n')).toMatch(/cannot rename it/);
    expect((r.scene.entities[0].traits.EntityAttributes as { guid: string }).guid).toBe(A);
  });

  // An instance root keeps its guid at the entry's top level (close-out re-review): read from its EntityAttributes
  // alone it looked absent, and the rename passed. Mutation: pass the trait's own `guid` as `current` in sceneMutate.
  it('file-direct scene-mutate: an instance root\'s rename is refused too', () => {
    const scene = (): MutableScene => ({ entities: [{ id: 1, name: 'Kit', guid: A, prefab: C, traits: { EntityAttributes: { name: 'Kit', parentId: 0 } } }] } as unknown as MutableScene);
    const r = applyOps(scene(), [{ op: 'setTrait', entity: { guid: A }, trait: 'EntityAttributes', fields: { guid: B } }]);
    expect(r.errors.join('\n')).toMatch(/cannot rename it/);
  });

  // A mint must be a guid. Mutation: accept any value when the entity holds no durable guid.
  it('a mint that is not a guid string is refused', async () => {
    const bare = spawn('Bare', '');
    const r = await runAgentOp('set-traits', { guid: attrsOf(bare).guid, set: { 'EntityAttributes.guid': 'hero' } }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must be a guid string \(got "hero"\)/);
  });

  // Accept side: writing back the guid it has, and giving an entity with NO durable guid one, are not renames.
  // Mutation: refuse every guid write (return the text unconditionally) — both go red.
  it('the current value, and a guid onto an entity without one, pass', async () => {
    spawn('X', A);
    const same = await runAgentOp('set-traits', { guid: A, set: { 'EntityAttributes.guid': A } }) as { ok: boolean };
    expect(same.ok).toBe(true);
    const bare = spawn('Bare', '');   // no durable guid: it reads a runtime one (#1210), which is how it is addressed
    const minted = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { guid: attrsOf(bare).guid }, trait: 'EntityAttributes', fields: { guid: C } }] }) as { errors: string[] };
    expect(minted.errors).toEqual([]);
    expect(attrsOf(bare).guid).toBe(C);
  });
});

