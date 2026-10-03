/** #1789 — the prefab randomized round-trip test: seeded op sequences through the editor's real entry points, the
 *  model's invariants after every step, save→reload and undo identities, and shrinking repros.
 *
 *  Each run starts from #1707's fixture (three-deep nesting through every channel a template row carries) in a scene,
 *  then runs a seeded list of ops (`prefabFuzz/ops.ts`): create prefab (and Replace), instantiate (and nest), detach,
 *  duplicate, copy/cut/paste, delete, field edits, add/remove component, add child, reparent, Apply (all, a component,
 *  a key; the default or another target), Revert, prefab edit (open, inner ops, save or discard, exit), undo/redo, save
 *  → reload, trash/rename a prefab file, and an outside edit of one. And (#2009) the agent's doors — `set-traits`,
 *  `prefab instantiate`, `/api/scene-mutate` live and file-direct (no renderer) — Play → edits → Stop, and a timeline
 *  scrub (an activation pose, a posed Transform, an agent edit the posed world must refuse) left by its exit or by Stop.
 *  After every step: I4, I5, I6, I7, I8, I15, I16,
 *  I18 and both validators (`prefabFuzz/checks.ts`); every save→reload is the identity and a second save is
 *  byte-identical; the run ends with a save→reload, then undo to the segment's start (the bytes it began with), then
 *  redo to the end. Any console.error the EXPECTED_ERRORS list does not name fails the step.
 *
 *  Modes:
 *  - `npm run verify`: VERIFY_SEEDS, fixed, a few seconds.
 *  - `MODOKI_PREFAB_FUZZ=<n>` (optional `MODOKI_PREFAB_FUZZ_SEED=<first>`, `MODOKI_PREFAB_FUZZ_LEN=<ops>`): n seeds, for
 *    long hunts. Every distinct failure is shrunk and printed with its seed and a paste-ready replay.
 *  - `MODOKI_PREFAB_FUZZ_REPLAY='<json op list>'`: run exactly that list.
 *  - `MODOKI_PREFAB_FUZZ_RUN_TAG=<hex>`: with a replay, the run tag to use (a REGRESSIONS entry's `runTag`, #1946).
 *
 *  REAL, not stood in for: the backend router over a scratch directory (`prefabFuzz/backend.ts`), SceneManager's load,
 *  both prefab caches, the manifest, the undo stack, the adoption owner, prefab edit's world swaps, and the watcher's
 *  scene-changed handler (`initAgentBridge` over a stubbed Electron bridge).
 *
 *  HARNESS-BLIND (what this cannot find, and why):
 *  - The file watcher is simulated: after each op the harness diffs the directory and raises `scene-changed` for every
 *    change the router did not mark as the editor's own (`flushWatcher`). The host's 150 ms debounce, its TTL on a
 *    mark, and events that arrive DURING an op are not modelled, so an op interleaved with a watcher reload is not.
 *  - Nothing runs concurrently: each op is awaited to quiescence before the next. I11's windows (an Apply racing a
 *    reload, #1750) need an interleaving this never produces.
 *  - The React components are not mounted. Each op calls what the component calls (named in `ops.ts`), with modals
 *    answered: a Replace asked or declined by the seed, a scene move and a discard confirmed.
 *  - One scene, no base scenes: cross-scene cut/paste and I14 are not reached (follow-up on #1789).
 *  - Play and a timeline preview are entered (#2009), headlessly: no frame is stepped, so no game system runs in Play,
 *    and the preview poses through `previewTimelineAt` with an inline activation track, not a timeline asset or an
 *    Animator. Transient subtrees (I12) are still never made.
 *  - Models, textures and the skin rig are absent: #1782's positional rebuilders are not reached.
 *  - The OS trash is stubbed to a plain delete (`moveToTrash`), so a trash the OS refuses part-way is not reached.
 *  - Override marks are compared only on instance members: a mark left on a detached (plain) entity has no reader.
 *  - A mark on a component the entity no longer has is not compared either, nor one on a blank asset ref ('' — the
 *    writer drops blank refs, so no file can hold it; re-check this if #1717 folds marks into the override listing).
 *  - Undo is held to the prefab files' documents, not their bytes, for `nextLocalId` and `version`: a restore raises the
 *    mark in place by design (#1774).
 *  - A missing-prefab placeholder is compared by its source across a reload, not by its in-memory record's form (entry
 *    or node follows its position); a lost record still shows as a second save that differs.
 *
 *  - A tainted segment's walk (after an outside edit, a prefab-edit save, or a swap that expanded a placeholder: the
 *    closed `TaintCause` list, #1845) forgives every refusal, so a write whose #1774 mark-conflict recovery fails there is
 *    not caught; only a clean segment holds it. A watcher raise no outside edit made fails the step instead of tainting,
 *    and the checks each taint skipped are counted and printed.
 *  - The renderer's manifest is pushed by a route's inline rebuild, before its renderer repair, as the host's is (#1835),
 *    and by the simulated watcher — but ADDITIVELY, where the host's prunes: a deleted prefab's guid stays resolvable
 *    here. Pruning surfaces #1844. `failManifestRebuilds` reproduces a failed inline rebuild, the editor's one lag window.
 *  - A deleted prefab's round trip is judged with it RESTORED as well as plainly (#1805, `saveReload`): a run fails only
 *    when neither holds. A loss the live world itself cannot show — a row a swap left unexpanded — needs a regression
 *    repro (#1812's), not the identity.
 *  - A run's paths and guids come from a 32-bit hash of its op list (plus its occurrence count): two lists can collide in
 *    one process (~N²/2³³ for N lists, including a shrink's replays), sharing a run folder while the caches are not reset.
 *
 *  REACH, measured by putting fixed bugs back on the generator before #2009's six op kinds changed every seed's list (so
 *  not a claim about today's seeds; docs/prefabs.md § "The randomized round-trip test" has the table): #1756,
 *  #1446 and #1709 fail inside the verify seeds; #1774, #1751 F1 and #1737 only in a 150-seed hunt (#1751 F1 only
 *  through apply's directed move-then-Apply branch, which was ADDED to reach the member-paths route #1751 F1 lives on);
 *  #1777 is not re-found (reusing a number needs a hand edit below the mark, or #1782's rebuilders); #1741 is
 *  unreachable (one scene). The weights were not tuned against these; the generator changes are in the doc. */

import { reserveLocalId, clearReservedLocalIds } from '../../packages/modoki/src/runtime/core/localIdCounter';
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';

// The OS trash, stubbed to delete from the scratch directory as `deleteAssetPreconditions.test.ts` does: the route's
// own preconditions and bookkeeping still run, but nothing reaches the machine's real Trash.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend, ROOT_URL } from './prefabFuzz/backend';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import type { SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { boot, bridge, memoryStorage, flushWatcher, editorOwns, authored, piOf } from './prefabFuzz/harness';
import { generate, describe as describeOp, type Op, VERIFY_SEEDS, VERIFY_LEN } from './prefabFuzz/ops';
import { projectFromStore, s5Seen } from './prefabFuzz/s5Seams';
import { s4Seams, s4Seen, DOOR_OPS } from './prefabFuzz/s4Seams';
import { installShadow } from './prefabFuzz/shadow';
import { foldCheck, runOps, shrink, consoleErrors, opOutcomes, taintCounts, skippedChecks, checksRun, handEditedPaths, carryTracker, diffFiles, rebaseForFileOp, trashedPrefabReferenced, newlySwallowed, firstUntoleratedDiff, type RunResult, type StepFailure } from './prefabFuzz/runner';
import { KNOWN_OPEN, REGRESSIONS, type KnownOpen, type Reach } from './prefabFuzz/knownOpen';
import { seen } from './foldOracle';
import { writeFileSync } from 'node:fs';
import { signature, checkRoundTrip, firstDiff, nodeMoved, checkMarks, recordKeys, RULING_R } from './prefabFuzz/checks';
import { newGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { fingerprintBytes, EDITOR_DELETE_FINGERPRINT, createEditorWriteGuard } from '../../plugins/editorWriteGuard';
import { setRunMode, getTraitByName, writeTraitField } from '@modoki/engine/runtime';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);
// #2014 (S4): the real store, capture and doors behind the #2009 shadow harness — I25 and the store's coverage run after
// every op from here on (`prefabFuzz/s4Seams.ts`).
// #2028 (S5): P1 — every record projected from the store after every op, compared with its live instance
// (`prefabFuzz/s5Seams.ts`).
installShadow({ ...s4Seams, project: projectFromStore });

/** console.error lines that are the editor TELLING the user something expected, each with why it is expected. A bare
 *  pattern is not allowed: every entry names the issue or the rule behind it. */
