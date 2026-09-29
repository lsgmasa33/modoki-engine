/** #1816, #1825 — an agent's generic trait write in the editor lands the way a human Inspector edit does.
 *
 *  `set-traits` was the device's raw op in the editor too: every non-parent field went through `writeTraitField`, so
 *  the write had no undo entry, no dirty mark (the next file-write hot reload dropped it with nothing refusing) and no
 *  prefab override mark (the save did not write a member's field). The editor now replaces the op, and every write
 *  goes through `writeTraitAsEditor` — the one editor write apply-scene-ops' setTrait uses too. That writer also sends
 *  a parent change on an entity that LACKS EntityAttributes through the reparent: it used to be seeded raw (#1825).
 *
 *  Each case names the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, getPlayState, Transform, EntityAttributes, getCurrentWorld } from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, canUndo, undo, hasUnsavedChanges, pushAction, undoStep, undoLabel } from '@modoki/engine/editor';
import { _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { markStateOf } from '../../packages/modoki/src/editor/undo/overrideMarkWrites';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const PATH = '/p1816.prefab.json';

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  _resetHistoryContexts(); clearHistory(); markSceneSaved(); clearAllSceneDirty();
  setPrefabCache(PATH, {
    id: 'c1816000-0000-4000-8000-000000000001', version: 2, name: 'Kit', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } },
      { localId: 2, name: 'Slot', traits: { EntityAttributes: { name: 'Slot', parentId: 1 }, Transform: {} } },
    ],
  } as never);
});
afterEach(() => { setPrefabCache(PATH, null); game?.dispose(); game = undefined; clearAllSceneDirty(); });

const live = (id: number) => getCurrentWorld().entities.find((e) => e.id() === id)!;
const attrs = (id: number) => live(id).get(EntityAttributes) as { parentId: number; guid: string } | undefined;
const x = (id: number) => (live(id).get(Transform) as { x: number }).x;
const spawn = (name: string, extra: Record<string, unknown> = {}) =>
  (game!.spawn(Transform(), EntityAttributes({ name, guid: crypto.randomUUID(), ...extra })) as unknown as { id(): number }).id();
/** An entity with a Transform and NO EntityAttributes — the trait-less seed of #1825. A spawn gives every entity one
 *  (#1248), so it is taken off again; with no guid left, the entity is addressed by id. */
const spawnBare = () => {
  const e = game!.spawn(Transform()) as unknown as { id(): number; remove(t: unknown): void };
  e.remove(EntityAttributes);
  return e.id();
};
const hasEa = (id: number) => live(id).has(getTraitByName('EntityAttributes')!.trait);
type Reply = { ok: boolean; error?: string; savedNote?: string; changed?: number };
const setTraits = (params: Record<string, unknown>) => runAgentOp('set-traits', params) as Promise<Reply>;

