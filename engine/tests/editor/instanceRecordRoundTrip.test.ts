/** #2008 P2 (#2001 S3): the writer and the parser are inverse over every real instance.
 *
 *  For each instance in the corpus (`games/`, `demos/`), whatever form its file states:
 *  - `parse(serialize(parse(old))) ≡ parse(old)`, the record compared as data (design § 3.5, P2);
 *  - `serialize` of that is the same bytes again (load → save is a fixed point from v20 on, rule 4);
 *  - `fold(parse(old)) ≡ fold(parse(serialize(parse(old))))`, the instance the record describes (#2008);
 *  - the same fold against every prefab document rewritten as v10 (`toV10Docs`), so the chain reads the writer's rows.
 *  The same holds for every prefab document's reference rows, in template form.
 *
 *  What the corpus does NOT reach (no held value of any kind, no template-added node, no move, no document-level
 *  `moved`) is proved over hand-built inputs in `instanceRecordRoundTripFixtures.test.ts`. A scene-added REFERENCE node
 *  is carried here as its parsed content, not converted: its v20 form is S6's adapter (`SerializeContext.sceneOwned`). */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';
import { parseTemplateLists } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import type { PrefabDoc, PrefabReader } from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import type { SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { asData, ownAsLinked, roundTripEntry, roundTripTemplateRow, toV10Docs } from './instanceRecordRoundTrip';

const corpus = repoFiles({
  under: ['games', 'demos'], match: (rel: string) => /\/runtime\/assets\/.*\.(scene|prefab)\.json$/.test(rel),
  exclude: ['node_modules', 'dist', 'ios', 'android', 'build'], floor: 0,
}) as Array<{ rel: string; abs: string }>;
const projectOf = (rel: string) => rel.split('/').slice(0, 2).join('/');
const readJson = (abs: string) => JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
const projects = [...new Set(corpus.map((f) => projectOf(f.rel)))].map((id) => {
  const files = corpus.filter((f) => projectOf(f.rel) === id);
  const docs = new Map<string, PrefabDoc>();
  for (const f of files.filter((x) => x.rel.endsWith('.prefab.json'))) {
    const doc = readJson(f.abs) as unknown as PrefabDoc;
    if (doc.id) docs.set(doc.id, doc);
  }
  return { id, docs, scenes: files.filter((f) => f.rel.endsWith('.scene.json') && /"prefab":\s*"/.test(readFileSync(f.abs, 'utf8'))) };
});

const seen = { instances: 0, rows: 0, ownNodes: 0, templateLists: 0, converted: 0 };

describe.skipIf(!hasInternalGames())('#2008 P2: serialize and parse are inverse over the corpus', () => {
  for (const project of projects) {
    const read: PrefabReader = (g) => (project.docs.has(g) ? { doc: project.docs.get(g)! } : { missing: true });
    let v10: Map<string, PrefabDoc> | undefined;
    const readV10: PrefabReader = (g) => {
      v10 ??= toV10Docs(project.docs, read, seen);
      return v10.has(g) ? { doc: v10.get(g)! } : { missing: true };
    };

    for (const scene of project.scenes) {
      it(scene.rel, () => {
        const entries = ((readJson(scene.abs).entities ?? []) as SceneEntityEntry[]);
        const idToGuid = new Map(entries.map((e) => [e.id, e.guid] as const));
        const held = new Set(entries.map((e) => e.guid).filter((g): g is string => !!g));
        const opts = {
          parentGuid: (r: unknown) => (typeof r === 'number' ? idToGuid.get(r) ?? '' : typeof r === 'string' ? r : ''),
          held: (g: string) => held.has(g),
        };
        for (const entry of entries) {
          if (!entry.prefab) continue;
          const { first, second, bytes1, bytes2 } = roundTripEntry(entry, read, opts);
          expect(asData(second.record), `${entry.name}: parse(serialize(rec)) ≡ rec`).toEqual(asData(first.record));
          expect(ownAsLinked(second.ownContent), `${entry.name}: own content`).toEqual(ownAsLinked(first.ownContent));
          expect(bytes2, `${entry.name}: a second save writes the same bytes`).toBe(bytes1);
          const fold = asData(foldInstance(read, first.record));
          expect(asData(foldInstance(read, second.record)), `${entry.name}: the same instance`).toEqual(fold);
          expect(asData(foldInstance(readV10, second.record)), `${entry.name}: the same instance from v10 documents`).toEqual(fold);
          seen.instances++;
          seen.rows += first.record.list.rows.size;
          seen.ownNodes += first.ownContent.size;
        }
      });
    }

    for (const [guid, doc] of project.docs) {
      if (!doc.entities?.some((r) => r?.prefab)) continue;
      it(`${project.id} prefab ${guid}: template lists`, () => {
        for (const [lid, { list }] of parseTemplateLists(doc, guid, read).rows) {
          const { again, bytes1, bytes2 } = roundTripTemplateRow(doc.entities.find((r) => r.localId === lid)!, list, read);
          expect(asData(again), `row ${lid}: parse(serialize(list)) ≡ list`).toEqual(asData(list));
          expect(bytes2, `row ${lid}: same bytes`).toBe(bytes1);
          seen.templateLists++;
        }
      });
    }
  }

  it('reached the corpus (non-vacuity)', () => {
    expect(seen.instances).toBeGreaterThan(20);
    expect(seen.rows).toBeGreaterThan(20);
    expect(seen.ownNodes, 'a scene-owned added node').toBeGreaterThan(0);
    expect(seen.templateLists).toBeGreaterThan(20);
    expect(seen.converted, 'a reference row the v10 fold read in converted form').toBeGreaterThan(0);
  });
});
