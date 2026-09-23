/** #1468 Phase 2B — a prefab instance's member guids are STORED in the scene, not re-derived.
 *
 *  The whole plan in one assertion: change the template so that DERIVING would give a member a
 *  different guid, reload, and the member still answers to the guid the scene wrote down. Every
 *  stored reference into an instance survives a template edit that renumbers.
 *
 *  ⚠️ Each test that proves identity SURVIVED also runs the same case with the rows removed and
 *  asserts the guid moves. Without that control the test passes on a build that ignores `members`
 *  entirely — the derive path is deterministic, so "the guid is what I expected" is true for the
 *  wrong reason unless the expectation is one derivation cannot produce. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData, type SceneEntityEntry,
} from '@modoki/engine/runtime';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import {
  setPrefabCache, serializePrefab, tagEntityTreeAsInstance, instantiatePrefab, setPrefabSource, captureInstanceStructure, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import type { AddedEntity } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { parseMemberRowKey } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const HOLDER = 'ffffffff-0000-4000-8000-000000000001';
const ROOT = 'ffffffff-0000-4000-8000-000000000002';
const PREFAB = 'ffffffff-0000-4000-8000-00000000000f';

const ent = (id: number, name: string, parentId: number | string, guid: string) => ({
  id, traits: { EntityAttributes: { name, parentId, guid }, Transform: { x: 0, y: 0, z: 0 } },
});

/** Root with three FLAT children — flat so deleting the FIRST one renumbers the other two without
 *  taking either with it, which is what makes derivation give a different answer. */
