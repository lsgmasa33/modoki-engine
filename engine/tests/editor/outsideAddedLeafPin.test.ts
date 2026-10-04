/** #2148 (work-ai's #2001 S9 hunts, seeds 3128 / 3253): an outside edit adds a leaf to O, and a second one takes it out
 *  again, with no save between. The member the first adopt built had its identity pin (`guid`, `name`) only in the live
 *  tree, never in O1's record, so the second adopt's rebase — the member no longer built — wrote O1's row without it.
 *  After a save + reload the record holds the pin (the parse reads it), and the same removal keeps it: one world, two
 *  scene files, by whether a save happened between. The adopt's rebase now pins each member it builds
 *  (`pinBuiltMembers`, as an Apply's fan-out does since hunt seed 9457).
 *
 *  Driven through the prefab fuzzer's harness (the real backend route and watcher). Mutation: drop `pin: true` from
 *  `landAdopts`' rebase (`prefabCommit.ts`) → the no-save path's row loses `guid` and `name`. */

import { describe, it, expect, vi } from 'vitest';
import { getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, flushWatcher } from './prefabFuzz/harness';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { saveScene, loadSceneReporting, serializeScene } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const NG = '9f93137c-2cc4-4d40-8a4d-4e5836560000';
type Doc = { entities: Array<Record<string, unknown>>; rootLocalId: number; nextLocalId?: number };

describe('#2148: a member an outside edit brought in keeps its pin when another outside edit takes it out', () => {
  for (const saveBetween of [false, true]) {
    it(`${saveBetween ? 'with' : 'without'} a save + reload between: O1's row keeps guid, name and the override`, async () => {
      const f = await startRun(be, async () => {}, `2148-${saveBetween}`);
      const path = f.prefabs.O.path;
      const outside = async (fn: (doc: Doc) => void) => {
        const before = be.snapshot();
        const doc = JSON.parse(be.read(path)!) as Doc;
        fn(doc);
        be.write(path, `${JSON.stringify(doc, null, 2)}\n`);
        await flushWatcher(be, before);
        await settle();
      };
      await outside((doc) => {
        const localId = Math.max(doc.nextLocalId ?? 0, ...doc.entities.map((r) => (r.localId as number) ?? 0)) + 1;
        doc.entities.push({ localId, name: 'Pulled', nodeGuid: NG, traits: { EntityAttributes: { name: 'Pulled', parentId: doc.rootLocalId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } });
      });
      const pulled = authored().filter((e) => e.name === 'Pulled');
      expect(pulled, 'premise: O1 shows the new member').toHaveLength(1);
      const guid = pulled[0]!.guid!;
      expect(writeTraitFieldWithUndo(pulled[0]!.id, getTraitByName('Transform')!, 'x', 7)).toBeFalsy();
      await settle();
      if (saveBetween) {
        expect((await saveScene({ allowDialog: false })).saved).toBe(true);
        expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
        await settle();
      }
      await outside((doc) => { doc.entities = doc.entities.filter((r) => r.nodeGuid !== NG); });
      expect(authored().some((e) => e.name === 'Pulled'), 'premise: the member is gone').toBe(false);
      const scene = JSON.parse(JSON.stringify(await serializeScene())) as { entities: Array<{ members?: Record<string, unknown> }> };
      const rows = scene.entities.map((e) => e.members?.[`/${NG}`]).filter(Boolean);
      expect(rows, 'O1\'s row for the member, pin and override kept').toEqual([{ guid, name: 'Pulled', traits: { Transform: { x: 7 } } }]);
    });
  }
});