describe('editor set-traits writes the way the Inspector does (#1816)', () => {
  // Mutation: in writeTraitAsEditor, write `rest` with the raw writeTraitField instead of writeTraitFieldWithUndo —
  // x=5 lands, but nothing can undo it and the scene is not dirty.
  it('a field write is one undo entry and marks the scene unsaved; undo restores it', async () => {
    const a = spawn('A');
    const r = await setTraits({ guid: attrs(a)!.guid, set: { 'Transform.x': 5 } });
    expect(r.ok).toBe(true);
    expect(x(a)).toBe(5);
    expect(canUndo()).toBe(true);
    expect(hasUnsavedChanges()).toBe(true);
    expect(r.savedNote).toMatch(/marked unsaved.*one undo entry/);
    await undo();
    expect(x(a)).toBe(0);
  });

  // Mutation: drop the runAsCompositeAction around applySetTraits in the editor's set-traits — each target's write is
  // its own entry, and one undo restores only the last.
  it('a call over several targets is ONE undo entry', async () => {
    const a = spawn('A'); const b = spawn('B');
    await setTraits({ guid: [attrs(a)!.guid, attrs(b)!.guid], set: { 'Transform.x': 7 } });
    expect([x(a), x(b)]).toEqual([7, 7]);
    await undo();
    expect([x(a), x(b)]).toEqual([0, 0]);
    expect(canUndo()).toBe(false);
  });

  // Mutation: in editorTraitWriter.write, write a tag with the raw writeTraitField — added, but no undo entry.
  it('a tag add and a tag remove are each undoable', async () => {
    const a = spawn('A');
    const persistent = getTraitByName('Persistent')!.trait;
    await setTraits({ guid: attrs(a)!.guid, set: { Persistent: true } });
    expect(live(a).has(persistent)).toBe(true);
    await setTraits({ guid: attrs(a)!.guid, set: { Persistent: false } });
    expect(live(a).has(persistent)).toBe(false);
    await undo();
    expect(live(a).has(persistent)).toBe(true);
    await undo();
    expect(live(a).has(persistent)).toBe(false);
  });

  // The #1709 half: a member's field is saved only when marked. Same mutation as the first case — the raw write marks nothing.
  it('a prefab member\'s field is override-marked, so the save writes it', async () => {
    await runAgentOp('prefab', { action: 'instantiate', path: PATH });
    const slot = getCurrentWorld().entities.find((e) => (e.get(EntityAttributes) as { name?: string } | undefined)?.name === 'Slot')!.id();
    expect(markStateOf(slot, 'Transform', ['x']).x).toBe(false);
    const r = await setTraits({ guid: attrs(slot)!.guid, set: { 'Transform.x': 3 } });
    expect(r.ok).toBe(true);
    expect(markStateOf(slot, 'Transform', ['x']).x).toBe(true);
    await undo();
    expect(markStateOf(slot, 'Transform', ['x']).x).toBe(false);
  });

  // A dry run writes nothing, so it records nothing. Mutation: drop `!p.dryRun &&` before `deps.writer` in
  // applyLiveMutate — the writer runs and x=5 lands. (The handler's own dry-run branch, which skips the posed-world
  // refusal, is pinned in writersRefuseUnauthoredWorld.test.ts.)
  it('a dry run changes nothing and records nothing', async () => {
    const a = spawn('A');
    const r = await setTraits({ guid: attrs(a)!.guid, set: { 'Transform.x': 5 }, dryRun: true });
    expect(r.ok).toBe(true);
    expect(x(a)).toBe(0);
    expect(canUndo()).toBe(false);
  });

  // Owner B's gate (#1832) covers the new writer: an agent edit during an awaiting undo step would lose its entry, so it
  // is refused rather than queued. Mutation: take 'set-traits' out of UNDO_RECORDING_OPS — the write lands mid-step.
  it('inside an undo step\'s window it is REFUSED, writes nothing, and leaves no entry', async () => {
    const a = spawn('A');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    pushAction({ label: 'Async asset step', undo: async () => { await gate; }, redo: async () => {} });
    const step = undoStep('undo');
    try {
      await new Promise((r) => setTimeout(r, 0));
      const err = await setTraits({ guid: attrs(a)!.guid, set: { 'Transform.x': 5 } }).then(() => null, (e: { code?: string; message: string }) => e);
      expect(err?.code).toBe('REFUSED_BY_OP');
      expect(err?.message).toContain('undo/redo step is still running');
      expect(x(a)).toBe(0);
    } finally { release(); await step; }
    expect(canUndo()).toBe(false);
    expect(undoLabel()).not.toBe('Set Traits');
  });
});