const authored = (): SceneData => ({
  id: 'member-rows', version: 1, name: 'M', resources: [],
  entities: [
    ent(1, 'Holder', 0, HOLDER),
    ent(2, 'Root', HOLDER, ROOT),
    ent(3, 'Panel', ROOT, 'ffffffff-0000-4000-8000-000000000003'),
    ent(4, 'Label', ROOT, 'ffffffff-0000-4000-8000-000000000004'),
    ent(5, 'Badge', ROOT, 'ffffffff-0000-4000-8000-000000000005'),
  ],
} as unknown as SceneData);

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source,
        overrides, structure, undefined, nested, nestedStructure,
      );
      if (id && rootGuid) {
        const eaMeta = getTraitByName('EntityAttributes')!;
        for (const e of getCurrentWorld().entities) {
          if (e.id() !== id) continue;
          e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
}

const idOf = (name: string): number => getAllEntities().find((e) => e.name === name)!.id;
const guidOf = (name: string): string =>
  (readTraitData(idOf(name), getTraitByName('EntityAttributes')!) as { guid?: string }).guid ?? '';
const rowOf = (f: PrefabFile, name: string) => f.entities.find((e) => e.name === name)!;
const instanceEntry = (scene: { entities: unknown[] }): SceneEntityEntry =>
  (scene.entities as SceneEntityEntry[]).find((e) => !!e.prefab)!;

/** Create Prefab over `rootName`, exactly as both production callers do it: serialize, cache, tag. */
function createPrefabFrom(rootName: string, target: string): PrefabFile {
  const rootId = idOf(rootName);
  const file = serializePrefab(rootId, target)!;
  prefabs.set(target, file);
  setPrefabCache(target, file as never);
  tagEntityTreeAsInstance(rootId, target, file);
  return file;
}

/** A v5 template of Root's subtree, cached and tagged onto the live tree. */
function makeTemplate(): PrefabFile {
  const file = serializePrefab(idOf('Root'), PREFAB)!;
  prefabs.set(PREFAB, file);
  setPrefabCache(PREFAB, file as never);
  tagEntityTreeAsInstance(idOf('Root'), PREFAB, file);
  return file;
}

/** A scene holding one instance of PREFAB, as `serializeScene` writes it (so it carries the rows). */
async function placedInstance(): Promise<{ template: PrefabFile; scene: { entities: unknown[] } }> {
  await load(authored());
  const template = makeTemplate();
  await load({
    id: 's', version: 1, name: 'S', resources: [],
    entities: [{ id: 1, prefab: PREFAB, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }],
  } as unknown as SceneData);
  const scene = await serializeScene() as unknown as { entities: unknown[] };
  return { template, scene };
}

/** Re-save the template from the live instance with `name` deleted — the renumbering re-save. */
function templateWithout(name: string): PrefabFile {
  const world = getCurrentWorld();
  const doomed = [...world.entities].find((e) => e.id() === idOf(name))!;
  destroyEntity(doomed, world);
  const file = serializePrefab(idOf('Root'), PREFAB)!;
  prefabs.set(PREFAB, file);
  setPrefabCache(PREFAB, file as never);
  return file;
}

const withoutRows = (scene: { entities: unknown[] }) => {
  const copy = JSON.parse(JSON.stringify(scene)) as { entities: SceneEntityEntry[] };
  for (const e of copy.entities) delete e.members;
  return copy as unknown as SceneData;
};

beforeEach(() => { setRunMode('stopped'); prefabs.clear(); clearKeptMemberOrphans(); });
afterAll(() => { getCurrentWorld()?.destroy(); });

describe('a scene stores its prefab instances` member guids (#1468)', () => {
  it('writes one row per member, keyed by the member`s minted node identity', async () => {
    const { template, scene } = await placedInstance();
    const entry = instanceEntry(scene);
    const members = entry.members!;
    // One row per member — the root is the entry itself and gets none.
    expect(Object.keys(members).length).toBe(template.entities.length - 1);
    for (const name of ['Panel', 'Label', 'Badge']) {
      const key = `/${rowOf(template, name).nodeGuid}`;
      expect(members[key], `no row for ${name} under ${key}`).toBeDefined();
      expect(members[key].guid).toBe(guidOf(name));
      expect(members[key].name).toBe(name);
    }
    // Every key is a well-formed identity chain, so none of them is an empty or half-formed name a
    // lookup would silently miss.
    for (const key of Object.keys(members)) expect(parseMemberRowKey(key).length).toBe(1);
  });

  it('keeps a member`s guid when the template frees a localId and another member INHERITS it', async () => {
    // The measured case, not a contrived one. Deleting the template's first child frees localId 2,
    // and the next save hands it to Badge — so on reload Badge DERIVES the guid Panel used to have.
    // A dangling key can be noticed; this one names a live, plausible, wrong member. It is the whole
    // argument for minted identity (§ 3.5) and it is what the row has to survive.
    const { scene } = await placedInstance();
    const storedBadge = guidOf('Badge');
    const panelsOldGuid = guidOf('Panel');

    templateWithout('Panel');

    await load(scene as unknown as SceneData);
    expect(guidOf('Badge')).toBe(storedBadge);

    // The control, and it asserts the WRONG ANSWER rather than merely a different one: with the rows
    // stripped, Badge comes back wearing Panel's identity. If this said `not.toBe(storedBadge)` it
    // would also pass on a build where the guid merely dangled.
    await load(withoutRows(scene));
    expect(guidOf('Badge')).toBe(panelsOldGuid);
  });

  it('derives a member with no row, so a partial map is a fallback and not a wipe (R3)', async () => {
    const { template, scene } = await placedInstance();
    const storedLabel = guidOf('Label');
    const storedBadge = guidOf('Badge');
    const thinned = JSON.parse(JSON.stringify(scene)) as { entities: SceneEntityEntry[] };
    delete instanceEntry(thinned as never).members![`/${rowOf(template, 'Badge').nodeGuid}`];

    await load(thinned as unknown as SceneData);
    expect(guidOf('Label')).toBe(storedLabel);   // pinned by its row
    expect(guidOf('Badge')).toBe(storedBadge);   // derived — and unchanged, since nothing moved
  });

  it('lets a stored row BEAT a guid the template handed the member', async () => {
    // A template that authored a member guid hands every instance the same one (#1293). The row is
    // the scene's statement about ITS instance, so it wins — the same direction every other override
    // in this engine runs. Reachable only through a hand-authored or legacy document, since
    // `serializePrefab` clears member guids, which is why it is asserted rather than assumed.
    const SHARED = 'ffffffff-0000-4000-8000-0000000000aa';
    const MINE = 'ffffffff-0000-4000-8000-0000000000bb';
    const LEAF_NODE = 'ffffffff-0000-4000-8000-0000000000cc';
    const v5: PrefabFile = {
      id: PREFAB, version: 5, name: 'T', rootLocalId: 1,
      entities: [
        { localId: 1, nodeGuid: 'ffffffff-0000-4000-8000-0000000000c1', name: 'T', traits: { EntityAttributes: { name: 'T', parentId: 0, guid: '' } } },
        { localId: 2, nodeGuid: LEAF_NODE, name: 'Leaf', traits: { EntityAttributes: { name: 'Leaf', parentId: 1, guid: SHARED } } },
      ],
    };
    prefabs.set(PREFAB, v5);
    setPrefabCache(PREFAB, v5 as never);
    await load({
      id: 's', version: 1, name: 'S', resources: [],
      entities: [{ id: 1, prefab: PREFAB, guid: ROOT, members: { [`/${LEAF_NODE}`]: { guid: MINE, name: 'Leaf' } }, traits: { EntityAttributes: { name: 'T', parentId: 0 } } }],
    } as unknown as SceneData);
    expect(guidOf('Leaf')).toBe(MINE);
  });

  it('keeps a row whose template node is GONE, and says which member it was (R2)', async () => {
    const { template, scene } = await placedInstance();
    const panelKey = `/${rowOf(template, 'Panel').nodeGuid}`;
    const panelGuid = instanceEntry(scene).members![panelKey].guid;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    templateWithout('Panel');          // Panel's node guid leaves the document entirely
    await load(scene as unknown as SceneData);

    // Logged, named, once. The name can only come from the ROW — the template node that knew it is
    // gone — which is the whole argument for keeping `name` on the row.
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('name no node the template still declares'));
    expect(line).toBeDefined();
    expect(line).toContain('"Panel"');
    expect(line).toContain(panelKey);
    warn.mockRestore();

    // …and RETAINED: the next save writes the row back, so undoing the template edit restores the
    // scene's identity for that member instead of minting a fresh one.
    const resaved = await serializeScene() as unknown as { entities: unknown[] };
    expect(instanceEntry(resaved).members![panelKey]?.guid).toBe(panelGuid);
  });

  it('does not report a member the INSTANCE removed — its node is still in the template', async () => {
    // R2's silent half, and the reason orphan-detection asks the DOCUMENT and not the live world:
    // every removed member is absent from the world, so a live-world test would report a loss on
    // every load of every instance that has ever deleted a member.
    const { template, scene } = await placedInstance();
    const entry = instanceEntry(scene);
    const badgeKey = `/${rowOf(template, 'Badge').nodeGuid}`;
    const badgeGuid = entry.members![badgeKey].guid;
    const withRemoval = JSON.parse(JSON.stringify(scene)) as { entities: SceneEntityEntry[] };
    instanceEntry(withRemoval as never).removed = [rowOf(template, 'Badge').localId!];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await load(withRemoval as unknown as SceneData);
    expect(getAllEntities().some((e) => e.name === 'Badge')).toBe(false);   // really removed
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('name no node the template'))).toBe(false);
    warn.mockRestore();

    // …and its IDENTITY is dropped on the next save, which is R2's other half verbatim: "if the
    // instance's `removed[]` names it, drop silently". Un-removing it then derives a fresh guid,
    // exactly as it does today — undo is what restores the old one, by restoring the scene entry.
    // Since Phase 4 the removal itself lives on the member's row, so the row survives as exactly
    // that statement: `removed`, and no guid (the member is not live, so it has none to state).
    expect(badgeGuid).toBeTruthy(); // the fixture really had a row to drop
    const resaved = await serializeScene() as unknown as { entities: unknown[] };
    expect(instanceEntry(resaved).members![badgeKey]).toEqual({ removed: true });
    expect(instanceEntry(resaved).removed).toBeUndefined();
  });

  it('does not claim a row is lost when the template could not be READ', async () => {
    // "I cannot tell" is not "it is gone". A nested prefab that is not cached makes the document
    // walk incomplete, and without this the load reports every member inside that expansion as a
    // lost row — a loud, wrong claim caused by a cache miss, on the documents least able to afford
    // one. The rows are still KEPT, because what a cache miss changes is what we may SAY.
    const UNCACHED = 'ffffffff-0000-4000-8000-0000000000de';
    const INNER_NODE = 'ffffffff-0000-4000-8000-0000000000df';
    const v5: PrefabFile = {
      id: PREFAB, version: 5, name: 'T', rootLocalId: 1,
      entities: [
        { localId: 1, nodeGuid: 'ffffffff-0000-4000-8000-0000000000d1', name: 'T', traits: { EntityAttributes: { name: 'T', parentId: 0, guid: '' } } },
        { localId: 2, nodeGuid: 'ffffffff-0000-4000-8000-0000000000d2', name: 'Slot', prefab: UNCACHED, traits: { EntityAttributes: { name: 'Slot', parentId: 1, guid: '' } } },
      ],
    };
    prefabs.set(PREFAB, v5);          // …and deliberately NOT prefabs.set(UNCACHED, …)
    setPrefabCache(PREFAB, v5 as never);
    const KEPT = 'ffffffff-0000-4000-8000-0000000000e0';
    const key = `/${'ffffffff-0000-4000-8000-0000000000d2'}/${INNER_NODE}`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load({
      id: 's', version: 1, name: 'S', resources: [],
      entities: [{ id: 1, prefab: PREFAB, guid: ROOT, members: { [key]: { guid: KEPT, name: 'Inner' } }, traits: { EntityAttributes: { name: 'T', parentId: 0 } } }],
    } as unknown as SceneData);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('name no node the template still declares'))).toBe(false);
    warn.mockRestore();
    const resaved = await serializeScene() as unknown as { entities: unknown[] };
    expect(instanceEntry(resaved).members![key]?.guid).toBe(KEPT);
  });

  it('covers every localId a scene`s overrides can name — except the ROOT (Phase 4 finding A)', async () => {
    // The claim Phase 4 depends on: the row key space reaches every member the localId key space
    // reaches, so collapsing `overrides` onto rows loses nothing. With ONE exception, asserted here
    // rather than left to be discovered — the instance root has no row, because it IS the entry, and
    // `overrides[rootLocalId]` is the commonest override there is (any field edit on the root).
    const { template, scene } = await placedInstance();
    const members = instanceEntry(scene).members!;
    const keys = new Set(Object.keys(members));
    for (const row of template.entities) {
      const isRoot = row.localId === template.rootLocalId;
      expect(keys.has(`/${row.nodeGuid}`), `${row.name} (localId ${row.localId})`).toBe(!isRoot);
    }
    expect(template.entities.length).toBeGreaterThan(1);   // the loop really ran over members
  });

  it('keeps a promoted nested instance`s member guids, and relocates its rows (R7)', async () => {
    // R7, and a deliberate divergence from a QA-measured contract: `qa/knowledge.md`'s promotion row
    // records that promotion re-derives its members' guids. It stops needing to: the rows state them.
    //
    // ⚠️ Its own fixture, because the promoted prefab must HAVE members — a first version promoted
    // a leaf and asserted on the promoted ROOT, which keeps its guid under every reading, so both
    // halves of this rule mutated green. The member is what the rule is about.
    const CHILD = 'ffffffff-0000-4000-8000-0000000000f1';
    await load({
      id: 'r7', version: 1, name: 'R', resources: [],
      entities: [
        ent(1, 'Holder', 0, HOLDER),
        ent(2, 'Root', HOLDER, ROOT),
        ent(3, 'Badge', ROOT, 'ffffffff-0000-4000-8000-0000000000f8'),
        ent(4, 'Pip', 'ffffffff-0000-4000-8000-0000000000f8', 'ffffffff-0000-4000-8000-0000000000f9'),
      ],
    } as unknown as SceneData);
    const child = createPrefabFrom('Badge', CHILD);   // Badge → an instance of CHILD, with Pip inside
    const outer = createPrefabFrom('Root', PREFAB);   // …and a nested reference row of PREFAB
    await load({
      id: 's', version: 1, name: 'S', resources: [],
      entities: [{ id: 1, prefab: PREFAB, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }],
    } as unknown as SceneData);
    const nestedRow = outer.entities.find((e) => e.prefab === CHILD)!;
    const pipNode = child.entities.find((e) => e.name === 'Pip')!.nodeGuid!;
    const before = guidOf('Pip');
    expect(before).toBeTruthy();

    const { promoteOwnedRoots } = await import('../../packages/modoki/src/runtime/core/ecs/memberHome');
    promoteOwnedRoots([idOf('Badge')]);

    // The MEMBER keeps its guid — that is the rule. (The root keeps its under every reading.)
    expect(guidOf('Pip')).toBe(before);

    // …and the rows relocate: out of the outer entry's members, into the reference node the promoted
    // instance is now captured as, re-keyed to its OWN frame (no outer-row prefix).
    const scene = await serializeScene() as unknown as { entities: unknown[] };
    const entry = instanceEntry(scene);
    expect(Object.keys(entry.members ?? {})).not.toContain(`/${nestedRow.nodeGuid}/${pipNode}`);
    const ref = (entry.added ?? []).find((n) => n.prefab === CHILD);
    expect(ref, 'the promoted instance is captured as a reference node').toBeDefined();
    expect(ref!.members?.[`/${pipNode}`]?.guid).toBe(before);
  });

  it('never writes member rows into a prefab TEMPLATE, only into a scene', async () => {
    // A reference node is captured for both documents. In a TEMPLATE the guids would be handed to
    // every instance of that prefab at once, which is #1293 — so the capture is gated on the same
    // `template` flag the rest of it uses, and this is the assertion that the gate is not decorative.
    const CHILD = 'ffffffff-0000-4000-8000-0000000000e1';
    await load({
      id: 'tpl', version: 1, name: 'T', resources: [],
      entities: [
        ent(1, 'Holder', 0, HOLDER),
        ent(2, 'Root', HOLDER, ROOT),
        ent(3, 'Panel', ROOT, 'ffffffff-0000-4000-8000-0000000000e8'),
        ent(4, 'Spare', HOLDER, 'ffffffff-0000-4000-8000-0000000000e9'),
        ent(5, 'SpareKid', 'ffffffff-0000-4000-8000-0000000000e9', 'ffffffff-0000-4000-8000-0000000000ea'),
      ],
    } as unknown as SceneData);
    const childFile = createPrefabFrom('Spare', CHILD);
    const rootFile = createPrefabFrom('Root', PREFAB);
    // Drag an instance of CHILD under a member: a USER-ADDED nested instance, which both captures
    // treat as a reference node.
    const dragged = instantiatePrefab(childFile, idOf('Panel'));
    setPrefabSource(dragged!, CHILD);   // the caller's job, as the nested-row path does it
    // …and the derive pass the editor's own instantiate paths run, which is what gives the fresh
    // members guids to store. Without it they have none and there is nothing to capture.
    const { deriveInstanceMemberGuids } = await import('../../packages/modoki/src/runtime/loaders/loadSceneFile');
    deriveInstanceMemberGuids(getCurrentWorld());

    const asScene = captureInstanceStructure(idOf('Root'), rootFile, {});
    const asTemplate = captureInstanceStructure(idOf('Root'), rootFile, { template: true });
    const refIn = (s: { added: AddedEntity[] }) => s.added.find((n) => n.prefab === CHILD);
    expect(refIn(asScene), 'fixture: the dragged-in instance is captured as a reference node').toBeDefined();
    expect(refIn(asScene)!.members).toBeDefined();
    expect(refIn(asTemplate)!.members).toBeUndefined();

    // ⚠️ The OTHER converter, and the one the first version of this test missed. `toTemplateNodes` is
    // where a scene capture becomes a prefab row — Apply-to-Prefab routes through it, not through
    // `captureInstanceStructure({template:true}) ` — and its `{ ...n }` spread carried `members`
    // straight into the template until the Phase 2B close-out review found it. Two converters, one
    // invariant, so both are asserted here.
    const { toTemplateNodesForTest } = await import('../../packages/modoki/src/editor/scene/prefab');
    // ⚠️ `moved` is the OTHER per-instance field the spread carried — `Record<localId, live parent
    // GUID>`, which names nothing in a template's own space. `captureInstanceStructure` already
    // refuses to write one into a template, and this converter was the way one got in anyway.
    const sceneNode = { ...refIn(asScene)!, moved: { 2: guidOf('Panel') } };
    const promoted = toTemplateNodesForTest([sceneNode])!;
    expect(promoted[0].prefab).toBe(CHILD);        // fixture: it really is the reference node
    expect(promoted[0].members).toBeUndefined();
    expect(sceneNode.moved, 'fixture: the scene form really carried a move').toBeDefined();
    expect(promoted[0].moved).toBeUndefined();
  });

  it('drops a pin that collides with a guid another member DERIVES, and says so', async () => {
    // The uniqueness guard. The derived set is internally collision-free (one hash per anchor+path),
    // so a collision can only be a PIN meeting a derivation — reachable with nothing corrupt: a row
    // pins a member to the guid it had at an earlier path, the template moves it, and whatever now
    // occupies the old path derives that guid. Two entities, one address: #1355's shape.
    //
    // The PIN yields, never the derived member: an un-pinned member falls back to derivation, where
    // it was before v16; a de-derived member would have no guid at all.
    const { template, scene } = await placedInstance();
    const labelsGuid = guidOf('Label');
    const collided = JSON.parse(JSON.stringify(scene)) as { entities: SceneEntityEntry[] };
    const members = instanceEntry(collided as never).members!;
    // ⚠️ Label's row is REMOVED, so Label derives and only BADGE is pinned. Leaving both rows in
    // place pins both members to the same guid, both pins are equally suspect, and both are dropped
    // — a correct outcome that cannot show which side yields, which is the rule being tested.
    delete members[`/${rowOf(template, 'Label').nodeGuid}`];
    members[`/${rowOf(template, 'Badge').nodeGuid}`] = { guid: labelsGuid, name: 'Badge' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await load(collided as unknown as SceneData);

    expect(guidOf('Label')).toBe(labelsGuid);          // the DERIVED member keeps the address
    expect(guidOf('Badge')).not.toBe(labelsGuid);      // the PIN was dropped
    expect(guidOf('Badge')).toBeTruthy();              // …and it derived one instead, not nothing
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('also holds'));
    expect(line).toBeDefined();
    expect(line).toContain('"Badge"');
    warn.mockRestore();
  });

  it('keeps key AND guid when the member is re-parented inside its instance (R1)', async () => {
    // R1: the storage key is the member's identity, the matching key is its path. A move inside the
    // instance changes the path and must change neither the key nor the stored guid — that is what
    // made `homeParent`/`homeSteps` retirable (deleted in Phase 6).
    const { template, scene } = await placedInstance();
    const badgeKey = `/${rowOf(template, 'Badge').nodeGuid}`;
    const before = instanceEntry(scene).members![badgeKey].guid;

    const eaMeta = getTraitByName('EntityAttributes')!;
    for (const e of getCurrentWorld().entities) {
      if (e.id() === idOf('Badge')) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), parentId: idOf('Label') });
    }
    const moved = await serializeScene() as unknown as { entities: unknown[] };
    expect(instanceEntry(moved).members![badgeKey]?.guid).toBe(before);
  });

  it('keeps a member`s guid when the TEMPLATE re-parents its row (R4)', async () => {
    // R4: under D1(a) a template re-parent is not a reconciliation case at all — the key is
    // position-independent, so nothing re-keys. The DERIVED guid does move (the path changes), which
    // is exactly what the row is there to absorb.
    const { template, scene } = await placedInstance();
    const stored = guidOf('Badge');
    const badgeKey = `/${rowOf(template, 'Badge').nodeGuid}`;

    // Re-parent the row in the TEMPLATE by re-parenting the live member and re-saving the prefab.
    const eaMeta = getTraitByName('EntityAttributes')!;
    for (const e of getCurrentWorld().entities) {
      if (e.id() === idOf('Badge')) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), parentId: idOf('Label') });
    }
    const second = serializePrefab(idOf('Root'), PREFAB)!;
    prefabs.set(PREFAB, second);
    setPrefabCache(PREFAB, second as never);
    expect(rowOf(second, 'Badge').nodeGuid).toBe(rowOf(template, 'Badge').nodeGuid);   // nothing re-keyed

    await load(scene as unknown as SceneData);
    expect(instanceEntry(scene).members![badgeKey].guid).toBe(stored);   // fixture premise
    expect(guidOf('Badge')).toBe(stored);

    // The control: with the row stripped, the re-parent moves the derived guid.
    await load(withoutRows(scene));
    expect(guidOf('Badge')).not.toBe(stored);
  });

  it('an UNEDITED member`s row carries only its identity — every channel is a diff', async () => {
    // Until Phase 4 this was "writes ONLY identity", guarding D2(b)'s reserved slots against being
    // filled before anything read them. Phase 4 wired all four (`traits`, `removedTraits`, `removed`,
    // `added`) and `parent` was wired in Phase 3, so what is left to pin is the diff rule: a member
    // the instance did not touch states nothing but who it is — no empty `added: []`, no
    // `removed: false`, which in a nested frame would each be a real statement
    // (`foldMemberRowChannels`). The edited cases are `sceneMemberRowWriter.test.ts`.
    const { scene } = await placedInstance();
    const rows = Object.values(instanceEntry(scene).members!);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['guid', 'name']);
    }
  });

  it('drops pins to a FIXPOINT — one pass can create the collision it is fixing', async () => {
    // Raised as PLAUSIBLE by the Phase 2B close-out review, which could not build this fixture. It
    // takes TWO pins in one instance, arranged so the re-derive that repairs the first collision
    // hands a member the guid the second pin is holding:
    //
    //   row(Badge) pins D3 — which Label DERIVES  → collision, Badge's pin drops, Badge derives D4
    //   row(Panel) pins D4 — nobody held D4 at scan time, so nothing was dropped there
    //   → without a second pass, Panel and Badge both answer to D4, silently
    const { template, scene } = await placedInstance();
    await load(withoutRows(scene));
    const [d2, d3, d4] = [guidOf('Panel'), guidOf('Label'), guidOf('Badge')];
    expect(new Set([d2, d3, d4]).size).toBe(3);   // fixture: the derived set really is distinct

    const cascade = JSON.parse(JSON.stringify(scene)) as { entities: SceneEntityEntry[] };
    instanceEntry(cascade as never).members = {
      [`/${rowOf(template, 'Badge').nodeGuid}`]: { guid: d3, name: 'Badge' },
      [`/${rowOf(template, 'Panel').nodeGuid}`]: { guid: d4, name: 'Panel' },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load(cascade as unknown as SceneData);
    warn.mockRestore();

    // Every member addressable, and no two sharing an address — which is the invariant, not the
    // particular assignment.
    const guids = ['Panel', 'Label', 'Badge'].map(guidOf);
    expect(guids.every((g) => !!g)).toBe(true);
    expect(new Set(guids).size).toBe(3);
  });

  it('writes no rows for a pre-v5 template, which minted no identities', async () => {
    const v4: PrefabFile = {
      id: PREFAB, version: 4, name: 'Old', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'Old', traits: { EntityAttributes: { name: 'Old', parentId: 0, guid: '' } } },
        { localId: 2, name: 'Leaf', traits: { EntityAttributes: { name: 'Leaf', parentId: 1, guid: '' } } },
      ],
    };
    prefabs.set(PREFAB, v4);
    setPrefabCache(PREFAB, v4 as never);
    await load({
      id: 's', version: 1, name: 'S', resources: [],
      entities: [{ id: 1, prefab: PREFAB, guid: ROOT, traits: { EntityAttributes: { name: 'Old', parentId: 0 } } }],
    } as unknown as SceneData);
    const scene = await serializeScene() as unknown as { entities: unknown[] };
    expect(instanceEntry(scene).members).toBeUndefined();
    expect(guidOf('Leaf')).not.toBe('');   // …and the member still derives one, exactly as before
  });
});
