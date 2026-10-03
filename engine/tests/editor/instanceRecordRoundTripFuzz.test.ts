/** #2008 P2 over the fuzzer's saved scenes (#2001 S3): for every verify seed of the prefab fuzzer (`prefabFuzz.test.ts`),
 *  every instance in the scene the run left on disk, and every reference row of every prefab it left, round-trips through
 *  the writer and the parser as the corpus does (`instanceRecordRoundTrip.test.ts`). The fuzzer reaches what the corpus
 *  does not: three nesting levels, a missing prefab (legacy channels held verbatim, in both forms), template-added nodes.
 *  A scene-added REFERENCE node is carried as its parsed content, not converted: its v20 form is S6's adapter. */

import { describe, it, expect, vi } from 'vitest';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage } from './prefabFuzz/harness';
import { generate, VERIFY_SEEDS, VERIFY_LEN } from './prefabFuzz/ops';
import { runOps } from './prefabFuzz/runner';
import { setRunMode } from '@modoki/engine/runtime';
import { parseTemplateLists } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import type { PrefabDoc, PrefabReader } from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import type { SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { asData, ownAsLinked, roundTripEntry, roundTripTemplateRow, toV10Docs } from './instanceRecordRoundTrip';
import { rmSync } from 'node:fs';
// The OS trash, stubbed as in `prefabFuzz.test.ts`: without it every fuzz delete runs Finder's `delete` on the scratch
// directory, which plays the system trash sound and fills the machine's real Trash. Every user of `makeFuzzBackend` needs it.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));

setRunMode('stopped');
const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** The round-trip needs the run's saved files, not its verdict: the fuzzer itself judges the run. */
const OPTS = { expectedError: () => true, tolerate: () => true };

const seen = { instances: 0, scenePending: 0, templateLists: 0, templatePending: 0, converted: 0 };

describe('#2008 P2: serialize and parse are inverse over the fuzzer\'s saved scenes', () => {
  for (const seed of VERIFY_SEEDS) {
    it(`seed ${seed}`, async () => {
      await runOps(be, generate(seed, VERIFY_LEN), OPTS);
      const files = be.snapshot();
      const docs = new Map<string, PrefabDoc>();
      for (const [p, bytes] of files) {
        if (!p.endsWith('.prefab.json')) continue;
        const doc = JSON.parse(bytes) as PrefabDoc;
        if (doc.id) docs.set(doc.id, doc);
      }
      const read: PrefabReader = (g) => (docs.has(g) ? { doc: docs.get(g)! } : { missing: true });
      const v10 = toV10Docs(docs, read, seen);
      const readV10: PrefabReader = (g) => (v10.has(g) ? { doc: v10.get(g)! } : { missing: true });
      const scenePath = [...files.keys()].find((p) => p.endsWith('.scene.json') || /\/scenes\/[^/]+\.json$/.test(p));
      expect(scenePath, `seed ${seed}: the run saved no scene`).toBeTruthy();
      const file = JSON.parse(files.get(scenePath!)!) as { entities?: SceneEntityEntry[]; version?: number };
      const entries = file.entities ?? [];
      const held = new Set(entries.map((e) => e.guid).filter((g): g is string => !!g));
      for (const entry of entries) {
        if (!entry.prefab) continue;
        const { first, second, bytes1, bytes2 } = roundTripEntry(entry, read, { sceneVersion: file.version ?? 0, held: (g) => held.has(g) });
        expect(asData(second.record), `${entry.name}: parse(serialize(rec)) ≡ rec`).toEqual(asData(first.record));
        expect(ownAsLinked(second.ownContent), `${entry.name}: own content`).toEqual(ownAsLinked(first.ownContent));
        expect(bytes2, `${entry.name}: a second save writes the same bytes`).toBe(bytes1);
        const fold = asData(foldInstance(read, first.record));
        expect(asData(foldInstance(read, second.record)), `${entry.name}: the same instance`).toEqual(fold);
        expect(asData(foldInstance(readV10, second.record)), `${entry.name}: the same instance from v10 documents`).toEqual(fold);
        seen.instances++;
        // Scene v20 (#2001 S6): a missing prefab's entry holds ROWS (no legacy channel is written), so the class is the
        // missing instance itself; the legacy `pendingLegacy` form is `instanceRecordRoundTrip.test.ts`'s.
        if ('missing' in read(entry.prefab)) seen.scenePending++;
      }
      for (const [guid, doc] of docs) {
        for (const [lid, { list }] of parseTemplateLists(doc, guid, read).rows) {
          const row = doc.entities.find((r) => r.localId === lid)!;
          const { again, bytes1, bytes2 } = roundTripTemplateRow(row, list, read);
          expect(asData(again), `prefab ${guid} row ${lid}: parse(serialize(list)) ≡ list`).toEqual(asData(list));
          expect(bytes2, `prefab ${guid} row ${lid}: same bytes`).toBe(bytes1);
          seen.templateLists++;
          if (list.held?.pendingLegacy && row.prefab && 'missing' in read(row.prefab)) seen.templatePending++;
        }
      }
    }, 120_000);
  }

  it('reached the fuzzer\'s structure (non-vacuity, per class)', () => {
    expect(seen.instances).toBeGreaterThan(VERIFY_SEEDS.length);
    expect(seen.templateLists).toBeGreaterThan(VERIFY_SEEDS.length);
    expect(seen.scenePending, 'a scene instance whose prefab is missing').toBeGreaterThan(0);
    expect(seen.templatePending, 'a reference row whose nested prefab is missing (template pendingLegacy)').toBeGreaterThan(0);
    expect(seen.converted, 'a reference row the v10 fold read in converted form').toBeGreaterThan(0);
  });
});
