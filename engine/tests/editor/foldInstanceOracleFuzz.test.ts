/** The #2007 oracle over the fuzzer's saved scenes (#2001 S2): for every verify seed of the prefab fuzzer
 *  (`prefabFuzz.test.ts`), the scene the run left on disk is reloaded through the editor's own load
 *  (`loadSceneReporting`, the SceneManager path) and each top-level instance's live tree is compared with
 *  `foldInstance(parse(entry))` over the run's prefab files — `foldOracle.ts`. The corpus is thin where the fuzzer's
 *  fixture is dense: three nesting levels, a template-added node, every template channel, scene-added reference nodes. */

import { describe, it, expect, vi } from 'vitest';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, getCurrentWorld } from './prefabFuzz/harness';
import { generate, VERIFY_SEEDS, VERIFY_LEN } from './prefabFuzz/ops';
import { runOps } from './prefabFuzz/runner';
import { loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { getTraitByName, setRunMode } from '@modoki/engine/runtime';
import type { SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import type { PrefabDoc, PrefabReader } from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import { checkInstance, seen } from './foldOracle';
import { fileForms, FILE_FORMS, type FileForm } from './prefabFuzz/fileForms';
import { parseInstanceRecord } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { getCachedPrefab } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { writeFileSync, rmSync } from 'node:fs';

// The backend's trash route must not reach Finder (#2033): every fuzz delete would go to the real Trash with its sound,
// and Finder's `.DS_Store` in the scratch tree failed the run as an outside write, which once supplied rule D (below).
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

/** The fuzzer's verify seeds and length (`prefabFuzz.test.ts`), and two more (#2009's generator, 2026-10-02): 103 holds
 *  an unused row under a rule-B placeholder on both sides (kept rows were compared there while the fold's were skipped),
 *  and 235 is the only seed of 1-300 that reaches translation D once #2009's op kinds changed every seed's list. */
const SEEDS = [...VERIFY_SEEDS, 103, 235];
const LEN = VERIFY_LEN;
/** The oracle needs the run's saved files; the fuzzer judges the run's checks, so every one is tolerated here. A failure
 *  `tolerate` cannot waive still ends the run, and is red below (#2033). */
const OPTS = { expectedError: () => true, tolerate: () => true };

const report: Record<string, string[]> = {};
/** What the SAVED scenes' comparisons reached (#2021). `seen` also counts the fuzzer's per-step P1 inside `runOps`, which
 *  would pin a shape a run reached and then lost before its save. A HELD own link is reached only per step (seeds 1-1500
 *  leave none in a saved scene): `prefabFuzz.test.ts` pins it on #2018's repro. */
const PLACED = ['ownProjected', 'ownAtPlaceholder', 'ownInPlaceholder', 'unresolvedUnderPlaceholder', 'heldUnderPlaceholder'] as const;
/** Rule D reached on the copy-less form of a saved scene (#2033), not on a run that stopped early. */
let ruledDNoCopies = 0;
const reached = Object.fromEntries(PLACED.map((k) => [k, 0])) as Record<(typeof PLACED)[number], number>;
/** #2030: the variant scenes checked per #2025 file form (`prefabFuzz/fileForms.ts`). */
const forms = Object.fromEntries(FILE_FORMS.map((k) => [k, 0])) as Record<FileForm, number>;
/** …and the held slot nodes among them `placementDiverge` judged rather than left unjudged (a slot's placeholder is a walk). */
let slotJudged = 0;

describe('#2007 oracle: the fold is what today spawns (the fuzzer\'s saved scenes)', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      const before = new Set(be.snapshot().keys());
      const run = await runOps(be, generate(seed, LEN), OPTS);
      // The oracle reads the scene the run saved LAST. A failure `tolerate` cannot waive ends the run — before its final
      // save, the file on disk is an older one, which compared passes for coverage it is not (#2033: rule D was reached
      // only that way, through Finder's `.DS_Store` failing a trash step); after it (the end walk), the oracle is the only
      // judge of seeds 103 and 235, which the fuzzer's own verify seeds do not run.
      expect(run.failure, `seed ${seed}: the run failed${run.failure ? ` at step ${run.failure.step} (${run.failure.check})` : ''}`).toBeUndefined();
      const files = be.snapshot();
      const fresh = [...files.keys()].filter((p) => !before.has(p));
      const scenePath = fresh.find((p) => p.endsWith('.scene.json') || /\/scenes\/[^/]+\.json$/.test(p));
      expect(scenePath, `seed ${seed}: the run saved no scene (${fresh.join(', ')})`).toBeTruthy();
      const docs = new Map<string, PrefabDoc>();
      for (const p of fresh.filter((q) => q.endsWith('.prefab.json'))) {
        const doc = JSON.parse(files.get(p)!) as PrefabDoc;
        if (doc.id) docs.set(doc.id, doc);
      }
      // The documents the LOAD read: the runtime cache, which holds a parked (undone, unflushed) prefab write where disk
      // holds the older bytes (#1868). Disk is the fallback for a document the load never needed.
      const read: PrefabReader = (g) => {
        const d = (getCachedPrefab(g) as PrefabDoc | undefined) ?? docs.get(g);
        return d ? { doc: d } : { missing: true };
      };
      const scene = JSON.parse(files.get(scenePath!)!) as { entities?: SceneEntityEntry[]; embeddedPrefabs?: unknown };
      const loaded = await loadSceneReporting(scenePath!);
      expect(loaded.outcome).toBe('loaded');
      const copies = new Set(Object.keys((scene.embeddedPrefabs ?? {}) as object));
      const ea = getTraitByName('EntityAttributes')!.trait;
      const held = new Set((scene.entities ?? []).map((e) => e.guid).filter((g): g is string => !!g));
      const lines: string[] = [];
      const seen0 = { ...seen };
      const opts = { sceneVersion: (typeof (scene as { version?: unknown }).version === 'number' ? (scene as { version: number }).version : 0), sceneHadCopies: !!scene.embeddedPrefabs, held: (g: string) => held.has(g) };
      const check = (entry: SceneEntityEntry, prefix = '', withCopies = copies, parse = opts) => {
        const root = [...getCurrentWorld().entities].find((e) => (e.get(ea) as { guid?: string } | undefined)?.guid === entry.guid);
        if (!root) { lines.push(`${prefix}${entry.name}: no live root`); return; }
        for (const d of checkInstance(entry, read, root.id(), parse, withCopies)) lines.push(`${prefix}${entry.name}: ${d}`);
      };
      for (const entry of scene.entities ?? []) if (entry.prefab && entry.guid) check(entry);
      for (const k of PLACED) reached[k] += seen[k] - seen0[k];
      // Rule D (a nested reference row whose prefab is missing and the scene holds no copy of) is a file the editor wrote
      // without copies: one saved before v19 (`embeddedPrefabs` arrived then), or open elsewhere while the prefab went.
      // The run's own save writes the copies, so the same scene is judged once more without them (#2033).
      if (scene.embeddedPrefabs) {
        const bare = { ...scene, embeddedPrefabs: undefined, embeddedPrefabFrames: undefined };
        const path = scenePath!.replace(/\.json$/, '.nocopies.json');
        be.write(path, JSON.stringify(bare));
        const got = await loadSceneReporting(path);
        if (got.outcome !== 'loaded') lines.push(`no copies: the scene did not load (${got.outcome})`);
        else {
          const d0 = seen.ruledD;
          for (const entry of scene.entities ?? []) if (entry.prefab && entry.guid) check(entry, 'no copies: ', new Set(), { ...opts, sceneHadCopies: false });
          ruledDNoCopies += seen.ruledD - d0;
        }
      }
      // #2030: the same scene with each user node AT a placeholder restated in each of #2025's older file forms, loaded
      // and judged as it is (the rulings place it the same in every form).
      const variants = fileForms(scene as never, read, (entry) => [...foldInstance(read, parseInstanceRecord(entry, read, opts).record).placeholders.keys()]);
      const slot0 = seen.heldSlotAdded;
      for (const [n, v] of variants.entries()) {
        const path = scenePath!.replace(/\.json$/, `.form${n}.json`);
        be.write(path, JSON.stringify(v.scene));
        const got = await loadSceneReporting(path);
        if (got.outcome !== 'loaded') { lines.push(`${v.form}: the variant did not load (${got.outcome})`); continue; }
        check(v.scene.entities![v.entry]!, `${v.form}: `);
        forms[v.form]++;
      }
      slotJudged += seen.heldSlotAdded - slot0;
      report[`seed ${seed}`] = lines;
      expect(lines).toEqual([]);
    }, 120_000);
  }

  it('checked the fuzzer\'s structure (non-vacuity)', () => {
    if (process.env.ORACLE_OUT) writeFileSync(process.env.ORACLE_OUT, JSON.stringify({ seen, forms, report }, null, 1));
    expect(seen.instances).toBeGreaterThan(SEEDS.length);
    // Both rule translations are reached, so each is exercised rather than merely written (foldOracle.ts).
    expect(seen.ruledB).toBeGreaterThan(0);
    // Rule D on the copy-less forms (#2033): never on a run that stopped early, which the seeds now fail.
    expect(ruledDNoCopies).toBeGreaterThan(0);
    // The defaults arm checked something: a broken schema lookup would otherwise pass, checking nothing.
    expect(seen.defaults).toBeGreaterThan(0);
    // #2021: the placement check reached an own link on a projected member, AT and INSIDE a placeholder, and list and
    // held records under one.
    for (const k of PLACED) expect(reached[k], k).toBeGreaterThan(0);
    // #2030: every one of #2025's file forms was generated from a saved scene and judged.
    for (const k of FILE_FORMS) expect(forms[k], k).toBeGreaterThan(0);
    expect(slotJudged).toBeGreaterThan(0);
    // A guid stated twice is left unjudged (#1937), so a regression that states links twice would turn the check off.
    expect(seen.ownDuplicate).toBe(0);
  });
});
