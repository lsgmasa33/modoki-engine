/** #1764 — Detach aimed at a MEMBER of a prefab instance is refused on both surfaces, naming the instance root.
 *
 *  The agent `prefab detach` passed a member straight to the shared wrapper, which unpacked only that member and
 *  answered ok; the Hierarchy resolved the root and detached the whole instance. Unity's Unpack refuses a non-root
 *  (`PrefabUtility.UnpackPrefabInstance`) and greys the menu item, so both surfaces now refuse a member, with ONE text:
 *  `detachRefusal` makes the agent's refusal and the Hierarchy row's hover text. Driven through `runAgentOp` against
 *  the real op and the real wrapper; the Hierarchy's row is `detachPrefabMenuItem`, which the panel renders as is.
 *
 *  Mutation checked (each goes red here, nothing else in this file does):
 *  - `detachRefusal` answers undefined for a member → the agent case, the row case and the wrapper case.
 *  - the agent op skips its `detachRefusal` check → the two cases that read the agent's reply (the wrapper's own guard
 *    then throws a plain Error, so the reply is not the REFUSED_BY_OP naming the root).
 *  - the wrapper drops its guard → only the wrapper case.
 *  - `detachPrefabMenuItem` drops its `title` → the row case.
 *  - (close-out review) `detachRefusal` drops its live-root check → the dead-root case; drops it AND tests `rootId ==
 *    null` for `!rootId` → the unset-root case too (either check alone lets root 0 through, since entity 0 is never
 *    live); the agent names the root by `ensureGuid` again → the no-mint case; liveness read from `getAllEntities`
 *    instead of `findEntity` → the parked-root case. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, getAllEntities, getTraitByName } from '@modoki/engine/runtime';
import { markSceneSaved, clearHistory, clearDirtyAssets } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { detachRefusal, detachPrefabMenuItem, detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { ensureGuid } from '../../packages/modoki/src/editor/undo/entityRef';
import { readTraitData, findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

registerAllTraits();
registerEditorAgentOps();

const SHIP = 'aaaaaaaa-0000-4000-8000-000000001764';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (localId: number, nodeGuid: string, name: string, parentId: number) => ({
  localId, nodeGuid, name, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const ship = () => ({ id: SHIP, version: 6, name: 'Ship', rootLocalId: 1, entities: [row(1, G(1), 'Ship', 0), row(2, G(2), 'Flame', 1)] }) as unknown as PrefabFile;

const idOf = (name: string) => getAllEntities().find((e) => e.name === name)!.id;
const linked = (id: number) => readTraitData(id, getTraitByName('PrefabInstance')!) != null;

let game: TestWorld | undefined;
let root = 0;
let flame = 0;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  markSceneSaved();
  setPrefabCache(SHIP, ship());
  root = instantiatePrefab(ship());
  setPrefabSource(root, { id: SHIP });
  flame = idOf('Flame');
  expect(linked(flame)).toBe(true); // precondition: Flame is a member of the Ship instance
});
afterEach(() => {
  game?.dispose(); game = undefined;
  vi.restoreAllMocks();
});

describe('Detach aimed at a member is refused, naming the instance root (#1764)', () => {
  it('the agent op refuses a member with the reason, names the root, and detaches nothing', async () => {
    const err = await runAgentOp('prefab', { prefabAction: 'detach', entityGuid: ensureGuid(flame) }).catch((e: Error) => e) as Error & { code?: string; options?: string[] };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`prefab detach refused: ${detachRefusal(flame)!.reason} Nothing was detached.`);
    expect(err.message).toContain('"Ship"');
    expect(linked(flame)).toBe(true);
    expect(linked(root)).toBe(true);
  });

  it('the Hierarchy row on a member is greyed, and its hover text is the agent\'s refusal text', async () => {
    const item = detachPrefabMenuItem(flame, false, () => {});
    expect(item.disabled).toBe(true);
    expect(item.title).toBe(detachRefusal(flame)!.reason);
    const err = await runAgentOp('prefab', { prefabAction: 'detach', entityGuid: ensureGuid(flame) }).catch((e: Error) => e) as Error;
    expect(err.message).toBe(`prefab detach refused: ${item.title} Nothing was detached.`);
  });

  it('the shared wrapper refuses a member itself, so a caller that skips the check cannot unpack one', () => {
    expect(() => detachPrefabInstanceWithUndo(flame, 'Detach', '[test]')).toThrow(detachRefusal(flame)!.reason);
    expect(linked(flame)).toBe(true);
  });
});

describe('ACCEPT SIDE: the instance root still detaches on both surfaces (#1764)', () => {
  it('the agent op detaches the whole instance from its root', async () => {
    const reply = await runAgentOp('prefab', { prefabAction: 'detach', entityGuid: ensureGuid(root) }) as { ok: boolean; detached: number };
    expect(reply.ok).toBe(true);
    expect(reply.detached).toBe(2);
    expect(linked(root)).toBe(false);
    expect(linked(flame)).toBe(false);
  });

  it('the Hierarchy row on the root is enabled with no refusal text, and its detach unpacks the whole instance', () => {
    const item = detachPrefabMenuItem(root, false, () => detachPrefabInstanceWithUndo(root, 'Detach', '[test]'));
    expect(item.disabled).toBe(false);
    expect(item.title).toBeUndefined();
    item.onClick!();
    expect(linked(root)).toBe(false);
    expect(linked(flame)).toBe(false);
  });

  it('the panel\'s own greying still greys the root\'s row', () => {
    expect(detachPrefabMenuItem(root, true, () => {}).disabled).toBe(true);
  });
});

// Close-out review: `rootInstanceId` 0 means "unset" everywhere a root is read (a legacy trait-form entry loads that way),
// and a root that is not live names nothing to detach instead. Refused, the link could be cut on neither surface.
describe('ACCEPT SIDE: a link with no live root to name is not a member (#1764 close-out review)', () => {
  const setRoot = (id: number, rootInstanceId: number) => {
    const meta = getTraitByName('PrefabInstance')!;
    const e = findEntity(id)!;
    e.set(meta.trait, { ...(e.get(meta.trait) as Record<string, unknown>), rootInstanceId });
  };

  it('an unset root (0): no refusal, the row is enabled, and the agent detaches it', async () => {
    setRoot(flame, 0);
    expect(detachRefusal(flame)).toBeUndefined();
    expect(detachPrefabMenuItem(flame, false, () => {}).disabled).toBe(false);
    await expect(runAgentOp('prefab', { prefabAction: 'detach', entityGuid: ensureGuid(flame) })).resolves.toMatchObject({ ok: true });
    expect(linked(flame)).toBe(false);
  });

  it('a root that is not a live entity: no refusal', () => {
    setRoot(flame, 987654);
    expect(detachRefusal(flame)).toBeUndefined();
  });

  it('REJECT SIDE: a root that is live but parked (a pooled row, UIEntry.live false) still refuses its member', () => {
    const meta = getTraitByName('UIEntry')!;
    findEntity(root)!.add(meta.trait({ live: false }));
    expect(getAllEntities().some((e) => e.id === root), 'precondition: the parked root is out of getAllEntities').toBe(false);
    expect(detachRefusal(flame)?.rootId).toBe(root);
    expect(detachPrefabMenuItem(flame, false, () => {}).disabled).toBe(true);
  });
});

// Close-out review: the refusal named the root by `ensureGuid`, which MINTS a durable guid over a runtime one (#1210) — a
// reply saying "Nothing was detached" that wrote the root's EntityAttributes and dirtied the scene. It names the guid the
// root already has.
describe('the member refusal changes nothing, not even the root\'s guid (#1764 close-out review)', () => {
  it('a member of a root holding only a runtime guid is refused, and the root keeps that guid', async () => {
    const guidOf = (id: number) => getAllEntities().find((e) => e.id === id)!.guid;
    const before = guidOf(root);
    expect(before, 'precondition: a runtime guid, which ensureGuid would replace').toMatch(/^00000000-0000-0001-/);
    const err = await runAgentOp('prefab', { prefabAction: 'detach', entityGuid: guidOf(flame) }).catch((e: Error) => e) as Error & { options?: string[] };
    expect(err.message).toMatch(/^prefab detach refused: /);
    expect(guidOf(root)).toBe(before);
    expect(err.options?.[0]).toContain(before);
  });
});
