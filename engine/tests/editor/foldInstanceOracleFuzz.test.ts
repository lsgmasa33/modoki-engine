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
import { getCachedPrefab } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { writeFileSync } from 'node:fs';

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
/** The oracle needs the run's saved files, not its verdict: the fuzzer itself judges the run. */
const OPTS = { expectedError: () => true, tolerate: () => true };

const report: Record<string, string[]> = {};

describe('#2007 oracle: the fold is what today spawns (the fuzzer\'s saved scenes)', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      const before = new Set(be.snapshot().keys());
      await runOps(be, generate(seed, LEN), OPTS);
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
      for (const entry of scene.entities ?? []) {
        if (!entry.prefab || !entry.guid) continue;
        const root = [...getCurrentWorld().entities].find((e) => (e.get(ea) as { guid?: string } | undefined)?.guid === entry.guid);
        if (!root) { lines.push(`${entry.name}: no live root`); continue; }
        for (const d of checkInstance(entry, read, root.id(), { sceneVersion: (typeof (scene as { version?: unknown }).version === 'number' ? (scene as { version: number }).version : 0), sceneHadCopies: !!scene.embeddedPrefabs, held: (g) => held.has(g) }, copies)) lines.push(`${entry.name}: ${d}`);
      }
      report[`seed ${seed}`] = lines;
      expect(lines).toEqual([]);
    }, 120_000);
  }

  it('checked the fuzzer\'s structure (non-vacuity)', () => {
    if (process.env.ORACLE_OUT) writeFileSync(process.env.ORACLE_OUT, JSON.stringify({ seen, report }, null, 1));
    expect(seen.instances).toBeGreaterThan(SEEDS.length);
    // Both rule translations are reached, so each is exercised rather than merely written (foldOracle.ts).
    expect(seen.ruledB).toBeGreaterThan(0);
    expect(seen.ruledD).toBeGreaterThan(0);
    // The defaults arm checked something: a broken schema lookup would otherwise pass, checking nothing.
    expect(seen.defaults).toBeGreaterThan(0);
  });
});
