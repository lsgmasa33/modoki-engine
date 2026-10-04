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
import { fileForms, entriesAtPlaceholders, FILE_FORMS, type FileForm } from './prefabFuzz/fileForms';
import { parseInstanceRecord } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { getCachedPrefab } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The fuzzer's verify seeds and length (`prefabFuzz.test.ts`), and three more (#2009's generator, 2026-10-02): 103 holds
 *  an unused row under a rule-B placeholder on both sides (kept rows were compared there while the fold's were skipped),
 *  235 is the only seed of 1-300 that reaches translation D once #2009's op kinds changed every seed's list, and 178 holds
 *  a user-added reference node on a member under the scene's own removal of its row, which both sides keep (#2032: the
 *  pairing skipped today's kept link there while it compared the fold's `heldNode`). */
const SEEDS = [...VERIFY_SEEDS, 103, 235, 178];
const LEN = VERIFY_LEN;
/** The oracle needs the run's saved files; the fuzzer judges the run's checks, so every one is tolerated here. A failure
 *  `tolerate` cannot waive still ends the run, and is red below (#2033). */
const OPTS = { expectedError: () => true, tolerate: () => true };

const report: Record<string, string[]> = {};

/** `foldOracleFrozen.test.ts`'s fixed input for this seed (#2028): the scene the run saved, and every prefab document its
 *  load can read, as the load read it (the runtime cache's parked write over the disk bytes, #1868). */
function freezeInputs(seed: number, scene: unknown, files: Map<string, string>): void {
  const docs = new Map<string, unknown>();
  for (const [p, text] of files) {
    if (!p.endsWith('.prefab.json')) continue;
    const doc = JSON.parse(text) as { id?: string };
    if (doc.id) docs.set(doc.id, getCachedPrefab(doc.id) ?? doc);
  }
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'foldOracleFrozen');
  mkdirSync(dir, { recursive: true });
  const prefabs = [...docs.keys()].sort().map((k) => docs.get(k));
  writeFileSync(path.join(dir, `seed-${String(seed).padStart(4, '0')}.json`), `${JSON.stringify({ scene, prefabs })}\n`);
}
/** What the SAVED scenes' comparisons reached (#2021). `seen` also counts the fuzzer's per-step P1 inside `runOps`, which
 *  would pin a shape a run reached and then lost before its save. A HELD own link is reached only per step (seeds 1-1500
 *  leave none in a saved scene): `prefabFuzz.test.ts` pins it on #2018's repro. */
