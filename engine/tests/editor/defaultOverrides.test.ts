/** Default overrides (#1831, hub ruling "copy Unity"): an instance ROOT's name, sort order, local position and rotation,
 *  and a UI root's layout rect, are left alone by Apply All and Revert All, and applied or reverted only when asked for
 *  ALONE. Unity (`PrefabUtility.IsDefaultOverride`): "Using Apply All or Revert All on a Prefab instance will not affect
 *  default overrides. The only way to apply or revert a default override is to use the context menu for the property
 *  itself." Driven the way production drives it: `runAgentOp` on the registered editor ops, whose omitted `keys` is the
 *  agent's Apply All / Revert All. The dialog's own pre-check reads the same set, `effectiveDefaults` (its decisions are
 *  unit-tested in applyDialogModel.test.ts). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const writes = vi.hoisted(() => [] as string[]);
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string) => { writes.push(path); return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response; },
}));

import {
  createTestWorld, type TestWorld, setPlayState, getTraitByName, writeTraitField, findEntity, getAllEntities, readTraitData,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { setPrefabCache, setPrefabSource, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { markOverride } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const P = 'dddddddd-0000-4000-8000-000000001831';
const U = 'dddddddd-0000-4000-8000-000000001832';
const O = 'dddddddd-0000-4000-8000-000000001833';
const G = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** P: R → A, both with a Transform. */
const pDoc = { id: P, version: 6, name: 'P', rootLocalId: 1, entities: [
  { localId: 1, name: 'R', nodeGuid: G(1), traits: { EntityAttributes: { name: 'R', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 } } },
  { localId: 2, name: 'A', nodeGuid: G(2), traits: { EntityAttributes: { name: 'A', parentId: 1, guid: '' }, Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 } } },
] };
/** U: a UI root Panel → Label. */
const uiTraits = (name: string, parentId: number) => ({
  EntityAttributes: { name, parentId, guid: '' }, RenderableUI: {},
  UIAnchor: { anchor: 'center', top: 0, left: 0, right: 0, bottom: 0, pivotX: 0.5, pivotY: 0.5 },
  UIElement: { width: 100, height: 40, rotation: 0, scale: 1 },
});
const uDoc = { id: U, version: 6, name: 'U', rootLocalId: 1, entities: [
  { localId: 1, name: 'Panel', nodeGuid: G(11), traits: uiTraits('Panel', 0) },
  { localId: 2, name: 'Label', nodeGuid: G(12), traits: uiTraits('Label', 1) },
] };

/** O: OR → N, a reference row of P. */
const oDoc = { id: O, version: 6, name: 'O', rootLocalId: 1, entities: [
  { localId: 1, name: 'OR', nodeGuid: G(21), traits: { EntityAttributes: { name: 'OR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 } } },
  { localId: 2, name: 'N', nodeGuid: G(22), prefab: P, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } } },
] };

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  writes.length = 0;
  registerAsset(P, '/assets/prefabs/P.prefab.json', 'prefab');
  registerAsset(U, '/assets/prefabs/U.prefab.json', 'prefab');
  registerAsset(O, '/assets/prefabs/O.prefab.json', 'prefab');
  setPrefabCache(P, structuredClone(pDoc) as never);
  setPrefabCache(U, structuredClone(uDoc) as never);
  setPrefabCache(O, structuredClone(oDoc) as never);
});
afterEach(() => { game?.dispose(); game = undefined; setPrefabCache(P, null); setPrefabCache(U, null); setPrefabCache(O, null); });

/** Set and mark (as an editor write does) `trait.field` = `value` on `id`. */
function edit(id: number, trait: string, field: string, value: unknown): void {
  writeTraitField(id, getTraitByName(trait)!, field, value);
  markOverride(findEntity(id)!, trait, field);
}
const byName = (name: string) => getAllEntities().find((e) => e.name === name)!.id;
const read = (id: number, trait: string) => readTraitData(id, getTraitByName(trait)!) as Record<string, unknown>;
const templateRow = (src: string, localId: number) => getCachedPrefabSync(src)!.entities.find((e) => e.localId === localId)!.traits as Record<string, Record<string, unknown>>;