describe('a write during Play is reverted by Stop, dirty mark and all (#1816 close-out review)', () => {
  afterEach(async () => { if (getPlayState() !== 'stopped') await runAgentOp('stop'); });
  const s = { guid: '' };
  const play = async () => { const r = await runAgentOp('play') as { ok?: boolean }; expect(r.ok).not.toBe(false); };

  // A write in Play is undoable while Play runs, and Stop reverts the world and cuts the stack at Play's barrier — but it
  // left the dirty mark, so the editor read "unsaved" with nothing to undo or save. Mutation: drop the
  // `restoreWorldDirtyBaseline` call in stopPlay — unsaved stays true after Stop.
  it('a clean scene is clean again after Stop, with nothing to undo', async () => {
    const a = spawn('A'); s.guid = attrs(a)!.guid;
    await play();
    const r = await setTraits({ guid: s.guid, set: { 'Transform.x': 5 } });
    expect(r.ok).toBe(true);
    expect(r.savedNote).toMatch(/Play world only: Stop reverts this write/);
    expect(hasUnsavedChanges()).toBe(true);
    const stop = await runAgentOp('stop') as { reverted?: boolean };
    expect(stop.reverted).toBe(true);
    const back = getCurrentWorld().entities.find((e) => (e.get(EntityAttributes) as { guid?: string } | undefined)?.guid === s.guid)!;
    expect((back.get(Transform) as { x: number }).x).toBe(0);
    expect(canUndo()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
  });

  // Only clears: an edit made BEFORE Play is still unsaved after Stop, and still undoable. Mutation: make
  // restoreWorldDirtyBaseline call markSceneSaved unconditionally — the pre-Play edit reads saved.
  it('an edit made before Play stays unsaved after Stop', async () => {
    const a = spawn('A'); s.guid = attrs(a)!.guid;
    await setTraits({ guid: s.guid, set: { 'Transform.x': 3 } });
    await play();
    await setTraits({ guid: s.guid, set: { 'Transform.x': 5 } });
    await runAgentOp('stop');
    const back = getCurrentWorld().entities.find((e) => (e.get(EntityAttributes) as { guid?: string } | undefined)?.guid === s.guid)!;
    expect((back.get(Transform) as { x: number }).x).toBe(3);
    expect(hasUnsavedChanges()).toBe(true);
    expect(canUndo()).toBe(true);
  });
});

describe('a parent change on an entity that lacks EntityAttributes is a reparent too (#1825)', () => {
  // X has no EntityAttributes; C is its child (C.parentId = X). Giving X the parent C closes a cycle.
  // Mutation: seed the trait with `fields` (parentId included) in writeTraitAsEditor, as before — the seed writes
  // X.parentId = C raw and the call succeeds.
  it('apply-scene-ops setTrait: a cyclic seed is refused, and X stays trait-less', async () => {
    const bare = spawnBare();
    const c = spawn('C', { parentId: bare });
    const r = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { id: bare }, trait: 'EntityAttributes', fields: { name: 'X', parentId: c } }] }) as { ok: boolean; errors: string[] };
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/refused to move \d+ under \d+ — the move is illegal \(\d+ is a descendant of \d+\)/);
    expect(hasEa(bare)).toBe(false);
  });

  // The same writer serves set-traits. A cycle is caught there first by the device's own guard, so this asks the one
  // thing only `planReparent` refuses: a parent in another scene is a scene move. Two layers refuse it — the writer's
  // pre-check over every target (`editorTraitWriter.refusal`) and `writeTraitAsEditor`'s own — so it goes red only
  // with both gone: null the pre-check AND seed the parent raw.
  it('set-traits: a seed under another scene\'s parent is refused as a scene move, and X stays trait-less', async () => {
    const bare = spawnBare();
    const other = spawn('Other', { sourceScene: 'b1816000-0000-4000-8000-000000000001' });
    const r = await setTraits({ id: bare, set: { 'EntityAttributes.parentId': other } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/belongs to another scene .* use reparent-entity with moveToScene: true/);
    expect(hasEa(bare)).toBe(false);
  });

  // Accept side: a legal parent seeds the trait and moves X, as one undo entry that takes both back.
  // Mutation: skip applyReparent when the trait was absent — X is seeded at the root.
  it('a legal parent seeds the trait and reparents, and one undo takes both back', async () => {
    const bare = spawnBare();
    const p = spawn('P');
    const r = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { id: bare }, trait: 'EntityAttributes', fields: { name: 'X', parentId: p } }] }) as { ok: boolean; errors: string[]; addedTraits?: unknown[] };
    expect(r.errors).toEqual([]);
    expect(attrs(bare)?.parentId).toBe(p);
    expect(r.addedTraits).toHaveLength(1);
    await undo();
    expect(hasEa(bare)).toBe(false);
  });
});