const PLACED = ['ownProjected', 'ownAtPlaceholder', 'ownInPlaceholder', 'unresolvedUnderPlaceholder', 'heldUnderPlaceholder'] as const;
/** Rule D reached (shown) on the copy-less form of a saved scene (#2033), not on a run that stopped early. */
let ruledDNoCopies = 0;
/** Rule B or D TRANSLATED on a loaded scene's comparison: today's side lacked a placeholder the fold has. */
let translatedOnLoad = 0;
/** Saved scenes restated in the pre-S5 form and judged (`entriesAtPlaceholders`). */
let preS5Forms = 0;
const reached = Object.fromEntries(PLACED.map((k) => [k, 0])) as Record<(typeof PLACED)[number], number>;
/** #2030: the variant scenes checked per #2025 file form (`prefabFuzz/fileForms.ts`). */
const forms = Object.fromEntries(FILE_FORMS.map((k) => [k, 0])) as Record<FileForm, number>;
/** …and the user nodes of a stored entry's legacy `added` under a missing root, judged from the entry as stored (Q3). */
let entryJudged = 0;

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
      // Every node the scene states as an entry of its own — a plain one carries its guid in EntityAttributes. S5's save
      // writes a node shown AT a placeholder as such an entry, parented to it (#2028), so it is in no record.
      const ownEntryOf = (sc: { entities?: SceneEntityEntry[] }) => {
        const own = new Set((sc.entities ?? []).map((e) => e.guid ?? (e.traits as { EntityAttributes?: { guid?: string } } | undefined)?.EntityAttributes?.guid).filter((g): g is string => !!g));
        return (g: string): boolean => own.has(g);
      };
      if (process.env.MODOKI_FOLD_ORACLE_FREEZE === '1') freezeInputs(seed, scene, files);
      const lines: string[] = [];
      const seen0 = { ...seen };
      const opts = { sceneVersion: (typeof (scene as { version?: unknown }).version === 'number' ? (scene as { version: number }).version : 0), sceneHadCopies: !!scene.embeddedPrefabs, held: (g: string) => held.has(g) };
      let ownEntry = ownEntryOf(scene);
      const check = (entry: SceneEntityEntry, prefix = '', withCopies = copies, parse = opts) => {
        const t0 = seen.ruledB + seen.ruledD;
        try { checkLoaded(entry, prefix, withCopies, parse); } finally { translatedOnLoad += seen.ruledB + seen.ruledD - t0; }
      };
      const checkLoaded = (entry: SceneEntityEntry, prefix: string, withCopies: ReadonlySet<string>, parse: typeof opts) => {
        const root = [...getCurrentWorld().entities].find((e) => (e.get(ea) as { guid?: string } | undefined)?.guid === entry.guid);
        if (!root) { lines.push(`${prefix}${entry.name}: no live root`); return; }
        for (const d of checkInstance(entry, read, root.id(), parse, withCopies, ownEntry)) lines.push(`${prefix}${entry.name}: ${d}`);
      };
      for (const entry of scene.entities ?? []) if (entry.prefab && entry.guid) check(entry);
      // The same scene as the editor wrote it before S5 (#2028, `entriesAtPlaceholders`): the user's nodes at a rule-B
      // placeholder back in the instance's record. The variants below are derived from it.
      const placeholdersOf = (entry: SceneEntityEntry) => [...foldInstance(read, parseInstanceRecord(entry, read, opts).record).placeholders.keys()];
      const pre = entriesAtPlaceholders(scene as never, read, placeholdersOf) as typeof scene | null;
      const base = pre ?? scene;
      if (pre) {
        const p = scenePath!.replace(/\.json$/, '.preS5.json');
        be.write(p, JSON.stringify(pre));
        const got = await loadSceneReporting(p);
        if (got.outcome !== 'loaded') lines.push(`pre-S5 form: the scene did not load (${got.outcome})`);
        else {
          ownEntry = ownEntryOf(pre);
          for (const entry of pre.entities ?? []) if (entry.prefab && entry.guid) check(entry, 'pre-S5 form: ');
          preS5Forms++;
        }
      }
      for (const k of PLACED) reached[k] += seen[k] - seen0[k];
      // Rule D (a nested reference row whose prefab is missing and the scene holds no copy of) is a file the editor wrote
      // without copies: one saved before v19 (`embeddedPrefabs` arrived then), or open elsewhere while the prefab went.
      // The run's own save writes the copies, so the same scene is judged once more without them (#2033).
      if (base.embeddedPrefabs) {
        const bare = { ...base, embeddedPrefabs: undefined, embeddedPrefabFrames: undefined };
        const path = scenePath!.replace(/\.json$/, '.nocopies.json');
        be.write(path, JSON.stringify(bare));
        const got = await loadSceneReporting(path);
        if (got.outcome !== 'loaded') lines.push(`no copies: the scene did not load (${got.outcome})`);
        else {
          const d0 = seen.shownD;
          for (const entry of base.entities ?? []) if (entry.prefab && entry.guid) check(entry, 'no copies: ', new Set(), { ...opts, sceneHadCopies: false });
          ruledDNoCopies += seen.shownD - d0;
        }
      }
      // #2030: the same scene with each user node AT a placeholder restated in each of #2025's older file forms, loaded
      // and judged as it is (the rulings place it the same in every form).
      const variants = fileForms(base as never, read, placeholdersOf);
      const entry0 = seen.heldEntryAdded;
      for (const [n, v] of variants.entries()) {
        const path = scenePath!.replace(/\.json$/, `.form${n}.json`);
        be.write(path, JSON.stringify(v.scene));
        const got = await loadSceneReporting(path);
        if (got.outcome !== 'loaded') { lines.push(`${v.form}: the variant did not load (${got.outcome})`); continue; }
        check(v.scene.entities![v.entry]!, `${v.form}: `);
        forms[v.form]++;
      }
      entryJudged += seen.heldEntryAdded - entry0;
      report[`seed ${seed}`] = lines;
      expect(lines).toEqual([]);
    }, 120_000);
  }

  it('checked the fuzzer\'s structure (non-vacuity)', () => {
    if (process.env.ORACLE_OUT) writeFileSync(process.env.ORACLE_OUT, JSON.stringify({ seen, forms, report }, null, 1));
    expect(seen.instances).toBeGreaterThan(SEEDS.length);
    // The load runs through realize (#2028), which shows rules B and D itself: the translations of today's side never
    // fire on a loaded scene — one that did would delete what the live side shows under a placeholder it failed to spawn, and hide
    // that. `foldOracleFrozen.test.ts` exercises them on the frozen pre-S5 side.
    // (The fuzzer's per-step P1 inside `runOps` still translates: a trashed prefab's frames stay live until a reload.)
    expect(translatedOnLoad).toBe(0);
    // Scene v20 (#2001 S6) writes no prefab copies, so no saved scene reaches rule B (a placeholder beside the scene's own
    // copy) any more; `foldOracleFrozen.test.ts` keeps it on the frozen pre-S5 inputs. Rule D is reached by every saved
    // scene directly: each is the copy-less form.
    expect(seen.shownB).toBe(0);
    expect(seen.shownD).toBeGreaterThan(0);
    // #2001 S8b: the save writes a user's node AT a placeholder where its record links it (an `own` link), not as an entity
    // of its own beside the placeholder (S5's save, whose capture of a placeholder was the record it loaded with). So no
    // saved scene needs the pre-S5 rewrite any more: the record form is judged on the saved scene itself
    // (`reached.ownAtPlaceholder` below), and a scene that wrote such a node outside its record again would count here.
    expect(preS5Forms).toBe(0);
    // The "same scene without its copies" variant (#2033) has nothing to strip from a v20 file: it never runs, and rule D
    // is judged on the saved scene itself (`shownD` above).
    expect(ruledDNoCopies).toBe(0);
    // The defaults arm checked something: a broken schema lookup would otherwise pass, checking nothing.
    expect(seen.defaults).toBeGreaterThan(0);
    // #2021: the placement check reached an own link on a projected member, AT and INSIDE a placeholder, and list and
    // held records under one.
    // Scene v20 (#2001 S6): a record under a placeholder is a ROW in the saved form, so the held LEGACY statements are
    // reached only through #2025's older file forms below (counted over the whole run, variants included).
    for (const k of PLACED) if (k !== 'heldUnderPlaceholder') expect(reached[k], k).toBeGreaterThan(0);
    expect(reached.heldUnderPlaceholder).toBe(0);
    expect(seen.heldUnderPlaceholder, 'held legacy statements under a placeholder, through the older file forms').toBeGreaterThan(0);
    // #2030: #2025's file forms generated from a saved scene and judged. From S5 a nested rule-B placeholder shows from the
    // first reload, where before the copy's live member stood and took the node: these seeds' S5 runs save a node only at
    // a ROOT placeholder (measured), so only the root forms are reached here. Every form, the slot ones included, is
    // judged on the frozen pre-S5 saves (`foldOracleFrozen.test.ts`).
    for (const k of ['v16RootAdded', 'v17RootOwn'] as const) expect(forms[k], k).toBeGreaterThan(0);
    // Scene v20 (#2001 S6): an entry states no root localId (no `PrefabInstance` trait), and the legacy entry-level `added`
    // names its anchor by that localId (none is guessed, rule 5) — so the form cannot be derived from a v20 save. It is
    // judged on the frozen pre-S5 saves, which state the localId (`foldOracleFrozen.test.ts` asks every form be reached).
    expect(forms.legacyRootAdded).toBe(0);
    expect(entryJudged, 'entry-level legacy added is judged only through that form').toBe(0);
    // A guid stated twice is left unjudged (#1937), so a regression that states links twice would turn the check off.
    expect(seen.ownDuplicate).toBe(0);
  });
});