const EXPECTED_ERRORS: { pattern: RegExp; after?: RegExp; why: string }[] = [
  {
    pattern: /^\[Prefab\] refusing to save — nesting .* creates a cycle/,
    why: 'I16: a prefab-edit save that would make a template contain itself is refused by its owner (wouldCreateCycle), '
      + 'which says so on the console; the fuzzer reaches it by dropping an enclosing prefab into the one being edited',
  },
  {
    pattern: /^\[undo\] (Undo|Redo) of "(Apply to Prefab|Save prefab "[^"]*")" was REFUSED — \S+\.prefab\.json changed since this step/,
    why: 'I10, asked of memory since #1868: an Apply\'s or a Replace\'s undo and redo restore the prefab in memory only while '
      + 'the editor holds the document the other half left, and refuse once a prefab-edit save or an outside edit changed it '
      + '(#1664, #1679, the park landing\'s precondition in `commitPrefabChanges`). A refusal in a segment nothing outside the '
      + 'stack touched still fails, as '
      + '"undo refused in a clean segment"',
  },
  {
    pattern: /^\[undo\] (Undo|Redo) of "(Apply to Prefab|Save prefab "[^"]*")" was REFUSED — .* was deleted since this step, so it was left deleted/,
    why: '#1877 C1: an Apply\'s or a Replace\'s undo and redo refuse, rather than resurrect, a prefab an Assets trash deleted '
      + 'since the step (Unity brings no deleted asset back through an undo). The trash taints the segment (`assetDelete`), so '
      + 'the refusal is forgiven only there',
  },
  {
    pattern: /^\[undo\] Undo of "Save prefab "[^"]*"" was REFUSED — "Save prefab "[^"]*"" was not undone: \d+ of the prefab links? it puts back names? \S+\.prefab\.json, which was deleted since, so nothing was changed/,
    why: '#1880 W5 (#1881, seed 1012): Create Prefab\'s undo asks `requireLinks` BEFORE it changes the tree, and refuses when '
      + 'a link it puts back would be lost — its entity went with a prefab an Assets trash deleted since. It half-applied '
      + 'and counted the miss afterwards. The trash taints the segment (`assetDelete`), so the refusal is forgiven only there',
  },
  {
    pattern: /^\[undo\] (Undo|Redo) of "(Apply to Prefab|Save prefab "[^"]*")" was REFUSED — \S+\.prefab\.json would contain itself once restored/,
    why: '#1877 C1, I16 at the restore: a prefab-edit save made the other prefab nest this one since the step, so putting this '
      + 'one back would make it contain itself. The save taints the segment (`prefabEditSave`)',
  },
  {
    pattern: /^\[PrefabEdit\] cannot save ".*" — serialize produced no prefab/,
    after: /^\[Prefab\] refusing to save — nesting .* creates a cycle/,
    why: 'the same I16 refusal as reported by the prefab-edit save — allowed only right after the cycle line above',
  },
  {
    pattern: /^\[undo\] (Undo|Redo) of "Save prefab "[^"]*"" was REFUSED — \S+\.prefab\.json is not what this step left there/,
    why: 'I10/#1679: both halves of Create Prefab change the file only while it holds what the other half left, so they '
      + 'refuse after a prefab-edit save or an outside edit of it. A refusal in a segment nothing outside the stack touched '
      + 'still fails, as "undo/redo refused in a clean segment" (that is how #1821 is caught)',
  },
  {
    pattern: /^\[undo\] Undo of "Save prefab "[^"]*"" was REFUSED — "[^"]*"( \([^)]*\))? was rebuilt from a changed \S+\.prefab\.json since/,
    why: '#1795 route 1: Create Prefab\'s undo writes no file, so it asks the TREE — it refuses once a prefab-edit save or an '
      + 'outside edit rebuilt the instance from a changed document (`createdFrameRebuiltRefusal`), since unlinking it would '
      + 'keep that change in the scene. The same design as the file refusal above, in the wording b5aa811e3 gave it (hunt '
      + 'seeds 6001 6053 6070 6103 6138). A refusal in a segment nothing outside the stack touched still fails, as "undo '
      + 'refused in a clean segment"',
  },
  {
    pattern: /^\[PrefabEdit\] cannot save "[^"]*" — "[^"]*" (references|is a pasted reference to) the prefab [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}, which is missing or has no root, so this save cannot write it/,
    why: '#1738 (owner ruling: refuse with a reason rather than write a node the save cannot place): a prefab-edit save '
      + 'refuses while the edit holds an added reference node whose prefab is missing (`prefabEdit.ts`), since the '
      + 'template capture would drop it and its edits silently. The fuzzer reaches it by trashing a prefab the edited one '
      + 'nests (win hunt seed 6136: instantiate, Create Prefab, trash, a saved prefab edit). Only a GUID is forgiven: the '
      + 'message names the prefab by `resolveRef(source) ?? source`, so a prefab the manifest still resolves prints a PATH, '
      + 'and a refusal of one would be an expansion bug that nothing else catches (a refused save is only a trace note, '
      + 'not a check, and no taint), so it must fail here (close-out review)',
  },
  {
    pattern: new RegExp(String.raw`^\[undo\] (Undo|Redo) of ".*" was REFUSED — "[^"]*"( \([^)]*\))? (${RULING_R})`),
    why: 'owner ruling R (#1819, #1827, #1793, 2026-09-29): an undo or redo whose target no longer resolves, or has become '
      + 'a Missing Prefab placeholder, refuses before any change and is dropped (`require`, entityRef.ts), and says so. A '
      + 'refusal in a segment where no placeholder was expanded and nothing outside the stack touched still fails, as '
      + '"undo/redo refused in a clean segment"',
  },
  {
    // Every sub's reason must be one of the ruling's (the alternation above); one other reason fails the line.
    pattern: new RegExp(String.raw`^\[undo\] (Undo|Redo) of ".*" was REFUSED — every sub-action refused during (undo|redo): `
      + String.raw`"[^"]*": "[^"]*"( \([^)]*\))? (${RULING_R})[^|]*( \| "[^"]*": "[^"]*"( \([^)]*\))? (${RULING_R})[^|]*)* The entry was dropped`),
    why: 'the same ruling, for an AGENT call\'s one undo entry (#2009): `set-traits` and `apply-scene-ops` wrap their writes '
      + 'in a composite (`runAsCompositeAction`), whose undo refuses as a whole when EVERY sub refused (#1823) and prints '
      + 'each sub\'s reason. The fuzzer reaches it once an outside edit or a trash takes away an entity an agent edited '
      + '(hunt seeds 1036, 1042, 1142). A composite that half-applied is NOT this line: it is a CompositeStepError, and fails',
  },
  {
    pattern: /^\[undo\] (Undo|Redo) of ".*" was REFUSED — The prefab instance \(\S+\) a deleted member belongs to is no longer in the scene/,
    why: 'the same ruling, for a delete\'s undo whose members\' instance root is gone (`requireRootLinks`)',
  },
  {
    pattern: /^\[entityActions\] refused: "[^"]*" is a Missing Prefab now/,
    why: '#1818 (I21): an edit the placeholder\'s save would drop is refused where it is made (`placeholderWriteRefusal`), '
      + 'and says so; the op reports "refused"',
  },
  {
    pattern: /^\[Prefab\] \S+\.prefab\.json holds a localId high-water mark of \d+, and this write would lower it to \d+\. Refusing/,
    why: '#1774 (04bc35008): the ROUTE logs its mark refusal, and the commit treats it as a conflict it re-reads past '
      + '(prefabCommit writeDoc: sameDocument ignores the mark) and lands. The fuzzer hears it only because the router runs '
      + 'in its process. In a CLEAN segment a write that does not recover still fails the step (a refusal, a throw, or a '
      + 'file mismatch). In a tainted one the walk forgives refusals, so a broken recovery there is not caught (review: '
      + 'measured, only the end walk hits this line) — see HARNESS-BLIND',
  },
  {
    pattern: /^\[undo\] Redo of "Save prefab .*" was REFUSED — ".*" no longer describes the tree it was made from:/,
    why: '#1820: Create Prefab\'s undo rebased the re-linked tree onto its template\'s changed document (a saved prefab edit '
      + 'since the create), so the redo refuses rather than re-link it to rows that no longer describe it, in shape or value',
  },
  {
    pattern: /^\[undo\] Undo of "Delete (Entity|\d+ Entities)" was REFUSED — "[^"]*" \(\S+\) is no longer where its prefab puts it: a prefab edit saved since the delete removed its row/,
    why: '#1820 residual: Delete\'s undo translates the rows of a frame that survived the delete onto that frame\'s current '
      + 'document, and refuses before anything respawns when a saved prefab edit dropped a row it would bring back (or that '
      + 'row\'s parent) — a member the prefab no longer has (`survivingFrameRows`). A refusal in a segment nothing outside '
      + 'the stack touched still fails, as "undo refused in a clean segment"',
  },
  {
    pattern: /^\[undo\] Redo of "Instantiate "[^"]*"" did not fully apply — the prefab could not be instantiated — its file was most likely deleted since the undo\. No instance was created\./,
    why: '#308: an Instantiate\'s redo after its prefab was trashed (not undoable, #1868 owner ruling D2) creates nothing and '
      + 'says why, by design (`prefabInstantiateUndo.ts`), instead of reporting a silent success (hunt seed 7293). '
      + '⚠️ The editor prints this text for ANY null respawn, so an Instantiate redo failing with its file present would be '
      + 'forgiven too (#1831 review, not observed): the allowlist matches lines, not causes',
  },
];

const realError = console.error;
vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')); });
for (const k of ['log', 'warn', 'info', 'debug'] as const) vi.spyOn(console, k).mockImplementation(() => {});
const expectedError = (m: string, prev?: string) => EXPECTED_ERRORS.some((e) => e.pattern.test(m) && (!e.after || (prev !== undefined && e.after.test(prev))));


/** Hunts and REGRESSIONS tolerate what a KNOWN_OPEN entry tolerates; the self-test runs STRICT, so an entry whose repro
 *  stops reproducing goes red there. */
const OPTS = { expectedError, tolerate: (f: { check: string; detail: string }) => KNOWN_OPEN.some((k) => k.tolerates?.(f)) };
const STRICT = { expectedError };

/** Every KNOWN_OPEN entry whose `stops` predicate claims this failure; an entry without one claims nothing. A predicate
 *  sees only the ops that ran up to the failing step: judged on the whole list, an op AFTER the failure satisfied an
 *  op-shape clause (review). `list` is the harness self-tests' seam: they plant fixture entries, so the matcher is checked
 *  while KNOWN_OPEN is empty — iterating an empty list, they passed checking nothing. */
const claimsOf = (f: StepFailure, ops: readonly Op[], list: readonly KnownOpen[] = KNOWN_OPEN) => list.filter((k) => k.stops?.(f, ops.slice(0, f.step + 1)));
/** The first entry that claims this failure, if any: what verify, the hunt and a replay stop at. */
const knownStop = (f: StepFailure, ops: readonly Op[], list: readonly KnownOpen[] = KNOWN_OPEN): KnownOpen | undefined => claimsOf(f, ops, list)[0];

/** Every tally the hunt prints: taints and the checks they skipped (#1845), op outcomes, backend routes. */
const tallies = (): Map<string, number>[] => [taintCounts, skippedChecks, opOutcomes, be.routeCounts, checksRun];

/** Run `fn` with every tally left as it found it. The shrinker replays a failing seed dozens of times through the same
 *  runner, so without this a hunt that finds more failures reports more taints (and ops, and routes) for that reason
 *  alone, and two platforms' hunts stop being comparable, which is the tallies' whole job (win's Windows hunt). */
async function uncounted<T>(fn: () => Promise<T>): Promise<T> {
  const saved = tallies().map((m) => new Map(m));
  try { return await fn(); } finally {
    tallies().forEach((m, i) => { m.clear(); for (const [k, n] of saved[i]!) m.set(k, n); });
  }
}

async function shrunk(seed: number | string, ops: Op[], r: RunResult): Promise<{ text: string; min: Op[]; minFailure?: StepFailure }> {
  const f = r.failure!;
  const sig = signature(f);
  const { min, replays, final } = await uncounted(async () => {
    const s = await shrink(be, ops, sig, OPTS);
    return { min: s.ops, replays: s.replays, final: await runOps(be, s.ops, OPTS) };
  });
  const text = [
    `seed ${seed}: ${f.check} at step ${f.step} (${f.op})`,
    `  ${f.detail}`,
    `  signature: ${sig}`,
    `  minimized to ${min.length} op(s) in ${replays} replays: ${min.map(describeOp).join(' ; ')}`,
    `  minimized fails as: ${final.failure ? `${final.failure.check} — ${final.failure.detail}` : 'PASS (shrink slid)'}`,
    `  trace: ${final.trace.join(' || ')}`,
    `  replay: MODOKI_PREFAB_FUZZ_REPLAY='${JSON.stringify(min)}'`,
  ].join('\n');
  return { text, min, minFailure: final.failure };
}

async function report(seed: number | string, ops: Op[], r: RunResult): Promise<string> {
  return (await shrunk(seed, ops, r)).text;
}

describe('#1789 prefab fuzz', () => {
  const replay = process.env.MODOKI_PREFAB_FUZZ_REPLAY;
  const hunt = Number(process.env.MODOKI_PREFAB_FUZZ ?? 0);

  if (replay) {
    it('replays the given op list', async () => {
      const ops = JSON.parse(replay) as Op[];
      // `MODOKI_PREFAB_FUZZ_RUN_TAG=<hex>`: the run tag to replay under (an entry's `runTag`; re-pinning one, #1946).
      const tag = process.env.MODOKI_PREFAB_FUZZ_RUN_TAG;
      const r = await runOps(be, ops, tag ? { ...OPTS, runTag: parseInt(tag, 16) } : OPTS);
      realError(r.trace.join('\n'));
      // Which open issue already claims this failure, as the hunt would say it (triage; the verdict is unchanged).
      const known = r.failure ? knownStop(r.failure, ops) : undefined;
      if (known) realError(`replay: stopped at KNOWN_OPEN #${known.issue} (${known.what})`);
      expect(r.failure, r.failure ? `${r.failure.check}: ${r.failure.detail}` : '').toBeUndefined();
    }, 600_000);
    return;
  }

  if (hunt > 0) {
    it(`hunts ${hunt} seeds`, async () => {
      const first = Number(process.env.MODOKI_PREFAB_FUZZ_SEED ?? 1000);
      const len = Number(process.env.MODOKI_PREFAB_FUZZ_LEN ?? 40);
      const bySig = new Map<string, string>();
      for (let s = first; s < first + hunt; s++) {
        const ops = generate(s, len);
        const r = await runOps(be, ops, OPTS);
        if (!r.failure) continue;
        const known = knownStop(r.failure, ops);
        if (known) { realError(`seed ${s}: stopped at KNOWN_OPEN #${known.issue} (step ${r.failure.step})`); continue; }
        const sig = signature(r.failure);
        if (bySig.has(sig)) continue;
        // Hunt mode only (verify judges the seed's own failure): a stop keyed on the op that exposes a route, or on op
        // order, often cannot see it in a 40-op list, but can in the list the shrinker reduces it to with the SAME
        // signature — that seed is a known route, reported as such rather than as a finding.
        // The stop must claim the shrunk list's failure AND this seed's own failure judged against the shrunk op shape: the
        // content keys (touched guids, the console) are the original run's, so a shrink that slid onto another node of
        // the same signature is not attributed (review).
        const s1 = await shrunk(s, ops, r);
        const later = s1.minFailure && signature(s1.minFailure) === sig ? knownStop(s1.minFailure, s1.min) : undefined;
        if (later && later.stops?.(r.failure, s1.min.slice(0, s1.minFailure!.step + 1))) {
          realError(`seed ${s}: claimed after shrinking by KNOWN_OPEN #${later.issue} (${sig})\n  replay: MODOKI_PREFAB_FUZZ_REPLAY='${JSON.stringify(s1.min)}'`);
          continue;
        }
        bySig.set(sig, s1.text);
        realError(`\n${s1.text}\n`);
      }
      const tally = (m: Map<string, number>) => [...m].sort().map(([k, n]) => `${k} ${n}`).join(', ');
      // On stderr beside the taints: `realError` is not shown by every reporter, and a hunt must show what it covered.
      process.stderr.write(`coverage — ops: ${tally(opOutcomes)}\nroutes: ${tally(be.routeCounts)}\nchecks run: ${tally(checksRun)}\n`);
      // Per cause (#1845), for comparing one platform's hunt with another's: a platform whose taints or skips run far
      // above another's on the same seeds is turning the undo checks off for a reason the other does not have.
      process.stderr.write(`taints (ops that tainted a segment, by cause): ${tally(taintCounts) || 'none'}\nchecks skipped by a taint (<cause>: <check>): ${tally(skippedChecks) || 'none'}\n`);
      expect([...bySig.values()]).toEqual([]);
    }, 24 * 3600_000);
    return;
  }

  for (const seed of VERIFY_SEEDS) {
    it(`seed ${seed}: every invariant holds after every step`, async () => {
      const ops = generate(seed, VERIFY_LEN);
      const r = await runOps(be, ops, OPTS);
      // A seed that reaches a known open bug passes at that step: everything before it was checked.
      if (!r.failure || knownStop(r.failure, ops)) return;
      expect(await report(seed, ops, r)).toBe('');
    }, 120_000);
  }

  // #2014 (S4): I25 must JUDGE records, not merely run — a shadow that skips everything (every record stale, missing or
  // unresolved) passes vacuously. After the verify seeds, every door op has been judged and records were compared.
  it('#2014 I25: the shadow judged records after every door op (non-vacuity)', () => {
    expect(checksRun.get('I25 compared a record') ?? 0).toBeGreaterThan(50);
    for (const k of DOOR_OPS) expect(checksRun.get(`I25 compared after ${k}`) ?? 0, `I25 compared a record after ${k}`).toBeGreaterThan(0);
  });

  // #2028 (S5): P1 must COMPARE projections, not merely run — a seam that skips every record passes vacuously — and a
  // scene-added reference node's list must have come from the store at least once, not only from the capture.
  it('#2028 P1: records were projected from the store and compared with their live instances (non-vacuity)', () => {
    expect(checksRun.get('P1') ?? 0).toBeGreaterThan(50);
    expect(s5Seen.nestedWithOwner).toBeGreaterThan(0);
  });

  // #1845: what the taints turned off, said on every verify run, so a platform where it grows is visible. A report, not a
  // test: the cause list is closed by its type, and the guard is the "unexpected outside write" self-test below.
  afterAll(() => {
    const tally = (m: Map<string, number>) => [...m].sort().map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    process.stderr.write(`[prefabFuzz] verify run — taints: ${tally(taintCounts)}; checks skipped: ${tally(skippedChecks)}; #1880 checks run: ${tally(checksRun)}\n`);
    process.stderr.write(`[prefabFuzz] I25 translations (#2014): ${JSON.stringify(s4Seen)}\n`);
  });

  // Hub ruling (a), 2026-10-02 (#1831, hunt seed 7078a): a scene reference node at an unresolved placeholder owns its
  // record and is live, though its owner's fold does not anchor it (its link is held). P1 by the fold must COMPARE it:
  // a live member of it broken without a mark is reported, under its own guid. Mutation: skip an unanchored node in
  // `foldCheck` (runner.ts) — QR is never parsed, and the break goes unseen.
  it('#2014: P1 by the fold compares a reference node whose link is held at an unresolved placeholder (hub (a), 7078a)', async () => {
    const r = REGRESSIONS.find((x) => x.what.includes('hunt seed 7078a'))!;
    const res = await runOps(be, r.repro, OPTS);
    expect(res.failure, res.failure ? `${res.failure.check}: ${res.failure.detail}` : '').toBeUndefined();
    const all = authored();
    const hr = all.find((e) => e.name === 'HR')!;
    const qr = all.find((e) => e.name === 'QR' && e.parentId === hr?.id && piOf(e.id)?.rootInstanceId === e.id)!;
    expect(qr, 'the repro still makes QR').toBeDefined();
    const member = authored().find((e) => e.id !== qr.id && piOf(e.id)?.rootInstanceId === qr.id && !!e.traits?.includes?.('Transform'))
      ?? authored().find((e) => e.id !== qr.id && piOf(e.id)?.rootInstanceId === qr.id)!;
    writeTraitField(member.id, getTraitByName('Transform')!, 'x', 123.5);
    const fails = foldCheck(be, await serializeScene() as Parameters<typeof foldCheck>[1]);
    expect(fails.some((f) => f.detail.startsWith(qr.guid!)), JSON.stringify(fails).slice(0, 300)).toBe(true);
  }, 60_000);

  // #1933 K1: an entry must still REACH its case (`Reach`, knownOpen.ts), not just pass. Its op's outcome is read off the
  // trace, and the checks its run skipped off the skip tally's growth.
  const reachDump = process.env.MODOKI_PREFAB_FUZZ_REACH_DUMP;
  const measured: Array<{ issue: number; what: string; reaches: Reach }> = [];
  for (const r of REGRESSIONS) {
    it(`regression #${r.issue}: ${r.what}`, async () => {
      const before = new Map(skippedChecks);
      const res = await runOps(be, r.repro, r.runTag === undefined ? OPTS : { ...OPTS, runTag: r.runTag });
      expect(res.failure, res.failure ? `${res.failure.check}: ${res.failure.detail}` : '').toBeUndefined();
      const skips = [...skippedChecks].filter(([k, n]) => n > (before.get(k) ?? 0)).map(([k]) => k).sort();
      const outcomeOf = (i: number) => res.trace.map((l) => /^(\d+): .*? → (\w+)/.exec(l)).find((m) => m && Number(m[1]) === i)?.[2];
      if (reachDump) {
        const op = r.reaches.op;
        measured.push({ issue: r.issue, what: r.what.slice(0, 80), reaches: { op, outcome: outcomeOf(op) as Reach['outcome'], ...(skips.length ? { skips } : {}) } });
        return;
      }
      expect(outcomeOf(r.reaches.op), `op ${r.reaches.op} of the repro no longer ends ${r.reaches.outcome}: the entry may not reach its case`).toBe(r.reaches.outcome);
      expect(skips.filter((k) => !(r.reaches.skips ?? []).includes(k)), 'a taint now skips a check this entry may rely on').toEqual([]);
    }, 60_000);
  }
  afterAll(() => { if (reachDump) writeFileSync(reachDump, JSON.stringify(measured, null, 1)); });

  // #1880 F3a's "1127 + an undo of its Apply comes back once" fuzz test retired with F6 (2026-09-30): the outermost-entry
  // rebuild renumbers the entry's runtime ids, the fuzz ops pick their targets in id order, and 1127's list diverges at
  // its 19th pick (one `u` slot serves two picks there, so it cannot be re-aimed). The case is stated without ids in
  // nestedRowFieldSave.test.ts ("hunt seed 1127's shape").

  // #1835: the one real window the renderer's manifest has — a route whose inline rebuild THROWS replies
  // `manifestRebuilt: false`, and the move lands before any push. #1828's drop redo must still tag by the document's guid
  // there (setPrefabSource takes the document). Mutation: tag from the path through the manifest again — this goes red.
  it('regression #1828: with the inline manifest rebuild failing, the drop redo after a Rename still tags by guid', async () => {
    const repro = REGRESSIONS.find((r) => r.issue === 1828)!.repro;
    be.failManifestRebuilds = true;
    try {
      const res = await runOps(be, repro, OPTS);
      expect(res.failure, res.failure ? `${res.failure.check}: ${res.failure.detail}` : '').toBeUndefined();
    } finally { be.failManifestRebuilds = false; }
  }, 60_000);

  for (const k of KNOWN_OPEN) {
    it(`KNOWN_OPEN #${k.issue} still reproduces — remove its entry once it is fixed (${k.what})`, async () => {
      // Strict, except for what ANOTHER entry tolerates, as verify does: one issue's shapes can lie on one route (#1939:
      // the expanded-entry and copy-carry repros pass a node placeholder first), and a tolerated issue's on another's
      // (#2013's double-booked orphan row lies on #2010's route). Never a failure this entry reproduces.
      const siblings = KNOWN_OPEN.filter((o) => o !== k && o.tolerates);
      const tolerate = (f: StepFailure) => !k.reproduces(f) && siblings.some((o) => o.tolerates!(f));
      const r = await runOps(be, k.repro, siblings.length ? { ...STRICT, tolerate: (f) => tolerate({ ...f, step: -1, op: '' }) } : STRICT);
      expect(r.failure, `#${k.issue} no longer reproduces: if it is fixed, delete its KNOWN_OPEN entry`).toBeDefined();
      expect(k.reproduces(r.failure!), `#${k.issue}'s repro now fails differently: ${r.failure!.check} — ${r.failure!.detail}`).toBe(true);
      if (k.stops) expect(knownStop(r.failure!, k.repro)?.issue, `#${k.issue}'s stop predicate does not claim its own repro`).toBe(k.issue);
      // The reject side: no OTHER issue's entry claims this failure — each predicate is one mechanism's, not a family's
      // (a second route of one issue is its own entry, with its own repro).
      const others = claimsOf(r.failure!, k.repro).filter((o) => o.issue !== k.issue).map((o) => o.issue);
      expect(others, `#${k.issue}'s repro is also claimed by ${others.join(', ')}`).toEqual([]);
    }, 60_000);
  }

  // #1840: the watcher looked marks up by a string it built from the url, which on Windows never matched the route's
  // `\`-separated path, so every editor write reloaded under the op and tainted its segment — the undo identity and the
  // clean-segment refusal checks never ran there: 32 KNOWN_OPEN repros ran clean, and #1805 route 2 lost its reach.
  // The fake watcher decides a raise as the host guard's `check` does (editorWriteGuard.ts, POSIX): a mark vouches for
  // the bytes it hashed, a TTL-only mark for anything, and an absent file only under the delete mark (#2009 review).
  it('harness: a mark vouches for its own bytes; a changed or a deleted write-marked file is raised (#2009)', () => {
    const two = fingerprintBytes('two\n');
    expect(editorOwns(two, 'two\n')).toBe(true); // the editor's own bytes
    expect(editorOwns(two, 'three\n')).toBe(false); // an outside write after the editor's
    expect(editorOwns(null, 'three\n')).toBe(true); // a TTL-only mark
    expect(editorOwns(two, undefined)).toBe(false); // an outside delete of a file the editor wrote
    expect(editorOwns(EDITOR_DELETE_FINGERPRINT, undefined)).toBe(true); // the editor's own delete
    expect(editorOwns(EDITOR_DELETE_FINGERPRINT, 'two\n')).toBe(false); // a file the editor deleted, written back outside
    // And it IS the host's rule (POSIX), case for case, so the fake cannot drift from the guard it copies (review).
    for (const mark of [null, two, EDITOR_DELETE_FINGERPRINT]) {
      for (const now of ['two\n', 'three\n', undefined]) {
        const guard = createEditorWriteGuard(1500, () => 0, 'linux');
        guard.mark('/p', mark);
        expect(guard.isWrite('/p', () => (now === undefined ? null : fingerprintBytes(now))), `${mark} / ${now}`).toBe(editorOwns(mark, now));
      }
    }
  });

  it('harness: the editor\'s own write is not raised as an outside edit, and an outside write is (#1840)', async () => {
    const own = `${ROOT_URL}/watcher-selftest/own.txt`; const outside = `${ROOT_URL}/watcher-selftest/outside.txt`;
    // Stopped, as `startRun` leaves it. Until then the editor's reload suppressor (agentEditorOps.ts) defers the outside
    // write's reload and the flush never settles: run alone, with no fuzz run before it, this test failed there (review).
    setRunMode('stopped');
    const before = be.snapshot();
    try {
      const r = await be.fetch('/api/write-file', { method: 'POST', body: JSON.stringify({ path: own, content: 'x' }) });
      expect(r.status, await r.clone().text()).toBe(200);
      be.write(outside, 'x');
      expect(await flushWatcher(be, before)).toEqual([outside]);
    } finally {
      be.remove(own); be.remove(outside);
    }
  });

  // #1845: the #1840 class planted — the router's mark never matches what the watcher looks up, so every editor write
  // reads as an outside edit. It used to TAINT the segment and silently turn the undo checks off; it must fail the step.
  // The accept twin: an outside edit's own raise taints, as the one cause a raise may have.
  it('harness: a raise no outside edit made FAILS the step (#1845), and an outside edit\'s own raise taints as outsideEdit', async () => {
    const ops = generate(1, VERIFY_LEN);
    const set = be.marked.set;
    be.marked.set = function (this: Map<string, string | null>) { return this; } as typeof set;
    let r: RunResult;
    try { r = await runOps(be, ops, OPTS); } finally { be.marked.set = set; }
    expect(r.failure?.check).toBe('unexpected outside write');
    expect(r.failure?.detail).toMatch(/after op \d+ \(.*\): the watcher raised a write that no outside edit made/);

    // A PLAIN outside edit: a variant needs state a fresh fixture may not have (`toOverride` a recorded field, #1914), and
    // would be a noop that taints nothing.
    const { variant: _v, ...outside } = ops.find((o) => o.kind === 'outsideEdit') ?? { kind: 'outsideEdit', u: [0.1, 0.2, 0.3, 0.2, 0.5, 0.5, 0.5, 0.5] } as Op;
    const before = taintCounts.get('outsideEdit') ?? 0;
    const ok = await runOps(be, [outside], OPTS);
    expect(ok.failure, ok.failure ? `${ok.failure.check}: ${ok.failure.detail}` : '').toBeUndefined();
    // The op's own trace line: a pattern across the joined trace matched the final round trip's "→ done" after a noop.
    expect(ok.trace[0], 'premise: the outside edit wrote a file').toMatch(/^0: outsideEdit[^→]* → done/);
    expect(taintCounts.get('outsideEdit') ?? 0).toBe(before + 1);
  });

  // Win's Windows hunt: the shrinker replays a failing seed through the same runner, so its replays were counted as the
  // hunt's own taints, and a platform that found more failures reported more taints for that reason alone. A list whose
  // failure (the #1845 plant: the editor's own save reads as an outside write) comes FIRST, so the shrinker's first cut
  // replays the trailing outside edit alone, which taints. Measured on the raw `shrink`, which counts: that is the premise
  // that the replays taint at all (close-out review: with the outside edit first, no replay ever tainted, and the test
  // stayed green with the taint maps left out of the restore). Mutation: restore only `opOutcomes` and `routeCounts` in
  // `uncounted` — this goes red.
  it('harness: shrinking a failure leaves every tally the hunt prints as it found it', async () => {
    const ops: Op[] = [
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'editField', u: [0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0] }] },
      { kind: 'outsideEdit', u: [0.1, 0.2, 0.3, 0.2, 0.5, 0.5, 0.5, 0.5] },
    ];
    const set = be.marked.set;
    be.marked.set = function (this: Map<string, string | null>) { return this; } as typeof set;
    try {
      const snap = () => JSON.stringify(tallies().map((m) => [...m].sort()));
      const taints = () => JSON.stringify([taintCounts, skippedChecks].map((m) => [...m].sort()));
      const r = await runOps(be, ops, OPTS);
      expect(r.failure?.check, 'premise: the list fails').toBe('unexpected outside write');
      const beforeRaw = taints();
      await shrink(be, ops, signature(r.failure!), OPTS);
      expect(taints(), 'premise: the shrinker\'s own replays taint').not.toBe(beforeRaw);
      const counted = snap();
      const s = await shrunk('tally', ops, r);
      expect(s.text, 'premise: the shrinker replayed the list').toMatch(/in [1-9]\d* replays/);
      expect(snap()).toBe(counted);
    } finally { be.marked.set = set; }
  }, 60_000);

  // Close-out review of the #1738 entry: the refusal names the prefab by guid only when the manifest no longer resolves
  // it. A refusal naming a PATH is a prefab that still resolves and failed to expand, which nothing else in the runner
  // would catch, so the allow-list must not forgive it. Mutation: widen the entry's guid back to `\S+` — this goes red.
  it('harness: #1738\'s missing-prefab refusal is forgiven only for a prefab named by guid', () => {
    const line = (named: string) => `[PrefabEdit] cannot save "OR" — "OR" references the prefab ${named}, which is missing or has no root, so this save cannot write it. The prefab file on disk still has it unchanged.`;
    expect(expectedError(line('cccccccc-0000-4000-8003-cda036290000'))).toBe(true);
    expect(expectedError(line('/fuzz/r1/prefabs/O.prefab.json'))).toBe(false);
  });

  // #1795 (hub ruling (i)): Create Prefab's undo leaves its file, so the walk to a segment's start may find it — but only
  // holding what that create wrote (hub review: otherwise the allowance hides a wrong write under a right path).
  it('harness: a file a Create Prefab made may remain at the segment start only while it holds that create\'s document', () => {
    const P = '/fuzz/r0/prefabs/N.prefab.json';
    const doc = { id: 'cccccccc-0000-4000-8000-000000001795', version: 8, name: 'N', rootLocalId: 1, nextLocalId: 2,
      entities: [{ localId: 1, name: 'N', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001795', traits: { EntityAttributes: { name: 'N', parentId: 0, guid: '' } } }] };
    const wrote = `${JSON.stringify(doc, null, 2)}\n`;
    const created = [wrote];
    const start = new Map<string, string>();
    expect(diffFiles(start, new Map([[P, wrote]]), created)).toBeNull();
    // The same document under a raised #1774 mark (an Apply's undo keeps it).
    expect(diffFiles(start, new Map([[P, `${JSON.stringify({ ...doc, nextLocalId: 7 }, null, 2)}\n`]]), created)).toBeNull();
    // Reject side: other content at that path, and a file no create made.
    expect(diffFiles(start, new Map([[P, `${JSON.stringify({ ...doc, name: 'Other' }, null, 2)}\n`]]), created)).toMatch(/absent vs present/);
    expect(diffFiles(start, new Map([[P, wrote]]), [])).toMatch(/absent vs present/);
    // The same document at another path: the new prefab renamed (a rename is not undoable, #1868 D2).
    expect(diffFiles(start, new Map([['/fuzz/r0/prefabs/Renamed.prefab.json', wrote]]), created)).toBeNull();

    // #1868 D2: an Assets file op is not undoable, so the segment's baseline takes it — a rename moves the bytes to the new
    // path, a trash drops the path. Mutation: make `rebaseForFileOp` a no-op — both expectations fail.
    const base = new Map([[P, wrote], ['/fuzz/r0/prefabs/K.prefab.json', 'k']]);
    rebaseForFileOp(base, { from: P, to: '/fuzz/r0/prefabs/R.prefab.json' });
    expect([...base]).toEqual([['/fuzz/r0/prefabs/K.prefab.json', 'k'], ['/fuzz/r0/prefabs/R.prefab.json', wrote]]);
    rebaseForFileOp(base, { from: '/fuzz/r0/prefabs/K.prefab.json', to: null });
    expect([...base.keys()]).toEqual(['/fuzz/r0/prefabs/R.prefab.json']);

    // …and a trash taints the segment only while something the walk restores names the prefab (review of #1868): by its
    // guid, or by its path. Mutation: answer true unconditionally — the third expectation fails.
    const Kbytes = JSON.stringify({ id: 'cccccccc-0000-4000-8000-00000000abcd', entities: [] });
    expect(trashedPrefabReferenced(Kbytes, '/fuzz/r0/prefabs/K.prefab.json', ['{"source":"cccccccc-0000-4000-8000-00000000abcd"}'])).toBe(true);
    expect(trashedPrefabReferenced(undefined, '/fuzz/r0/prefabs/K.prefab.json', ['{"prefab":"/fuzz/r0/prefabs/K.prefab.json"}'])).toBe(true);
    expect(trashedPrefabReferenced(Kbytes, '/fuzz/r0/prefabs/K.prefab.json', ['{"source":"another"}', wrote])).toBe(false);
  });

  // #1880 T1: the undo walk sets the localId mark and the version aside only in the direction a restore may move them. It
  // deleted both, so a walk that gave back a LOWER mark (#1877 3b S1's damage) compared equal. Mutation: restore the
  // unconditional delete in `diffFiles` — the two reject expectations pass through as null and fail.
  it('harness: the undo walk forgives a RAISED mark or version, and rejects a lowered one (#1880 T1)', () => {
    const P = '/fuzz/r0/prefabs/P.prefab.json';
    const doc = { id: 'cccccccc-0000-4000-8000-000000001880', version: 9, name: 'P', rootLocalId: 1, nextLocalId: 7,
      entities: [{ localId: 1, name: 'P', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001880', traits: { EntityAttributes: { name: 'P', parentId: 0, guid: '' } } }] };
    const text = (d: object) => `${JSON.stringify(d, null, 2)}\n`;
    const at = (d: object) => new Map([[P, text(d)]]);
    expect(diffFiles(at(doc), at(doc))).toBeNull();
    // Accept side: a restore that raised the mark, and one that claims a newer version with it.
    expect(diffFiles(at(doc), at({ ...doc, nextLocalId: 9 }))).toBeNull();
    expect(diffFiles(at({ ...doc, version: 5 }), at(doc))).toBeNull();
    // Reject side: the same document with its mark, or its version, gone down.
    expect(diffFiles(at(doc), at({ ...doc, nextLocalId: 6 }))).toMatch(/localId mark went down \(7 → 6\)/);
    expect(diffFiles(at(doc), at({ ...doc, version: 8 }))).toMatch(/format version went down/);
    // #1933 S5: a reservation the renderer holds for the document does not hide a lowered stated mark. Mutation: compare
    // `localIdCounter` (counts the reservation) in `diffFiles` — both sides read 21 and the drop passes.
    reserveLocalId(doc.id, 20);
    try { expect(diffFiles(at(doc), at({ ...doc, nextLocalId: 6 }))).toMatch(/localId mark went down \(7 → 6\)/); } finally { clearReservedLocalIds(); }
  });

  // #1880 T1 (close-out re-review): the two exemptions the held checks take, pinned on their reject side. Mutation: give the
  // mark check `handEdited` (the document match) instead of `handBytes` — the first expectation fails; make `carried`
  // accept any version of a seen document — the third fails.
  it('harness: a lowered park of a hand edit is still mark-checked, and I15 carries a seen document only at a seen version or v8 (#1880 T1)', () => {
    const P = '/fuzz/r0/prefabs/P.prefab.json';
    const doc = (mark: number, version = 9) => JSON.stringify({ id: 'cccccccc-0000-4000-8000-000000001880', version, rootLocalId: 1, nextLocalId: mark, entities: [{ localId: 1 }] }, null, 2);
    const hand = doc(7);
    const lowered = JSON.stringify(JSON.parse(doc(6)));
    const sets = handEditedPaths(new Map([[P, lowered]]), new Set([hand]));
    expect([...sets.handBytes], 'a park of the hand document with a LOWER mark is not the hand edit').toEqual([]);
    expect([...sets.handEdited], 'the file checks still skip it as the hand edit').toEqual([P]);
    const { see, carried } = carryTracker();
    see(doc(7, 5));
    expect(carried(doc(9, 7)), 'a seen document at a version it never had (v7) is a new write').toBe(false);
    expect(carried(doc(9, 8)), 'at v8, the version a raised mark claims').toBe(true);
    expect(carried(doc(9, 5)), 'at the version it was seen at').toBe(true);
  });

  // #1880 T1: the mark check reads what the editor HOLDS — a park laid over its file — and never lets a document's mark
  // go down across steps. Mutation: make `checkMarks` return [] — the first reject expectation fails; drop its handEdited
  // skip — the hand-edit expectation fails.
  it('harness: the mark check fails a held document whose mark went down, and skips a hand edit (#1880 T1)', () => {
    const P = '/fuzz/r0/prefabs/P.prefab.json';
    const doc = (mark: number) => JSON.stringify({ id: 'cccccccc-0000-4000-8000-000000001880', version: 9, rootLocalId: 1, nextLocalId: mark, entities: [{ localId: 1 }] });
    const marks = new Map<string, number>();
    expect(checkMarks(new Map([[P, doc(7)]]), marks, new Set())).toEqual([]);
    expect(checkMarks(new Map([[P, doc(9)]]), marks, new Set())).toEqual([]); // up is lawful
    const down = checkMarks(new Map([[P, doc(6)]]), marks, new Set([P]));
    expect(down.map((f) => [f.check, f.detail])).toEqual([['I4 high-water mark went down', `${P} (parked): 9 → 6`]]);
    // A hand edit is held to nothing (the runner forgets the document's mark when an outside edit writes it).
    expect(checkMarks(new Map([[P, doc(2)]]), marks, new Set(), new Set([P]))).toEqual([]);
    // #1933 S5: nor does a reservation hide a drop. Mutation: read `localIdCounter` in `checkMarks` — 21 both times.
    reserveLocalId('cccccccc-0000-4000-8000-000000001880', 20);
    try {
      const held = new Map<string, number>();
      checkMarks(new Map([[P, doc(9)]]), held, new Set());
      expect(checkMarks(new Map([[P, doc(6)]]), held, new Set()).map((f) => f.check)).toEqual(['I4 high-water mark went down']);
    } finally { clearReservedLocalIds(); }
  });

  // #1838: the round trip holds a rotation as ONE value, an orientation (#1490's rule), not three numbers.
  // #1933: I23 compares these keys around a record-neutral op. Mutations: drop the component-bag key (`isComponent` →
  // false) — the lost `{T: {}}` is not seen; key the empty `traits: {}` itself — the seed-1247 fill reads as a loss.
  it('harness: I23\'s record keys see a component added with no fields, and an empty bag that fills is no loss (#1933)', () => {
    const entry = (members: unknown, overrides?: unknown) => JSON.stringify({ entities: [{ guid: 'G', members, ...(overrides ? { overrides } : {}) }] });
    const added = recordKeys(entry({ '/n': { traits: { Rotate3D: {} } } }, { 3: { Tag: {} } }));
    for (const k of ['G members//n/traits/Rotate3D', 'G overrides/3/Tag']) expect(added.has(k)).toBe(true);
    const gone = recordKeys(entry({ '/n': { traits: {} } }));
    expect([...added].filter((k) => !gone.has(k)).sort()).toEqual(['G members//n/traits/Rotate3D', 'G overrides/3/Tag']);
    const before = recordKeys(entry({ '/n': { traits: {} } }));
    const after = recordKeys(entry({ '/n': { traits: { Transform: { x: 1 } } } }));
    expect([...before].filter((k) => !after.has(k))).toEqual([]);
    const filled = recordKeys(entry({ '/n': { traits: { Rotate3D: { speed: 2 } } } }));
    expect(filled.has('G members//n/traits/Rotate3D')).toBe(true);
  });

  it('harness: the round trip forgives an equal rotation spelled differently, and nothing else (#1838)', () => {
    const G = '1aaaaaaa-0000-4000-8000-000000001838';
    const at = (tf: Record<string, number>) => ({ [G]: { traits: { Transform: tf } } });
    const rt = (b: Record<string, number>, a: Record<string, number>) => ({ before: at(b), after: at(a), firstBytes: '{}', secondBytes: '{}' });
    // 0.283… = -6 + 2π: the same turn, win's hunt seed 4773.
    expect(checkRoundTrip(rt({ x: 1, rx: 0.28318530717958645, ry: 0, rz: 0 }, { x: 1, rx: -6, ry: 0, rz: 0 }))).toEqual([]);
    // (π, 0, π) and (0, π, 0) are one orientation too, spelled across all three fields.
    expect(checkRoundTrip(rt({ rx: Math.PI, ry: 0, rz: Math.PI }, { rx: 0, ry: Math.PI, rz: 0 }))).toEqual([]);
    // Reject side: a different orientation, and an equal rotation beside a changed position, still fail.
    expect(checkRoundTrip(rt({ rx: 0.28, ry: 0, rz: 0 }, { rx: 0.5, ry: 0, rz: 0 }))[0]?.detail).toMatch(/\/traits\/Transform\/rx: 0\.28 vs 0\.5/);
    expect(checkRoundTrip(rt({ x: 1, rx: 0.28318530717958645 }, { x: 2, rx: -6 }))[0]?.detail).toMatch(/\/traits\/Transform\/x: 1 vs 2/);
  });

  // #1841: #1823 widened #1795's and #1827(b)'s stops to accept Create Prefab's untag line, which would also have claimed
  // an UNRELATED root loss under the same op shape. Those entries are gone (#1795 and #1827 fixed); this pins that no stop
  // claims a planted root loss after a Create Prefab and an undo, in any of the forms a run reports it.
  it('harness: no KNOWN_OPEN stop claims a planted root loss under Create Prefab + undo (#1841)', () => {
    const R = '5eeeeeee-0000-4000-8000-000000001841';
    const u = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const op = (kind: Op['kind']) => ({ kind, u, ...(kind === 'prefabEdit' ? { inner: [] } : {}) }) as Op;
    const shapes: Op[][] = [
      [op('createPrefab'), op('undo')],
      [op('createPrefab'), op('saveReload'), op('undo')],
      [op('createPrefab'), op('trashPrefab'), op('prefabEdit'), op('undo')],
      [op('addChild'), op('createPrefab'), op('apply'), op('undo'), op('undo')],
    ];
    const touched = { drop: [], paste: [], detach: [], create: [R] };
    const untag = '[undo] Undo of "Save prefab "R"" did not fully apply — the entity linked to /fuzz/r0/prefabs/R.prefab.json no longer exists, so nothing was unlinked';
    const planted = (ops: Op[]): StepFailure[] => [
      { check: 'console.error', detail: untag, step: ops.length - 1, op: 'undo(0.5,0.5,0.5,0.5)', touched },
      { check: 'console.error', detail: untag, step: ops.length, op: 'undo/redo to the ends', touched, console: [untag] },
      { check: 'save→reload is not the identity', detail: `/${R}: {"traits":{"EntityAttributes":{"name":"R"}}} vs undefined (an entity was lost)`, step: ops.length, op: 'final save→reload', touched },
      { check: 'undo to the start does not restore the scene', detail: `/entities/${R}: {"traits":{"EntityAttributes":{"guid":"${R}"}}} vs undefined`, step: ops.length, op: 'undo/redo to the ends', touched, console: [untag] },
      { check: 'redo to the end does not restore the scene', detail: `/entities/${R}: {"traits":{"EntityAttributes":{"guid":"${R}"}}} vs undefined`, step: ops.length, op: 'undo/redo to the ends', touched, console: [untag] },
    ];
    // A fixture stop planted beside the real entries, so the matcher is exercised while KNOWN_OPEN is empty: one
    // mechanism under the same op shape (a Create Prefab's undo loses a MEMBER's row of the entity it created), keyed on
    // the check, the path, the entity the create touched and the ops — as a real entry is.
    const fixture: KnownOpen = {
      issue: -1841, what: 'fixture: a Create Prefab undo loses a member row', repro: [], reproduces: () => false,
      stops: (f, ops) => f.check === 'undo to the start does not restore the scene' && ops.some((o) => o.kind === 'createPrefab') && ops.some((o) => o.kind === 'undo')
        && (f.touched?.create ?? []).some((g) => f.detail.startsWith(`/entities/${g}/members/`)),
    };
    const list = [...KNOWN_OPEN, fixture];
    // Accept side: under every shape, the fixture claims its own failure. Only the planted claims are compared: a real entry
    // for this mechanism, should one reopen, rightly claims it too (review).
    for (const ops of shapes) {
      const own: StepFailure = { check: 'undo to the start does not restore the scene', detail: `/entities/${R}/members//aaaaaaaa-0000-4000-8000-000000001841/traits: {"Transform":{"x":1}} vs undefined`, step: ops.length, op: 'undo/redo to the ends', touched };
      expect(claimsOf(own, ops, list).filter((k) => k.issue < 0).map((k) => k.issue), ops.map((o) => o.kind).join(',')).toEqual([fixture.issue]);
    }
    // Refuse side: no stop, real or planted, claims a root loss.
    const claims = shapes.flatMap((ops) => planted(ops).flatMap((f) => claimsOf(f, ops, list).map((k) => `#${k.issue} claims ${f.check} after ${ops.map((o) => o.kind).join(',')}`)));
    expect(claims).toEqual([]);
  });

  it('harness: a signature drops what differs between replays (scratch paths, the run folder, guids) and keeps the message', () => {
    const a = signature({ check: 'console.error', detail: '[Prefab] /var/folders/x/modoki-prefab-fuzz-lVa3m1/r0a1b2c3d4e5f6/prefabs/H.prefab.json holds a mark of 6' });
    const b = signature({ check: 'console.error', detail: '[Prefab] /var/folders/x/modoki-prefab-fuzz-Q9zz/r00ffee001234/prefabs/H.prefab.json holds a mark of 4' });
    expect(a).toBe(b);
    // The Windows form of the same line (#1840): a drive letter and `\` separators, printed as a real run did.
    const w = signature({ check: 'console.error', detail: '[Prefab] E:\\dev-temp\\modoki-prefab-fuzz-n3srxX\\r31f1810d0000\\prefabs\\H.prefab.json holds a mark of 5' });
    expect(w).toBe(a);
    expect(signature({ check: 'op threw', detail: 'reload: superseded | at x' })).not.toBe(signature({ check: 'op threw', detail: 'Cannot read x | at y' }));
  });

  it('harness: the swallow taint (#1831, seed 6356) fires only for a guid swallowed in the step that the segment had live', () => {
    const live = new Set(['r']);
    // Mutation: drop `live.has(g)` — a placeholder holding a template row's or an asset's guid taints the segment, and
    // every refusal after it is forgiven (review #3).
    expect(newlySwallowed(live, new Set(), new Set(['row-guid']))).toBe(false);
    // Mutation: drop `!before.has(g)` — a placeholder that swallowed `r` steps ago taints every later step.
    expect(newlySwallowed(live, new Set(['r']), new Set(['r']))).toBe(false);
    expect(newlySwallowed(live, new Set(), new Set(['row-guid', 'r']))).toBe(true);
  });

  it('harness: the allowlist takes the lines it names (as the runs printed them) and not their neighbours', () => {
    // #1679's Create Prefab refusal, and #1774's route-side mark log.
    expect(expectedError('[undo] Undo of "Save prefab "R"" was REFUSED — /fuzz/r1c6d877e0000/prefabs/R.prefab.json is not what this step left there (changed on disk since, or another file now at that path), so nothing was written or trashed. The entry was dropped from the history; nothing was applied.')).toBe(true);
    expect(expectedError('[Prefab] /var/folders/nt/T/modoki-prefab-fuzz-V2kGoU/r2c7497320000/prefabs/H.prefab.json holds a localId high-water mark of 5, and this write would lower it to 4. Refusing — a number below the mark may have belonged to a deleted member')).toBe(true);
    // #1868's in-memory refusal of an Apply's undo, as the G1 M2 replay printed it.
    expect(expectedError('[undo] Undo of "Apply to Prefab" was REFUSED — /fuzz/r4a793a230000/prefabs/H.prefab.json changed since this step (a prefab-edit save, another write, or an outside change), so it was left as it is. The entry was dropped from the history; nothing was applied.')).toBe(true);
    // #308's redo of an Instantiate whose prefab was trashed, as hunt seed 7293 printed it.
    expect(expectedError('[undo] Redo of "Instantiate "P"" did not fully apply — the prefab could not be instantiated — its file was most likely deleted since the undo. No instance was created.')).toBe(true);
    // Neighbours that are findings: Create Prefab's undo that did not fully apply (#1795), and a refusal that is not the
    // Create Prefab one (another step's, which is not allowed at all).
    expect(expectedError('[undo] Undo of "Save prefab "M"" did not fully apply — 1 prefab link the tree had before could not be put back')).toBe(false);
    expect(expectedError('[undo] Undo of "Rename" was REFUSED — /fuzz/r0/prefabs/R.prefab.json is not what this step left there')).toBe(false);
    expect(expectedError('[undo] Redo of "Instantiate "P"" did not fully apply — 2 members could not be put back')).toBe(false);
    // The cycle line's follow-up is allowed only right after the cycle line.
    expect(expectedError('[PrefabEdit] cannot save "O" — serialize produced no prefab')).toBe(false);
    // #2009: an agent composite whose every sub refused under ruling R, as hunt seeds 1036 and 1042 printed it, with one
    // sub and with two; and its neighbours, a composite with one sub refused for another reason, and one that half-applied.
    const gone = (label: string, name: string) => `"${label}": "${name}" (8da1aae8-bf38-5159-ea38-39baebd544a3) is no longer in the scene, so the step would act on nothing, or on whatever holds its place now.`;
    expect(expectedError(`[undo] Undo of "Mutate Scene (1 op)" was REFUSED — every sub-action refused during undo: ${gone('Remove Rotate3D', 'M')} The entry was dropped from the history; nothing was applied.`)).toBe(true);
    expect(expectedError(`[undo] Redo of "Set Traits" was REFUSED — every sub-action refused during redo: ${gone('Edit Transform.x', 'QR')} | ${gone('Add Rotate3D', 'QR')} The entry was dropped from the history; nothing was applied.`)).toBe(true);
    expect(expectedError(`[undo] Redo of "Set Traits" was REFUSED — every sub-action refused during redo: ${gone('Edit Transform.x', 'QR')} | "Add Rotate3D": /fuzz/r0/prefabs/R.prefab.json is not what this step left there The entry was dropped from the history; nothing was applied.`)).toBe(false);
    expect(expectedError('[undo] Undo of "Mutate Scene (2 ops)" threw — 1 of 2 sub-action(s) failed during undo: "M905" refused ("M905" is no longer in the scene)')).toBe(false);
  });

  it('harness: a diff names the node or entry it is about, and whether that one MOVED (#1793) or is gone', () => {
    // Distinct first groups, as the harness's minted and fixture guids are: a diff truncates a value to 60 characters.
    const G = '1aaaaaaa-0000-4000-8000-000000000001'; const E = '2bbbbbbb-0000-4000-8000-000000000002'; const H = '3ccccccc-0000-4000-8000-000000000003';
    const inst = (g: string) => ({ prefab: 'p', guid: g }); const plain = (g: string) => ({ traits: { EntityAttributes: { guid: g } } });
    // A plain entry lost beside an instance is named as itself, not as the instance that shifted into its slot.
    const a = { entities: [plain(E), inst(G)] }; const b = { entities: [inst(G)] };
    const d = firstDiff(a, b)!;
    expect(d.startsWith(`/entities/${E}: `)).toBe(true);
    expect(nodeMoved(d, a, b)).toBe(false);
    // A node gone from one list and present in another moved; one gone from everywhere did not.
    const n = (g: string) => ({ parentLocalId: 1, guid: g });
    const x = { entities: [{ ...inst(E), added: [n(G)] }, { ...inst(H), added: [] }] };
    const y = { entities: [{ ...inst(E), added: [] }, { ...inst(H), added: [n(G)] }] };
    const moved = firstDiff(x, y)!;
    expect(moved).toMatch(/\/added: \{"parentLocalId":1,"guid":"1aaaaaaa/);
    expect(nodeMoved(moved, x, y)).toBe(true);
    const z = { entities: [{ ...inst(E), added: [] }, { ...inst(H), added: [] }] };
    expect(nodeMoved(firstDiff(x, z)!, x, z)).toBe(false);
    // A lost entry is not "moved" because a child's parentId still names it.
    const withChild = { entities: [inst(G), { traits: { EntityAttributes: { guid: E, parentId: G } } }] };
    const childOnly = { entities: [{ traits: { EntityAttributes: { guid: E, parentId: G } } }] };
    const lost = firstDiff(withChild, childOnly)!;
    expect(lost.startsWith(`/entities/${G}: `)).toBe(true);
    expect(nodeMoved(lost, withChild, childOnly)).toBe(false);
  });

  // #1934 F4: a live instance of a DELETED prefab stays expanded, and the reload expands every frame its scene's copy lists
  // as live at the save (#1935, #1939), so the round trip is the plain one, with no waiver: a scene-added node that comes
  // back a placeholder, or a placeholder entry that comes back expanded, is a failure KNOWN_OPEN tolerates nothing of.
  it('harness: a deleted prefab\'s live frame reloads as its placeholder (ruling B, applied); anything else of it is a plain round-trip failure', () => {
    const same = { firstBytes: '{}', secondBytes: '{}' };
    const gone = (src: string) => src === 'P';
    const ea = (name: string, parentId: string | number = 0) => ({ EntityAttributes: { name, parentId } });
    const pi = (source: string, rootInstanceId: string) => ({ PrefabInstance: { source, rootInstanceId } });
    const o = { traits: { ...ea('OR'), ...pi('O', 'o') } };
    const live = { o, n: { traits: { ...ea('N', 'o'), ...pi('P', 'n') } }, nm: { traits: { ...ea('A', 'n'), ...pi('P', 'n') } } };
    // #2001 S5, rule 9 / owner ruling B: no copy is expanded, so the frame comes back as its placeholder, in its place, its
    // members gone (their records are the placeholder's, which the byte check holds). Mutation: return `before` from
    // `ruledMissing` — the node reads as lost again.
    expect(checkRoundTrip({ before: live, after: { o, n: { traits: ea('N', 'o'), unresolved: 'P' } }, ...same }, gone)).toEqual([]);
    // …but only in its place: a placeholder that came back under another parent is the root not given back.
    const moved = checkRoundTrip({ before: live, after: { o, n: { traits: ea('N', 0), unresolved: 'P' } }, ...same }, gone);
    expect(moved).toHaveLength(1);
    // …and only for a prefab that is gone: the same reload of a prefab still there is a loss.
    const nodeBack = checkRoundTrip({ before: live, after: { o, n: { traits: ea('N', 'o'), unresolved: 'P' } }, ...same }, () => false);
    expect(nodeBack).toHaveLength(1);
    expect(KNOWN_OPEN.some((k) => k.tolerates?.(nodeBack[0]!))).toBe(false);
    const g = { traits: ea('G') };
    const entryBack = checkRoundTrip({ before: { g, e: { traits: ea('E', 'g'), unresolved: 'P' } }, after: { g, e: { traits: { ...ea('E', 'g'), ...pi('P', 'e') } }, em: { traits: { ...ea('A', 'e'), ...pi('P', 'e') } } }, ...same }, gone);
    expect(entryBack).toHaveLength(1);
    expect(entryBack[0]!.detail).toMatch(/\(an entity was gained\)$/);
    expect(KNOWN_OPEN.some((k) => k.tolerates?.(entryBack[0]!))).toBe(false);
    // A nested frame LOST (a template row's frame that did not come back) is a loss, named as one of a deleted prefab.
    const nested = { o, f: { traits: { ...ea('F', 'o'), ...pi('P', 'f') } } };
    expect(checkRoundTrip({ before: nested, after: { o }, ...same }, gone)[0]?.detail).toMatch(/^\/f: .*\(an entity of a deleted prefab was lost\)$/);
  });

  it('harness: a prefab created and then deleted in one run passes the final round trip (#1805 route 2, allowed)', async () => {
    // The created prefab's top-level instance stays expanded, and the reload gives its placeholder (rule 9, ruling B: the
    // scene's copy is never expanded, #2001 S5), which the round trip applies to the live side (`ruledMissing`).
    const ops: Op[] = [
      { kind: 'instantiate', u: [0.5075831420253962, 0.8186536263674498, 0.4673538957722485, 0.9546289832796901, 0.39170667389407754, 0.5493532461114228, 0.4505586097948253, 0.8853592379018664] },
      { kind: 'duplicate', u: [0.39032594044692814, 0.04696453106589615, 0.3570088869892061, 0.40155923343263566, 0.5113228356931359, 0.29383464995771646, 0.025902038207277656, 0.7472156076692045] },
      { kind: 'createPrefab', u: [0.5959376466926187, 0.9407973305787891, 0.6634466790128499, 0.633407388580963, 0.013036289950832725, 0.15678744250908494, 0.8456963025964797, 0.3821238283999264] },
      { kind: 'trashPrefab', u: [0.3976654135622084, 0.9079436135943979, 0.3005773222539574, 0.4423462732229382, 0.34140314417891204, 0.17301023192703724, 0.8832939309068024, 0.3436738490127027] },
    ];
    const r = await runOps(be, ops, OPTS);
    expect(r.trace.slice(0, 4).every((l) => l.includes('→ done')), r.trace.join('\n')).toBe(true); // precondition: all ran
    expect(r.trace[4], r.failure ? `${r.failure.check}: ${r.failure.detail}` : '').toBe('4: final save→reload → done (1 deleted prefab(s); 1 placeholder(s) on the reload)');
    // The round trip passed. The walk after it runs undo against the placeholder the reload made — #1819's class (group 1
    // of #1789: the owner ruled such an undo refuses and drops its step; not built yet), which this test does not judge.
    expect(r.failure === undefined || r.failure.op === 'undo/redo to the ends', r.failure ? `${r.failure.op} — ${r.failure.check}: ${r.failure.detail}` : '').toBe(true);
  }, 120_000);

  it('harness: a run is reproducible — the same list twice gives the same trace and the same outcome', async () => {
    const ops = generate(VERIFY_SEEDS[0], VERIFY_LEN);
    // Uncounted: seed 1 runs as a verify seed already, and the tallies say what the verify SEEDS covered (close-out review).
    const [a, b] = await uncounted(async () => [await runOps(be, ops, OPTS), await runOps(be, ops, OPTS)]);
    // Only the run's TAG differs: a second run of one list takes the next occurrence (the tag's low 16 bits), and the tag is
    // both the run's folder and every run guid's last group (`harness.ts` `tagFor`). Masked in both places — a guid only by
    // its occurrence digits, so the list hash before them must still match. The folder alone was masked until a trace line
    // named a guid: an Apply that is a noop because its prefab was deleted says which (#1805's eviction made it one).
    const masked = (t: string[]) => t.map((line) => line
      .replace(/\/fuzz\/r[0-9a-f]{12}\//g, '/fuzz/rTAG/')
      .replace(/(-[0-9a-f]{4}-[0-9a-f]{8})[0-9a-f]{4}\b/g, '$1OCCR'));
    // The mask forgives the occurrence and nothing else: a different list hash, or a different guid counter, still differs.
    expect(masked(['x cccccccc-0000-4000-8001-31f1810d0000'])).toEqual(masked(['x cccccccc-0000-4000-8001-31f1810d0001']));
    expect(masked(['x cccccccc-0000-4000-8001-31f1810d0000'])).not.toEqual(masked(['x cccccccc-0000-4000-8001-41f1810d0000']));
    expect(masked(['x 10000001-0000-4000-8000-31f1810d0000'])).not.toEqual(masked(['x 10000002-0000-4000-8000-31f1810d0000']));
    expect(masked(b.trace)).toEqual(masked(a.trace));
    expect(b.failure && signature(b.failure)).toBe(a.failure && signature(a.failure));
    // Every minted guid is the run's seeded sequence (a counter, then the run's tag), not entropy: a guid tie-break then
    // orders the same way on every replay of the list.
    expect(newGuid()).toMatch(/^1[0-9a-f]{7}-0000-4000-8000-[0-9a-f]{12}$/);
  }, 120_000);

  // #2009 (#2001 design § 10.2, review R3): the doors the census found the fuzzer never drove. A fixed list, so each is
  // REACHED (its op lands, not a noop or a refusal) and each check it feeds runs, whatever the generator's weights draw.
  // Mutations (each goes red here, and only on its own check): Stop restoring nothing (`stopPlay` skipping
  // `restoreAuthoredSnapshot`) → "I13 Stop does not restore"; the preview session ending without its restore → "I13 the
  // preview exit"; `refuseEditOfPosedWorld` answering null → "an agent edit of a posed world was not refused"; the runner
  // not exempting `agentWrote` from the raise check → "unexpected outside write".
  it('#2009: the agent, Play/Stop and timeline-preview doors are reached, and the checks they feed run', async () => {
    const u = (set: Record<number, number>) => Array.from({ length: 8 }, (_, i) => set[i] ?? 0.5);
    const ops: Op[] = [
      { kind: 'agentSetTraits', u: u({ 3: 0.1 }) }, // a Transform field
      { kind: 'agentSetTraits', u: u({ 3: 0.9, 4: 0.1 }) }, // a field of a component the entity lacks: added
      { kind: 'agentInstantiate', u: u({ 1: 0.9 }) }, // under a guid-named parent
      { kind: 'agentSceneOps', u: u({ 3: 0.1 }) }, // the live route: setTrait
      { kind: 'agentSceneOps', u: u({ 3: 0.8 }) }, // the live route: addEntity
      { kind: 'playStop', u: u({ 0: 0.9, 1: 0.1 }) }, // two edits in Play: a field, then a delete
      // A posed Transform.y of 8 (u[5]): a pose that writes the value the world already holds restores nothing, and the
      // check could not tell a restore from none (a mutation of the exit's restore stayed green with u[5] = 0.5).
      { kind: 'timelinePreview', u: u({ 5: 0.9, 7: 0.2 }) }, // left by toolbar Stop
      { kind: 'timelinePreview', u: u({ 5: 0.9, 7: 0.8 }) }, // left by the panel's exit
      { kind: 'undo', u: u({ 0: 0.9 }) },
      { kind: 'fileMutate', u: u({ 0: 0, 2: 0.9, 3: 0.1 }) }, // the first entry, an instance root: the legacy root channel (R5)
    ];
    const { res, grew } = await uncounted(async () => {
      const before = { ...Object.fromEntries(checksRun), ...Object.fromEntries([...taintCounts].map(([k, n]) => [`taint ${k}`, n])) };
      const r = await runOps(be, ops, STRICT);
      const after = { ...Object.fromEntries(checksRun), ...Object.fromEntries([...taintCounts].map(([k, n]) => [`taint ${k}`, n])) };
      return { res: r, grew: Object.keys(after).filter((k) => after[k]! > (before[k] ?? 0)) };
    });
    expect(res.failure, res.failure ? `${res.failure.check}: ${res.failure.detail}\n${res.trace.join('\n')}` : '').toBeUndefined();
    const outcomeOf = (i: number) => res.trace.map((l) => /^(\d+): .*? → (\w+)/.exec(l)).find((m) => m && Number(m[1]) === i)?.[2];
    expect(ops.map((_, i) => `${i} ${ops[i]!.kind} ${outcomeOf(i)}`)).toEqual(ops.map((o, i) => `${i} ${o.kind} done`));
    expect(grew).toEqual(expect.arrayContaining(['I23 around playStop', 'I23 around timelinePreview', 'taint agentFileWrite']));
    // The file-direct write REACHED the editor and survived its saves: the first entry (an instance root) still states
    // Transform.z = 8 in its legacy root channel after the final save→reload. A watcher that took the op's own Save mark
    // for the outside write too swallowed it, and the final save wrote the scene back without it (#2009's harness fix).
    const scenePath = [...be.snapshot().keys()].find((p) => p.endsWith('/scenes/Fuzz.json'))!;
    const entry = (JSON.parse(be.read(scenePath)!) as { entities: Array<{ overrides?: Record<string, { Transform?: { z?: number } }> }> }).entities[0]!;
    expect(Object.values(entry.overrides ?? {}).some((o) => o.Transform?.z === 8), JSON.stringify(entry.overrides)).toBe(true);
  }, 120_000);

  // P1 by the fold (#2009 part 2) found a gap in the comparison itself (foldOracle.ts): a template-added REFERENCE node
  // did not open a frame ("fold-only node /F/a+X/..."). Both minimized routes from the 2026-10-02 hunt must now run clean
  // with the check counted; shown red by that mutation. Hub ruling 2026-10-02: an oracle gap, not a fold defect — the
  // live entities sit where the fold puts them, and a save→reload is the same. (The oracle's other gap, kept rows under a
  // rule-B placeholder, is held by foldInstanceOracleFuzz.test.ts's seed 103.)
  it('#2009: P1 by the fold holds on template-added reference nodes and foreign stored roots (oracle gaps the hunt found)', async () => {
    const cases: Record<string, Op[]> = {
      'an instantiate in prefab edit mode (a template-added reference node)': [
        { kind: 'prefabEdit', u: [0.3020704125519842, 0.3749536194372922, 0.42213196074590087, 0.40289529715664685, 0.39253392070531845, 0.266626542666927, 0.828643477987498, 0.6243362268432975], inner: [{ kind: 'instantiate', u: [0.90849429811351, 0.8387780718039721, 0.7161983735859394, 0.8973747261334211, 0.14793384936638176, 0.5566688724793494, 0.23754322016611695, 0.07028496148996055] }] },
      ],
      'Create Prefab of an instance holding a scene-added reference node': [
        { kind: 'instantiate', u: [0.9785601259209216, 0.7552136613521725, 0.2955629227217287, 0.10258582420647144, 0.8701307433657348, 0.18878118298016489, 0.6025536984670907, 0.5656476493459195] },
        { kind: 'createPrefab', u: [0.045867482433095574, 0.7695533491205424, 0.39526152424514294, 0.039226526161655784, 0.9665321970824152, 0.6368354156147689, 0.2166700209490955, 0.9771678755059838] },
      ],
      // A template-added node under a template-added REFERENCE node: keyed in the reference node's frame (/F/a+X/a+Y).
      'Create Prefab of an instance whose scene-added reference node holds another': [
        { kind: 'instantiate', u: [0.5452670496888459, 0.9185665613040328, 0.10775163257494569, 0.8007432606536895, 0.4144696162547916, 0.8174828256014735, 0.8313712903764099, 0.36589792813174427] },
        { kind: 'reparent', u: [0.3809924677480012, 0.6887131074909121, 0.227493601385504, 0.5140306104440242, 0.999745735200122, 0.8504236072767526, 0.18166282982565463, 0.5389415095560253] },
        { kind: 'instantiate', u: [0.04089164547622204, 0.018671562429517508, 0.3143713332246989, 0.0006737359799444675, 0.6996929873712361, 0.7706542836967856, 0.873330732807517, 0.5525062764063478] },
        { kind: 'timelinePreview', u: [0.9622934160288423, 0.38139918236993253, 0.6873752218671143, 0.007343278266489506, 0.046908345306292176, 0.14558980311267078, 0.7842403906397521, 0.5771834806073457] },
        { kind: 'createPrefab', u: [0.051619044970721006, 0.19952322961762547, 0.7071757176890969, 0.8638966714497656, 0.8690867677796632, 0.007202112348750234, 0.983666519401595, 0.1085439685266465] },
      ],
      // A scene-added reference node's own template-added node: never claimed on the outer instance's key.
      'an agent instantiate under a member, inside a duplicate': [
        { kind: 'duplicate', u: [0.48945846571587026, 0.47396950447000563, 0.05526354908943176, 0.4432587781921029, 0.6669238524045795, 0.2945732136722654, 0.2893497431650758, 0.9265729640610516] },
        { kind: 'duplicate', u: [0.19135557231493294, 0.4103741485159844, 0.14552880264818668, 0.7415867387317121, 0.7291451483033597, 0.005936015164479613, 0.6244459943845868, 0.053858045721426606] },
        { kind: 'agentInstantiate', u: [0.4222325817681849, 0.8234889090526849, 0.8316709182690829, 0.9349119781982154, 0.3937791904900223, 0.6970346109010279, 0.022497162222862244, 0.38807249744422734] },
      ],
    };
    for (const [what, ops] of Object.entries(cases)) {
      const { res, grew } = await uncounted(async () => {
        const before = Object.fromEntries(checksRun);
        const r = await runOps(be, ops, STRICT);
        return { res: r, grew: Object.keys(Object.fromEntries(checksRun)).filter((k) => checksRun.get(k)! > (before[k] ?? 0)) };
      });
      expect(res.failure, `${what}: ${res.failure?.check}: ${res.failure?.detail}`).toBeUndefined();
      expect(grew, what).toContain('P1 by the fold');
    }
  }, 120_000);

  // #2021: a HELD own link — added under a member the instance no longer projects — is placed `heldNode` (#2018's
  // ruling, B′), and P1's placement check (foldOracle.ts `placementDiverge`) compares it. Generator seeds reach one only
  // at hunt length (40; none at the verify length, and none in a saved scene), so the shape is held here, minimized from
  // hunt seed 246 (#2018's own repro stopped reaching it once the fold's fixes moved its targets).
  it('#2021: P1 by the fold places a HELD own link (hunt seed 246)', async () => {
    const ops: Op[] = [
      { kind: 'duplicate', u: [0.7219006572850049, 0.5483197642024606, 0.30764133017510176, 0.5250595326069742, 0.09884512959979475, 0.40332550974562764, 0.8549339685123414, 0.12889821105636656] },
      { kind: 'instantiate', u: [0.46533699450083077, 0.3489740223158151, 0.42113381205126643, 0.3490595759358257, 0.5367825583089143, 0.6584286321885884, 0.4939265919383615, 0.9836620986461639] },
      { kind: 'fileMutate', u: [0.08333333333333333, 0.0669010104611516, 0.11636064387857914, 0.5872549663763493, 0.6053570182994008, 0.006638948572799563, 0.7421369452495128, 0.9577205339446664] },
      { kind: 'delete', u: [0.86, 0.21144867152906954, 0.29246249445714056, 0.6761395719368011, 0.1756759958807379, 0.4217527159489691, 0.6035060549620539, 0.608379076467827] },
      { kind: 'reparent', u: [0.0625, 0.3475193327758461, 0.35416666666666663, 0.9471577857621014, 0.6461046554613858, 0.49814249901100993, 0.31486722477711737, 0.9499714151024818] },
      { kind: 'prefabEdit', u: [0.4120011862833053, 0.9537779504898936, 0.4036154255736619, 0.43466546991840005, 0.38601681031286716, 0.2412711256183684, 0.09834549622610211, 0.639129497576505], inner: [{ kind: 'addChild', u: [0.9393244939856231, 0.4576516943052411, 0.23018345166929066, 0.40157105633988976, 0.16762143652886152, 0.2843701737001538, 0.8595813701394945, 0.24596478277817369] }, { kind: 'instantiate', u: [0.22026996384374797, 0.12059283978305757, 0.2941668222192675, 0.4091447307728231, 0.13556098844856024, 0.8536935087759048, 0.814816486556083, 0.3400204873178154] }, { kind: 'redo', u: [0.24725748295895755, 0.28348000324331224, 0.7228020506445318, 0.9703174650203437, 0.8350812348071486, 0.5344295417889953, 0.8794529172591865, 0.5522513668984175] }, { kind: 'editField', u: [0.6509293727576733, 0.7839175323024392, 0.7955678380094469, 0.42464192933402956, 0.6151037919335067, 0.8330991917755455, 0.19254334270954132, 0.9538525966927409] }] },
      { kind: 'apply', u: [0.8500000000000001, 0.3223990136757493, 0.25569736980833113, 0.6923409083392471, 0.5388481102418154, 0.8259633409325033, 0.9307957089040428, 0.3583616646938026] },
    ];
    const { res, held } = await uncounted(async () => {
      const before = seen.ownHeld;
      // #1947 re-pinned: the draws above remapped to the targets they picked before a placed instance went last, under the
      // run tag they were recorded with (`RunOpts.runTag`).
      const r = await runOps(be, ops, { ...STRICT, runTag: 0x081500c20000 });
      return { res: r, held: seen.ownHeld - before };
    });
    expect(res.failure, `${res.failure?.check}: ${res.failure?.detail}`).toBeUndefined();
    expect(held).toBeGreaterThan(0);
  }, 120_000);

  // #2034: rule 3 keeps the records under a deleted member, and the old capture drops them — except a row today keeps as
  // an orphan, which it writes back. An Apply that removes the member from the template leaves its `removed` row one,
  // under the deleted member above it; I25 compared it capture-only. Minimized from #2023's hunt seed 1268.
  it('#2034: I25 compares a row the orphan store keeps under a deleted member (hunt seed 1268)', async () => {
    const ops: Op[] = [
      { kind: 'delete', u: [0.43066262220963836, 0.5671485434286296, 0.31415704009123147, 0.7053195766638964, 0.6566344688180834, 0.6918214168399572, 0.13091036188416183, 0.6012136829085648] },
      { kind: 'apply', u: [0.49852385581471026, 0.7594188530929387, 0.6740478533320129, 0.8201011335477233, 0.4186440228950232, 0.3610785307828337, 0.17998847900889814, 0.7364051344338804], check: 'rebuild-reload' },
      { kind: 'delete', u: [0.33927211235277355, 0.5592474001459777, 0.43799786223098636, 0.7623946040403098, 0.018773149931803346, 0.774509527022019, 0.3464857474900782, 0.2845225145574659] },
    ];
    const { res, kept } = await uncounted(async () => {
      const before = s4Seen.removedKeptOrphan;
      const r = await runOps(be, ops, STRICT);
      return { res: r, kept: s4Seen.removedKeptOrphan - before };
    });
    expect(res.failure, `${res.failure?.check}: ${res.failure?.detail}`).toBeUndefined();
    expect(kept).toBeGreaterThan(0);
  }, 60_000);

  // The P1 waivers (#2013, #2015, #2016) TOLERATE, and `claimsOf` reads only `stops`, so their two sides are held here:
  // each tolerates its own shape, and a near miss — another line beside it, the other direction, another leaf — is
  // tolerated by nothing, or a fold regression of a neighbouring shape would pass verify.
  // A reference node inside a PLAIN node the scene added (its `children`) is its own stored instance, and P1 compares it
  // (#2009 review: only the scene-owned list roots were walked; 20 such nodes in the verify seeds went uncompared).
  // Minimized from verify seed 2's first 16 ops.
  it('#2009: P1 by the fold reaches a reference node inside a plain node the scene added', async () => {
    const ops: Op[] = [
      { kind: 'duplicate', u: [0.7858669895213097, 0.20154535141773522, 0.42422566725872457, 0.8349974474404007, 0.5813204094301909, 0.14100669883191586, 0.6722272289916873, 0.3666982688009739] },
      { kind: 'prefabEdit', u: [0.9884103999938816, 0.23279935983009636, 0.4679630333557725, 0.3482415771577507, 0.05263609322719276, 0.5212198328226805, 0.09536325954832137, 0.05781813757494092], inner: [{ kind: 'undo', u: [0.0006261211819946766, 0.9820793268736452, 0.07251844787970185, 0.9723730375990272, 0.5273911911062896, 0.19475854956544936, 0.6778920909855515, 0.05147860595025122] }, { kind: 'undo', u: [0.911587618291378, 0.8271304324734956, 0.4456692119129002, 0.9488384739961475, 0.07114801253192127, 0.7140970125328749, 0.98002965352498, 0.8388770050369203] }, { kind: 'instantiate', u: [0.524419940309599, 0.03313548816367984, 0.8487747020553797, 0.838832515059039, 0.5479850363917649, 0.3125023730099201, 0.9025776439812034, 0.9283567571546882] }, { kind: 'duplicate', u: [0.34926888695918024, 0.018448069458827376, 0.9523306582123041, 0.3133497319649905, 0.4382534313481301, 0.7991957627236843, 0.8673769375309348, 0.9195172667969018] }] },
      { kind: 'addChild', u: [0.2070961082354188, 0.6462242810521275, 0.6241721531841904, 0.713208394125104, 0.9380248752422631, 0.2051396605093032, 0.2788457141723484, 0.3453041734173894] },
      { kind: 'duplicate', u: [0.20850570825859904, 0.059333223616704345, 0.6751196074765176, 0.6820617744233459, 0.5880381965544075, 0.789034377085045, 0.37132780719548464, 0.85833081882447] },
      { kind: 'instantiate', u: [0.674173641949892, 0.6865298799239099, 0.8570264051668346, 0.1643060555215925, 0.5510812881402671, 0.1839873620774597, 0.39782143314369023, 0.3698480911552906] },
    ];
    const { res, grew } = await uncounted(async () => {
      const before = Object.fromEntries(checksRun);
      const r = await runOps(be, ops, STRICT);
      return { res: r, grew: Object.keys(Object.fromEntries(checksRun)).filter((k) => checksRun.get(k)! > (before[k] ?? 0)) };
    });
    expect(res.failure, `${res.failure?.check}: ${res.failure?.detail}`).toBeUndefined();
    expect(grew).toContain('P1 by the fold: a reference node inside a plain added node');
  }, 60_000);

  // The counter counts a comparison that RAN, not an instance found (#2009 re-review: moved back to discovery, every
  // verify count stayed the same, because every instance found there is compared). An instance with no live root is
  // found and not compared.
  it('#2009: P1 by the fold counts no comparison for a stored instance it could not compare', async () => {
    const ops: Op[] = [
      { kind: 'duplicate', u: [0.7858669895213097, 0.20154535141773522, 0.42422566725872457, 0.8349974474404007, 0.5813204094301909, 0.14100669883191586, 0.6722272289916873, 0.3666982688009739] },
      { kind: 'prefabEdit', u: [0.9884103999938816, 0.23279935983009636, 0.4679630333557725, 0.3482415771577507, 0.05263609322719276, 0.5212198328226805, 0.09536325954832137, 0.05781813757494092], inner: [{ kind: 'undo', u: [0.0006261211819946766, 0.9820793268736452, 0.07251844787970185, 0.9723730375990272, 0.5273911911062896, 0.19475854956544936, 0.6778920909855515, 0.05147860595025122] }, { kind: 'undo', u: [0.911587618291378, 0.8271304324734956, 0.4456692119129002, 0.9488384739961475, 0.07114801253192127, 0.7140970125328749, 0.98002965352498, 0.8388770050369203] }, { kind: 'instantiate', u: [0.524419940309599, 0.03313548816367984, 0.8487747020553797, 0.838832515059039, 0.5479850363917649, 0.3125023730099201, 0.9025776439812034, 0.9283567571546882] }, { kind: 'duplicate', u: [0.34926888695918024, 0.018448069458827376, 0.9523306582123041, 0.3133497319649905, 0.4382534313481301, 0.7991957627236843, 0.8673769375309348, 0.9195172667969018] }] },
      { kind: 'addChild', u: [0.2070961082354188, 0.6462242810521275, 0.6241721531841904, 0.713208394125104, 0.9380248752422631, 0.2051396605093032, 0.2788457141723484, 0.3453041734173894] },
      { kind: 'duplicate', u: [0.20850570825859904, 0.059333223616704345, 0.6751196074765176, 0.6820617744233459, 0.5880381965544075, 0.789034377085045, 0.37132780719548464, 0.85833081882447] },
      { kind: 'instantiate', u: [0.674173641949892, 0.6865298799239099, 0.8570264051668346, 0.1643060555215925, 0.5510812881402671, 0.1839873620774597, 0.39782143314369023, 0.3698480911552906] },
    ];
    await uncounted(async () => {
      await runOps(be, ops, STRICT);
      const scene = await serializeScene() as { entities?: SceneEntityEntry[] };
      const stored = (scene.entities ?? []).filter((e) => e.prefab && e.guid);
      expect(stored.length).toBeGreaterThan(0);
      const rootless = { ...scene, entities: stored.map((e) => ({ ...e, guid: `${e.guid!.slice(0, -4)}dead` })) };
      const before = checksRun.get('P1 by the fold') ?? 0;
      const out = foldCheck(be, rootless);
      expect(out.filter((f) => f.check === 'P1 a stored instance has no live root')).toHaveLength(stored.length);
      expect(checksRun.get('P1 by the fold') ?? 0).toBe(before);
    });
  }, 60_000);

  it('KNOWN_OPEN\'s P1 waivers tolerate their own shapes and nothing near them (#2013, #1931; #2015-#2018 fixed by #2007\'s close-out)', () => {
    const g = 'aaaaaaaa-0000-4000-8000-000000000001';
    const P1 = (lines: string[]) => ({ check: 'P1 the live instance is not the fold of its record', detail: `${g} ${lines.join(' ; ')}` });
    const who = (f: { check: string; detail: string }) => KNOWN_OPEN.filter((k) => k.tolerates?.(f)).map((k) => k.issue);
    const moved = 'parent /R/A: fold {"key":"/R"} live {"key":"/R/QR/M"}';
    // Accept: each shape, alone and repeated.
    expect(who(P1(['kept-only unused /R/A removed (applied)', 'kept-only unused /R/B removed (applied)']))).toEqual([2013]);
    // #1931 member 1: a kept link the fold links at its template-added row, and after its node is deleted, the record's
    // link there to exactly that guid.
    const link = 'kept-only unused /R/a+K own (applied g1)';
    expect(who(P1([link, 'kept-only unused /R/a+L own (applied g2)']))).toEqual([1931]);
    expect(who(P1(['anchors /R/a+K: fold ["g1"] live []', link]))).toEqual([1931]);
    expect(who(P1(['anchors /R/a+K: fold ["g1","g2"] live ["g2"]', link]))).toEqual([1931]);
    expect(who(P1(['anchors /R/a+K: fold ["g1","g2"] live []', link, 'kept-only unused /R/a+K own (applied g2)']))).toEqual([1931]);
    // Reject: nothing tolerates these — the fixed waivers' old shapes included, so a regression of #2015-#2018 goes red.
    for (const lines of [
      [moved, 'parent /A: fold {"key":"/"} live {"key":"/QR/M"}'],
      ['fold-only unused / legacy (gone)'],
      ['anchors /F/a+X: fold ["g1","g1"] live ["g1"]'],
      ['kept-only unused /R/A own (unprojected)', 'kept-only unused /R/QR own (unprojected)'],
      ['kept-only unused /R/A -Rotate3D'], // another kept leaf: B1, the oracle's own fix
      ['kept-only unused /R/A own (unprojected)', 'kept-only unused /R/B removed (applied)'], // #2018's beside #2013's: neither waiver's whole
      ['kept-only unused /R/A own'], // an own link lost on a PROJECTED member: not #2018's mechanism
      ['kept-only unused (legacy) own'], // a kept legacy channel's: another route
      ['kept-only unused /R/A removed'], // a removal the fold did NOT apply
      ['kept-only unused /R/A removed (applied)', 'fold-only node /R/X'], // #2013's shape beside a node the fold has and today lacks
      ['parent /R/A: fold {"key":"/R/QR/M"} live {"key":"/R"}'], // the other direction: the fold deeper than today
      ['parent /R/A: fold {"key":"/R/QR"} live {"key":"/R/QRX/M"}'], // a sibling whose key only shares a prefix
      ['parent /R/A: fold {"key":"/R"} live {"guid":"bbbbbbbb-0000-4000-8000-000000000001"}'], // today parented outside the instance
      [moved, 'kept-only unused /R/A removed (applied)'], // #2015's shape beside #2013's: two mechanisms, neither waiver's whole
      ['parent /R/A: fold {"key":"/R"} live {"key":"/R/B"}'], // one level deeper: a sibling, not a nested instance's member
      ['fold-only unused /R/A legacy (unresolved)'], // another cause
      ['fold-only unused /R/a+X legacy (gone)'], // keyed at the node: #2016's fix that left the cause, not #2016
      ['fold-only unused /R/A removed (gone)'], // another leaf
      ['anchors /F/a+X: fold ["g1","g2"] live ["g1"]'], // a node the fold has and today lacks, not a repeat
      ['anchors /F/a+X: fold ["g1"] live ["g1","g1"]'], // the other direction
      ['anchors /F/a+X: fold ["g1","g1"] live ["g2"]'], // a repeat of a guid today does not anchor there
      ['anchors /R/a+K: fold ["g1"] live []'], // a link the fold has and today lacks, with no kept row restating it (#2023's A)
      ['anchors /R/a+L: fold ["g1"] live []', 'kept-only unused /R/a+K own (applied g1)'], // the anchors at ANOTHER row
      ['anchors /R/a+K: fold [] live ["g1"]', 'kept-only unused /R/a+K own (applied g1)'], // today has a node the fold lacks
      ['anchors /R/a+K: fold ["g1"] live ["g1"]', 'kept-only unused /R/a+K own (applied g1)'], // nothing added (not a line the oracle prints)
      ['anchors /R/a+K: fold ["g1"] live ["g2"]', 'kept-only unused /R/a+K own (applied g1)'], // a guid today anchors that the fold does not
      ['anchors /R/a+K: fold ["g1","g2"] live ["g1"]', 'kept-only unused /R/a+K own (applied g1)'], // ANOTHER node lost at that row
      ['anchors /R/a+K: fold ["g1","g1"] live ["g1"]', 'kept-only unused /R/a+K own (applied g1)'], // the fold anchors the shown link twice
      ['anchors /R/a+K: fold ["g1","g2","g3"] live []', 'kept-only unused /R/a+K own (applied g1)'], // three lost, one kept
      ['kept-only unused /R/a+K own (applied)'], // no guid named: nothing to tie an anchors line to
      ['kept-only unused /R/bbbbbbbb-0000-4000-8000-000000000009 own (applied g1)'], // a MEMBER row: another orphan test
      ['kept-only unused / own (applied g1)'], // the instance root
      ['kept-only unused /R/a+K own (applied g1)', 'kept-only unused /R/B removed (applied)'], // #2013's beside #1931's: neither waiver's whole
      ['kept-only unused /R/a+K own (applied g1)', 'fold-only node /R/X'], // #1931's beside a node the fold has and today lacks
    ]) expect(who(P1(lines)), lines.join(' ; ')).toEqual([]);
    // Another check with a waiver's detail is not the waiver's.
    expect(who({ check: 'save→reload is not the identity', detail: `${g} kept-only unused own` })).toEqual([]);
  });

  // #2061: the end-of-run respawn check names ONE diff, so a KNOWN_OPEN entry tolerating it sets that diff aside and the
  // comparison runs again. Mutations: return null once a diff is tolerated (the whole check tolerated) — the first
  // expectation goes red; set aside an entity one side lacks — the last one does.
  it('a tolerated no-op-rebuild diff hides no diff behind it (#2061)', () => {
    const before = { a: { traits: { EntityAttributes: { name: 'C' } } }, b: { traits: { Transform: { x: 1 } } } };
    const after = { a: { traits: { EntityAttributes: { name: 'QR' } } }, b: { traits: { Transform: { x: 2 } } } };
    const byName = (f: { detail: string }) => f.detail.includes('/EntityAttributes/name: ');
    expect(firstUntoleratedDiff(before, after, 'c', byName)?.detail).toMatch(/^\/b\/traits\/Transform\/x: /);
    expect(firstUntoleratedDiff(before, { ...after, b: before.b }, 'c', byName)).toBeNull();
    expect(firstUntoleratedDiff(before, after, 'c')?.detail).toMatch(/^\/a\/traits\/EntityAttributes\/name: /);
    expect(after.a.traits.EntityAttributes.name, 'the caller\'s tree is not mutated').toBe('QR');
    expect(before.a.traits.EntityAttributes.name, 'nor is the side it reads from').toBe('C');
    expect(firstUntoleratedDiff(before, { b: before.b }, 'c', () => true)?.detail).toMatch(/^\/a: /);
  });

  it('KNOWN_OPEN claims no failure of a mechanism it does not name (#1777\'s shape, and regressions planted in review)', () => {
    // Generic failures on entities no drop, paste, detach or Create Prefab of the run touched: nothing may claim them, or
    // a regression would pass verify. #1777's duplicate inside one frame, values and marks that differ across a reload,
    // a lost, gained or placeholder'd entity of a live prefab, the review's planted regressions (a redo that loses an
    // override, an undo that loses a mark, a redo that misplaces a node), and a re-tag refusal logged for another tree —
    // each was once claimed by a predicate keyed on the check and the op list.
    const kinds: Op['kind'][] = ['createPrefab', 'detach', 'reparent', 'instantiate', 'removeComponent', 'undo', 'trashPrefab', 'saveReload', 'apply',
      'copy', 'cut', 'paste', 'delete', 'duplicate', 'editField', 'addComponent', 'addChild', 'prefabEdit', 'outsideEdit', 'renamePrefab', 'redo', 'revert',
      // #2009's doors: a stop keyed on "a fileMutate ran" claimed a generic mark gained on reload until they were listed (review).
      'agentSetTraits', 'agentInstantiate', 'agentSceneOps', 'fileMutate', 'playStop', 'timelinePreview'];
    const op = (kind: Op['kind']) => ({ kind, u: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] });
    // Every op kind, ending in each op a stop keys "last" on, and with each op a stop keys "no …" on left out — so a
    // last-op or negative clause cannot be what keeps a generic failure unclaimed (review: with one list ending in
    // revert and holding every kind, loosening such a clause left this test green).
    const lists: Op[][] = [];
    for (const end of ['revert', 'undo', 'apply', 'paste'] as const) {
      for (const omit of [[], ['detach'], ['trashPrefab'], ['undo'], ['instantiate'], ['detach', 'trashPrefab', 'undo', 'instantiate']] as Op['kind'][][]) {
        if (omit.includes(end)) continue;
        lists.push([...kinds.filter((k) => k !== end && !omit.includes(k)), end].map(op));
      }
    }
    const walk = 'undo/redo to the ends';
    const retag = '[Prefab] not tagging "/fuzz/r0/prefabs/A.prefab.json" — the live tree no longer matches the prefab just written ("B" was written at localId 5, but sits where row 4 was written)';
    const generic = (ops: Op[]) => {
      // Each failure's run DID drop, paste, detach and Create Prefab — other entities than the one it is on, so a stop
      // keyed on "an op of that kind ran" rather than on the entity is caught (review: a touchedBy weakened that way
      // stayed green while every generic failure had no touched set at all).
      const other = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
      // #2009's two too (review: with them absent, a stop keyed on "some file-direct write wrote anything" stayed green).
      const touched = { drop: [other(1)], paste: [other(2)], detach: [other(3)], create: [other(4)], fileDirect: [other(6)], agent: [other(7)] };
      const f = (check: string, detail: string, at = 'revert(0.500)', extra: Partial<StepFailure> = {}) => ({ check, detail, op: at, step: ops.length - 1, touched, moved: true, ...extra });
      return [
        f('I7 duplicate guid', 'G held by M, M (under one top-level root; rows of one frame)'),
        f('save→reload is not the identity', '/aaaaaaaa-0000-4000-8000-000000000001/traits/Transform/x: 1 vs 2', 'saveReload(0.5)'),
        f('save→reload is not the identity', '/aaaaaaaa-0000-4000-8000-000000000001/marks/0: "Transform.x" vs undefined', 'saveReload(0.5)'),
        f('save→reload is not the identity', '/aaaaaaaa-0000-4000-8000-000000000001/marks/0: undefined vs "Transform.x"', 'saveReload(0.5)'),
        f('save→reload is not the identity', '/aaaaaaaa-0000-4000-8000-000000000001: {"traits":{"Transform":{"x":1}}} vs undefined (an entity was lost)', 'saveReload(0.5)'),
        f('save→reload is not the identity', '/aaaaaaaa-0000-4000-8000-000000000001: undefined vs {"traits":{"Transform":{"x":1}}} (an entity was gained)', 'saveReload(0.5)'),
        f('save→reload is not the identity', '/aaaaaaaa-0000-4000-8000-000000000001/marks/0: "Transform.x" vs undefined (it came back a Missing Prefab placeholder)', 'saveReload(0.5)'),
        f('redo to the end does not restore the scene', `/entities/${other(1)}/members//aaaaaaaa-0000-4000-8000-000000000002/traits: {"Transform":{"sx":-3}} vs undefined`, walk),
        f('undo to the start does not restore the scene', `/entities/${other(1)}/members//aaaaaaaa-0000-4000-8000-000000000002/traits: {"Transform":{"sx":-3}} vs undefined`, walk),
        f('redo to the end does not restore the scene', `/entities/${other(4)}/added: [{"parentLocalId":1,"guid":"aaaaaaaa-0000-4000-8000-000000000003"}] vs undefined`, walk),
        f('redo to the end does not restore the scene', `/entities/${other(4)}/added: [{"parentLocalId":1,"guid":"aaaaaaaa-0000-4000-8000-000000000003"}] vs undefined`, walk, { console: [retag] }),
        // A drop's own node LOST or replaced by a redo (not moved): #1793 moves a node, this is a different regression.
        f('redo to the end does not restore the scene', `/entities/${other(5)}/added: [{"parentLocalId":1,"guid":"${other(1)}"}] vs undefined`, walk, { moved: false }),
        f('redo to the end does not restore the scene', `/entities/${other(1)}: {"prefab":"p","guid":"${other(1)}"} vs undefined`, walk, { moved: false }),
        // A node moved INSIDE a dropped entry, or a plain entry re-parented OUT of one: the drop is in the path or the
        // value, not the thing that moved (review: keyed on any guid named, #1793 claimed both).
        f('redo to the end does not restore the scene', `/entities/${other(1)}/added: [{"parentLocalId":1,"guid":"aaaaaaaa-0000-4000-8000-000000000006"}] vs undefined`, walk),
        f('redo to the end does not restore the scene', `/entities/aaaaaaaa-0000-4000-8000-000000000007/traits/EntityAttributes/parentId: "${other(1)}" vs "aaaaaaaa-0000-4000-8000-000000000008"`, walk),
        // A lost top-level entity no drop touched.
        f('redo to the end does not restore the scene', '/entities/aaaaaaaa-0000-4000-8000-000000000005: {"traits":{}} vs undefined', walk),
        f('undo to the start does not restore the scene', '/entities/aaaaaaaa-0000-4000-8000-000000000005: {"traits":{}} vs undefined', walk),
        // #2009 review: a composite that half-applied because a sub's GUARD refused (not ruling R), in both forms, and one
        // whose failed sub threw. (#2010's retired stop was about ruling R only; these stay as the reject side.)
        f('undo threw', 'Set Traits: 1 of 2 sub-action(s) failed during undo: "Edit Transform.x" refused (/fuzz/r0/prefabs/R.prefab.json is not what this step left there)', walk),
        f('op threw', 'undo "Set Traits" threw: 1 of 2 sub-action(s) failed during undo: "Edit Transform.x" refused (/fuzz/r0/prefabs/R.prefab.json is not what this step left there) |     at x', 'undo(0.5)'),
        f('undo threw', 'Mutate Scene (2 ops): 1 of 2 sub-action(s) failed during undo: "M905" threw (boom)', walk),
        // A CORE trait's mark gained on the very entry a file-direct write wrote: never a partially stated added component.
        f('save→reload is not the identity', `/${other(6)}/marks/0: undefined vs "Transform.x"`, 'saveReload(0.5)'),
        // …and an added component's mark gained on an entity NO file-direct write wrote, while one wrote another (review:
        // a stop keyed on "some file-direct write wrote anything" passed the Transform fixtures, which the trait clause rejects).
        f('save→reload is not the identity', '/aaaaaaaa-0000-4000-8000-000000000001/marks/0: undefined vs "Rotate3D.axis"', 'saveReload(0.5)'),
        // Two failed subs, the FIRST under ruling R: every one must be (review: `some`, or reading the first sub only, passed).
        f('undo threw', 'Set Traits: 2 of 3 sub-action(s) failed during undo: "A" refused ("A" is no longer in the scene); "B" refused (/fuzz/r0/prefabs/R.prefab.json is not what this step left there)', walk),
        f('undo threw', 'Set Traits: 2 of 3 sub-action(s) failed during undo: "A" refused ("A" is no longer in the scene); "B" threw (boom)', walk),
      ];
    };
    // Fixture stops planted beside the real entries, so the matcher is exercised while KNOWN_OPEN is empty: #1777's shape
    // (a paste that duplicates its own node inside one frame, keyed on the check, the pasted entity and the op, as a real
    // entry is), #1792's (a duplicate after a detach, keyed on the detail and the op alone, so only the op-window cut keeps
    // it off a later detach), and an entry without a `stops` (it must claim nothing).
    const pasteDup: KnownOpen = {
      issue: -1777, what: 'fixture: a paste duplicates its own node inside one frame', repro: [], reproduces: () => false,
      stops: (f, ops) => f.check === 'I7 duplicate guid' && /rows of one frame\)$/.test(f.detail) && !/not rows/.test(f.detail)
        && ops.some((o) => o.kind === 'paste') && (f.touched?.paste ?? []).some((g) => f.detail.startsWith(`${g} held by`)),
    };
    const afterDetach: KnownOpen = {
      issue: -1792, what: 'fixture: a duplicate after a detach', repro: [], reproduces: () => false,
      stops: (f, ops) => f.check === 'I7 duplicate guid' && /not rows of one frame/.test(f.detail) && ops.some((o) => o.kind === 'detach'),
    };
    const noStop: KnownOpen = { issue: -1, what: 'fixture: an entry with no stop', repro: [], reproduces: () => true };
    const list = [...KNOWN_OPEN, pasteDup, afterDetach, noStop];
    const at = (kind: Op['kind']) => ({ kind, u: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] });
    const pasted = 'bbbbbbbb-0000-4000-8000-000000000002';
    // Accept side: each fixture claims its own failure, and no other fixture does. Only the planted claims are compared: a
    // real entry for one of these mechanisms, should one reopen, rightly claims the fixture's failure too (review).
    const plantedClaims = (ks: KnownOpen[]) => ks.filter((k) => k.issue < 0).map((k) => k.issue);
    const ownDup = (step: number): StepFailure => ({ check: 'I7 duplicate guid', detail: `${pasted} held by M, M (under one top-level root; rows of one frame)`, op: 'paste(0.500)', step, touched: { drop: [], paste: [pasted], detach: [], create: [] } });
    for (const ops of lists) expect(plantedClaims(claimsOf(ownDup(ops.length - 1), ops, list)), ops.map((o) => o.kind).slice(-3).join(', ')).toEqual([pasteDup.issue]);
    const early = [at('detach'), at('revert')];
    const detachDup: StepFailure = { check: 'I7 duplicate guid', detail: 'G held by R, R (under one top-level root; not rows of one frame)', op: 'revert(0.500)', step: 1 };
    expect(plantedClaims(claimsOf(detachDup, early, list))).toEqual([afterDetach.issue]);
    // Every claimant, not the first: the per-entry reject side reads the rest ("also claimed by"), so a matcher that
    // stopped at the first would leave it blind to a later entry claiming the same repro (review).
    const twin: KnownOpen = { ...afterDetach, issue: -17920, what: 'fixture: a second entry claiming the same duplicate' };
    expect(plantedClaims(claimsOf(detachDup, early, [...list, twin]))).toEqual([afterDetach.issue, twin.issue]);
    // Refuse side: no stop, real or planted, claims a generic failure.
    for (const ops of lists) for (const g of generic(ops)) {
      expect(knownStop(g, ops, list)?.issue, `${g.check}: ${g.detail} after ${ops.map((o) => o.kind).slice(-3).join(', ')}`).toBeUndefined();
    }
    // And only the ops BEFORE the failure count: a #1792-shaped duplicate at step 0 whose detach runs later is unclaimed.
    const late = [at('revert'), at('detach')];
    expect(knownStop({ check: 'I7 duplicate guid', detail: 'G held by R, R (under one top-level root; not rows of one frame)', op: 'revert(0.500)', step: 0 }, late, list)).toBeUndefined();
  });
});