/** A P instance: its root renamed, reordered, moved and turned, and member A moved — all marked. */
function pInstance(): { guid: string; root: number } {
  const root = instantiatePrefab(pDoc as never, 0);
  setPrefabSource(root, { id: P });
  writeTraitField(root, getTraitByName('EntityAttributes')!, 'guid', 'g-p-root');
  edit(root, 'EntityAttributes', 'name', 'R copy');
  edit(root, 'EntityAttributes', 'sortOrder', 1);
  edit(root, 'Transform', 'x', 5);
  edit(root, 'Transform', 'rx', 0.5);
  edit(byName('A'), 'Transform', 'x', 7);
  return { guid: 'g-p-root', root };
}
// The rx edit marks the WHOLE rotation (#1880 F5: rotation is one value, Unity's one quaternion), so rx, ry and rz are all
// default overrides of the root.
const ROOT_DEFAULTS = [`${G(1)}.EntityAttributes.name`, `${G(1)}.EntityAttributes.sortOrder`, `${G(1)}.Transform.rx`, `${G(1)}.Transform.ry`, `${G(1)}.Transform.rz`, `${G(1)}.Transform.x`];

describe('default overrides (#1831, Unity IsDefaultOverride)', () => {
  it('`overrides` lists the root\'s name, sort order, position and rotation as default overrides, and not the member\'s', async () => {
    // Mutation: drop the `e.ecsId === rootInstanceId` test — A's Transform.x is listed as one too.
    const { guid } = pInstance();
    const ov = await runAgentOp('prefab', { action: 'overrides', entityGuid: guid }) as {
      keys: { all: string[]; defaultOverrides: string[] }; effects: Record<string, unknown>;
    };
    expect([...ov.keys.defaultOverrides].sort()).toEqual(ROOT_DEFAULTS);
    expect(ov.keys.all).toEqual(expect.arrayContaining([...ROOT_DEFAULTS, `${G(2)}.Transform.x`])); // still listed
    // "What applying every key does" is Apply All's plan: the default overrides are not in it.
    expect(Object.keys(ov.effects)).toEqual([`${G(2)}.Transform.x`]);
  });

  it('Apply All (no `keys`) writes the member\'s edit and leaves every root default override out of the template', async () => {
    // Mutation: `keySet = new Set(actOn)` in the omitted branch — the template's root row takes sortOrder 1 (hunt seed
    // 7078b: every instance of P then reorders), the name, x and rx.
    const { guid } = pInstance();
    const res = await runAgentOp('prefab', { action: 'apply', entityGuid: guid }) as {
      ok: boolean; appliedKeys: string[]; defaultOverridesLeft: string[]; defaultOverridesNote: string;
    };
    expect(res.ok).toBe(true);
    expect(res.appliedKeys).toEqual([`${G(2)}.Transform.x`]);
    expect([...res.defaultOverridesLeft].sort()).toEqual(ROOT_DEFAULTS);
    expect(res.defaultOverridesNote).toMatch(/Apply All and Revert All leave them/);
    const r = templateRow(P, 1);
    expect(r.EntityAttributes!.name).toBe('R');
    expect(r.EntityAttributes!.sortOrder).toBeUndefined();
    expect(r.Transform).toMatchObject({ x: 0, rx: 0 });
    expect(templateRow(P, 2).Transform!.x).toBe(7);
  });

  it('each default override is applied when NAMED — the per-property route', async () => {
    // Mutation: filter `p.keys` through `effectiveDefaults` too — the named root keys are dropped and the template keeps 0.
    const { guid } = pInstance();
    const res = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, keys: [`${G(1)}.EntityAttributes.sortOrder`, `${G(1)}.Transform.x`] }) as {
      appliedKeys: string[]; defaultOverridesLeft?: string[];
    };
    expect([...res.appliedKeys].sort()).toEqual([`${G(1)}.EntityAttributes.sortOrder`, `${G(1)}.Transform.x`]);
    expect(res.defaultOverridesLeft).toBeUndefined(); // asked for by name: nothing was left out
    const r = templateRow(P, 1);
    expect(r.EntityAttributes!.sortOrder).toBe(1);
    expect(r.Transform!.x).toBe(5);
    expect(r.EntityAttributes!.name).toBe('R'); // not named, not written
  });

  it('Revert All (no `keys`) keeps the instance\'s placement and name, and reverts the member', async () => {
    // Mutation: `keySet = new Set(actOn)` in the omitted branch — the root snaps back to x 0, rx 0 and the name "R".
    const { guid } = pInstance();
    const res = await runAgentOp('prefab', { action: 'revert', entityGuid: guid }) as {
      newRootId: number; revertedKeys: string[]; defaultOverridesLeft: string[];
    };
    expect(res.revertedKeys).toEqual([`${G(2)}.Transform.x`]);
    expect([...res.defaultOverridesLeft].sort()).toEqual(ROOT_DEFAULTS);
    expect(read(res.newRootId, 'Transform')).toMatchObject({ x: 5, rx: 0.5 });
    expect(read(res.newRootId, 'EntityAttributes')).toMatchObject({ name: 'R copy', sortOrder: 1 });
    expect(read(byName('A'), 'Transform').x).toBe(0);
  });

  it('a NAMED default override is reverted', async () => {
    const { guid } = pInstance();
    const res = await runAgentOp('prefab', { action: 'revert', entityGuid: guid, keys: [`${G(1)}.Transform.x`] }) as { newRootId: number };
    expect(read(res.newRootId, 'Transform')).toMatchObject({ x: 0, rx: 0.5 });
  });

  // #1880 close-out review 2: rotation is ONE value (F5), so one axis selected is the whole rotation. Reverted or applied
  // alone, the two left behind re-marked it through the grouped mark store, and the override stayed. Mutation: drop the
  // rotation expansion in `toLocalIdKeys` — both cases still list a rotation override after the gesture.
  it('a Revert naming ONE rotation axis reverts the whole rotation: no rotation override is left', async () => {
    const { guid } = pInstance();
    const res = await runAgentOp('prefab', { action: 'revert', entityGuid: guid, keys: [`${G(1)}.Transform.rx`] }) as { newRootId: number };
    expect(read(res.newRootId, 'Transform')).toMatchObject({ rx: 0, ry: 0, rz: 0 });
    const ov = await runAgentOp('prefab', { action: 'overrides', entityGuid: guid }) as { keys: { all: string[] } };
    expect(ov.keys.all.filter((k) => /\.Transform\.r[xyz]$/.test(k))).toEqual([]);
  });

  it('an Apply naming ONE rotation axis writes the whole rotation to the template and leaves none on the instance', async () => {
    const { guid } = pInstance();
    const res = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, keys: [`${G(1)}.Transform.rx`] }) as { appliedKeys: string[] };
    expect(res.appliedKeys).toContain(`${G(1)}.Transform.rx`); // reported as the caller named it
    expect(templateRow(P, 1).Transform).toMatchObject({ rx: 0.5, ry: 0, rz: 0 });
    const ov = await runAgentOp('prefab', { action: 'overrides', entityGuid: guid }) as { keys: { all: string[] } };
    expect(ov.keys.all.filter((k) => /\.Transform\.r[xyz]$/.test(k))).toEqual([]);
  });

  it('an instance whose only overrides are default overrides: Apply All refuses and names them, writing nothing', async () => {
    // Mutation: drop the empty-set refusal — the Apply runs on no keys and answers "nothing was written" with no reason.
    const root = instantiatePrefab(pDoc as never, 0);
    setPrefabSource(root, { id: P });
    writeTraitField(root, getTraitByName('EntityAttributes')!, 'guid', 'g-p-root');
    edit(root, 'Transform', 'x', 5);
    await expect(runAgentOp('prefab', { action: 'apply', entityGuid: 'g-p-root' }))
      .rejects.toMatchObject({ code: 'REFUSED_BY_OP', options: [`${G(1)}.Transform.x`] });
    expect(writes).toEqual([]);
  });

  it('a UI root\'s layout rect (UIAnchor offsets and pivot, UIElement size and rotation) is a default override; its scale and a child\'s rect are not', async () => {
    // Mutation: drop the UIAnchor / UIElement entries from DEFAULT_OVERRIDE_FIELDS — the root's rect is applied.
    const root = instantiatePrefab(uDoc as never, 0);
    setPrefabSource(root, { id: U });
    writeTraitField(root, getTraitByName('EntityAttributes')!, 'guid', 'g-u-root');
    edit(root, 'UIAnchor', 'top', 12);
    edit(root, 'UIAnchor', 'pivotX', 0);
    edit(root, 'UIElement', 'width', 200);
    edit(root, 'UIElement', 'rotation', 15);
    edit(root, 'UIElement', 'scale', 2);
    edit(byName('Label'), 'UIElement', 'width', 80);
    const res = await runAgentOp('prefab', { action: 'apply', entityGuid: 'g-u-root' }) as { appliedKeys: string[]; defaultOverridesLeft: string[] };
    expect([...res.defaultOverridesLeft].sort()).toEqual([
      `${G(11)}.UIAnchor.pivotX`, `${G(11)}.UIAnchor.top`, `${G(11)}.UIElement.rotation`, `${G(11)}.UIElement.width`,
    ]);
    expect([...res.appliedKeys].sort()).toEqual([`${G(11)}.UIElement.scale`, `${G(12)}.UIElement.width`]);
    expect(templateRow(U, 1).UIElement).toMatchObject({ width: 100, rotation: 0, scale: 2 });
    expect(templateRow(U, 1).UIAnchor).toMatchObject({ top: 0, pivotX: 0.5 });
  });

  it('a root in a Hierarchy folder whose other overrides are default overrides: Apply All refuses naming them, not "nothing was written"', async () => {
    // Mutation: test the refusal on `keySet` alone — `{editorFolder}` is not empty, Apply writes nothing and throws the
    // "may have stopped being a prefab instance" guess (review #1).
    const root = instantiatePrefab(pDoc as never, 0);
    setPrefabSource(root, { id: P });
    writeTraitField(root, getTraitByName('EntityAttributes')!, 'guid', 'g-p-root');
    edit(root, 'Transform', 'x', 5);
    edit(root, 'EntityAttributes', 'editorFolder', 'Enemies');
    await expect(runAgentOp('prefab', { action: 'apply', entityGuid: 'g-p-root' }))
      .rejects.toMatchObject({ code: 'REFUSED_BY_OP', message: expect.stringMatching(/only applicable overrides are its root's default overrides/) });
    expect(writes).toEqual([]);
    // Revert can act on the folder: it does, and leaves x.
    const rv = await runAgentOp('prefab', { action: 'revert', entityGuid: 'g-p-root' }) as { newRootId: number; revertedKeys: string[] };
    expect(rv.revertedKeys).toEqual([`${G(1)}.EntityAttributes.editorFolder`]);
    expect(read(rv.newRootId, 'Transform').x).toBe(5);
  });

  it('a nested instance\'s root placement is a default override against its OWN prefab, and not against the one that contains it', async () => {
    // Unity: "the position is not a default override if applying to A, but is if applying to B" (GetApplyTargets).
    const orId = instantiatePrefab(oDoc as never, 0);
    setPrefabSource(orId, { id: O });
    const nRoot = byName('R');
    writeTraitField(nRoot, getTraitByName('EntityAttributes')!, 'guid', 'g-n-root');
    edit(nRoot, 'Transform', 'x', 4);
    // From N's own context, at its default target (P, its own prefab): left out, and named as such.
    await expect(runAgentOp('prefab', { action: 'apply', entityGuid: 'g-n-root' }))
      .rejects.toMatchObject({ code: 'REFUSED_BY_OP', message: expect.stringMatching(/default overrides/) });
    // Mutation: ignore the target in `isDefaultOverrideAt` — `target: O` is refused the same way (review #2).
    // (`overrides` from N: its plan leaves the placement out, at P.)
    const ov = await runAgentOp('prefab', { action: 'overrides', entityGuid: 'g-n-root' }) as { effects: Record<string, unknown>; defaultOverridesNote?: string };
    expect(Object.keys(ov.effects)).toEqual([]);
    expect(ov.defaultOverridesNote).toBeDefined();
    const res = await runAgentOp('prefab', { action: 'apply', entityGuid: 'g-n-root', target: O }) as { appliedKeys: string[]; defaultOverridesLeft?: string[]; written: string[] };
    expect(res.appliedKeys).toEqual([`${G(1)}.Transform.x`]);
    expect(res.defaultOverridesLeft).toBeUndefined();
    expect(res.written).toEqual([O]);
    expect(templateRow(P, 1).Transform!.x).toBe(0); // P's own root is untouched
  });

  it('a dry run of Apply All says what it left out, and a `targets` entry for a left-out key names default overrides', async () => {
    // Mutation: drop `...defaultsOut` from the dry run — it answers as if the root's edits were not there (review #4).
    const { guid } = pInstance();
    const dry = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, dryRun: true }) as { defaultOverridesLeft: string[] };
    expect([...dry.defaultOverridesLeft].sort()).toEqual(ROOT_DEFAULTS);
    // A key given its own `targets` entry is named: it is applied, at the target given.
    const named = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, targets: { [`${G(1)}.Transform.x`]: P } }) as { appliedKeys: string[] };
    expect(named.appliedKeys).toContain(`${G(1)}.Transform.x`);
    expect(templateRow(P, 1).Transform!.x).toBe(5);
  });

  it('`targets` is Apply\'s alone: a revert handed it still leaves the root\'s placement (second review #1)', async () => {
    // Mutation: build `namedInTargets` for revert too — the root snaps back to x 0.
    const { guid } = pInstance();
    const res = await runAgentOp('prefab', { action: 'revert', entityGuid: guid, targets: { [`${G(1)}.Transform.x`]: P } }) as { newRootId: number; defaultOverridesLeft: string[] };
    expect(read(res.newRootId, 'Transform').x).toBe(5);
    expect(res.defaultOverridesLeft).toContain(`${G(1)}.Transform.x`);
  });

  it('a stray `targets` key is refused as stray, without a default-overrides note it has nothing to do with', async () => {
    // Mutation: append DEFAULT_OVERRIDES_NOTE to the stray refusal again (second review #5).
    const { guid } = pInstance();
    const err = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, targets: { 'nope.Transform.x': P } }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/names 1 key\(s\) this apply does not act on/);
    expect((err as Error).message).not.toMatch(/default overrides/);
  });
});
