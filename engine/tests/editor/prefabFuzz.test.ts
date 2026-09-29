/** #1789 — the prefab randomized round-trip test: seeded op sequences through the editor's real entry points, the
 *  model's invariants after every step, save→reload and undo identities, and shrinking repros.
 *
 *  Each run starts from #1707's fixture (three-deep nesting through every channel a template row carries) in a scene,
 *  then runs a seeded list of ops (`prefabFuzz/ops.ts`): create prefab (and Replace), instantiate (and nest), detach,
 *  duplicate, copy/cut/paste, delete, field edits, add/remove component, add child, reparent, Apply (all, a component,
 *  a key; the default or another target), Revert, prefab edit (open, inner ops, save or discard, exit), undo/redo, save
 *  → reload, trash/rename a prefab file, and an outside edit of one. After every step: I4, I5, I6, I7, I8, I15, I16,
 *  I18 and both validators (`prefabFuzz/checks.ts`); every save→reload is the identity and a second save is
 *  byte-identical; the run ends with a save→reload, then undo to the segment's start (the bytes it began with), then
 *  redo to the end. Any console.error the EXPECTED_ERRORS list does not name fails the step.
 *
 *  Modes:
 *  - `npm run verify`: VERIFY_SEEDS, fixed, a few seconds.
 *  - `MODOKI_PREFAB_FUZZ=<n>` (optional `MODOKI_PREFAB_FUZZ_SEED=<first>`, `MODOKI_PREFAB_FUZZ_LEN=<ops>`): n seeds, for
 *    long hunts. Every distinct failure is shrunk and printed with its seed and a paste-ready replay.
 *  - `MODOKI_PREFAB_FUZZ_REPLAY='<json op list>'`: run exactly that list.
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
 *  - Play mode, previews and Transient subtrees (I12, I13) are never entered.
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
 *  REACH, measured by putting fixed bugs back (docs/prefabs.md § "The randomized round-trip test" has the table): #1756,
 *  #1446 and #1709 fail inside the verify seeds; #1774, #1751 F1 and #1737 only in a 150-seed hunt (#1751 F1 only
 *  through apply's directed move-then-Apply branch, which was ADDED to reach the member-paths route #1751 F1 lives on);
 *  #1777 is not re-found (reusing a number needs a hand edit below the mark, or #1782's rebuilders); #1741 is
 *  unreachable (one scene). The weights were not tuned against these; the generator changes are in the doc. */

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
import { boot, bridge, memoryStorage, flushWatcher } from './prefabFuzz/harness';
import { generate, describe as describeOp, type Op } from './prefabFuzz/ops';
import { runOps, shrink, consoleErrors, opOutcomes, taintCounts, skippedChecks, diffFiles, rebaseForFileOp, trashedPrefabReferenced, newlySwallowed, type RunResult, type StepFailure } from './prefabFuzz/runner';
import { KNOWN_OPEN, REGRESSIONS } from './prefabFuzz/knownOpen';
import { signature, checkRoundTrip, firstDiff, nodeMoved } from './prefabFuzz/checks';
import { newGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { setRunMode } from '@modoki/engine/runtime';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

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
      + '(#1664, #1679, `prefabRestoreRefusal`). A refusal in a segment nothing outside the stack touched still fails, as '
      + '"undo refused in a clean segment"',
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
    pattern: /^\[undo\] (Undo|Redo) of ".*" was REFUSED — "[^"]*"( \([^)]*\))? (is a Missing Prefab now|is no longer in the scene|is not a Missing Prefab any more|is no longer an instance of|is no longer a prefab instance|is a prefab instance again)/,
    why: 'owner ruling R (#1819, #1827, #1793, 2026-09-29): an undo or redo whose target no longer resolves, or has become '
      + 'a Missing Prefab placeholder, refuses before any change and is dropped (`require`, entityRef.ts), and says so. A '
      + 'refusal in a segment where no placeholder was expanded and nothing outside the stack touched still fails, as '
      + '"undo/redo refused in a clean segment"',
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

const VERIFY_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const VERIFY_LEN = 25;

const OPTS = { expectedError };

/** The KNOWN_OPEN entry whose `stops` predicate claims this failure, if any. A predicate sees only the ops that ran up to
 *  the failing step: judged on the whole list, an op AFTER the failure satisfied an op-shape clause (review). */
const knownStop = (f: StepFailure, ops: readonly Op[]) => KNOWN_OPEN.find((k) => k.stops?.(f, ops.slice(0, f.step + 1)));

async function shrunk(seed: number | string, ops: Op[], r: RunResult): Promise<{ text: string; min: Op[]; minFailure?: StepFailure }> {
  const f = r.failure!;
  const sig = signature(f);
  const { ops: min, replays } = await shrink(be, ops, sig, OPTS);
  const final = await runOps(be, min, OPTS);
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
      const r = await runOps(be, ops, OPTS);
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
      realError(`\ncoverage — ops: ${tally(opOutcomes)}\nroutes: ${tally(be.routeCounts)}\n`);
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

  // #1845: what the taints turned off, said on every verify run, so a platform where it grows is visible. A report, not a
  // test: the cause list is closed by its type, and the guard is the "unexpected outside write" self-test below.
  afterAll(() => {
    const tally = (m: Map<string, number>) => [...m].sort().map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    process.stderr.write(`[prefabFuzz] verify run — taints: ${tally(taintCounts)}; checks skipped: ${tally(skippedChecks)}\n`);
  });

  for (const r of REGRESSIONS) {
    it(`regression #${r.issue}: ${r.what}`, async () => {
      const res = await runOps(be, r.repro, OPTS);
      expect(res.failure, res.failure ? `${res.failure.check}: ${res.failure.detail}` : '').toBeUndefined();
    }, 60_000);
  }

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
      const r = await runOps(be, k.repro, OPTS);
      expect(r.failure, `#${k.issue} no longer reproduces: if it is fixed, delete its KNOWN_OPEN entry`).toBeDefined();
      expect(k.reproduces(r.failure!), `#${k.issue}'s repro now fails differently: ${r.failure!.check} — ${r.failure!.detail}`).toBe(true);
      if (k.stops) expect(knownStop(r.failure!, k.repro)?.issue, `#${k.issue}'s stop predicate does not claim its own repro`).toBe(k.issue);
      // The reject side: no OTHER issue's entry claims this failure — each predicate is one mechanism's, not a family's
      // (a second route of one issue is its own entry, with its own repro).
      const others = KNOWN_OPEN.filter((o) => o.issue !== k.issue && o.stops?.(r.failure!, k.repro.slice(0, r.failure!.step + 1))).map((o) => o.issue);
      expect(others, `#${k.issue}'s repro is also claimed by ${others.join(', ')}`).toEqual([]);
    }, 60_000);
  }

  // #1840: the watcher looked marks up by a string it built from the url, which on Windows never matched the route's
  // `\`-separated path, so every editor write reloaded under the op and tainted its segment — the undo identity and the
  // clean-segment refusal checks never ran there: 32 KNOWN_OPEN repros ran clean, and #1805 route 2 lost its reach.
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
    const add = be.marked.add;
    be.marked.add = function (this: Set<string>) { return this; } as typeof add;
    let r: RunResult;
    try { r = await runOps(be, ops, OPTS); } finally { be.marked.add = add; }
    expect(r.failure?.check).toBe('unexpected outside write');
    expect(r.failure?.detail).toMatch(/after op \d+ \(.*\): the watcher raised a write that no outside edit made/);

    const outside = ops.find((o) => o.kind === 'outsideEdit') ?? { kind: 'outsideEdit', u: [0.1, 0.2, 0.3, 0.2, 0.5, 0.5, 0.5, 0.5] } as Op;
    const before = taintCounts.get('outsideEdit') ?? 0;
    const ok = await runOps(be, [outside], OPTS);
    expect(ok.failure, ok.failure ? `${ok.failure.check}: ${ok.failure.detail}` : '').toBeUndefined();
    expect(ok.trace.join(' '), 'premise: the outside edit wrote a file').toMatch(/outsideEdit.* → done/);
    expect(taintCounts.get('outsideEdit') ?? 0).toBe(before + 1);
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

  // #1838: the round trip holds a rotation as ONE value, an orientation (#1490's rule), not three numbers.
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
    const claims = shapes.flatMap((ops) => planted(ops).flatMap((f) => KNOWN_OPEN.filter((k) => k.stops?.(f, ops)).map((k) => `#${k.issue} claims ${f.check} after ${ops.map((o) => o.kind).join(',')}`)));
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

  // #1805: a live instance of a DELETED prefab stays expanded while a reload gives its Missing Prefab placeholder (Unity does
  // the same), so a round trip is judged against the save reloaded with the deleted prefab put back (`saveReload`), and a
  // run fails only when neither comparison holds (`checkRoundTrip`). Loss stays visible: with #1812's record read taken
  // out, the #1812 regressions go red through the restored comparison.
  it('harness: the round trip of a deleted prefab — plain or restored identity passes, neither fails (#1805)', () => {
    const live = { a: { traits: { X: 1 } }, m: { traits: { Y: 2 } } };
    const placeholder = { a: { traits: { X: 1 } }, unresolvedEntry: { unresolved: 'p' } };
    const same = { firstBytes: '{}', secondBytes: '{}' };
    expect(checkRoundTrip({ before: live, after: placeholder, restored: live, ...same })).toEqual([]); // restored holds
    expect(checkRoundTrip({ before: placeholder, after: placeholder, restored: live, ...same })).toEqual([]); // plain holds
    const lost = checkRoundTrip({ before: live, after: placeholder, restored: { a: live.a }, ...same });
    expect(lost.map((f) => f.check)).toEqual(['save→reload is not the identity']);
    expect(lost[0]!.detail).toMatch(/\(with the deleted prefab restored\)$/);
    // No deletion: the plain comparison, as before.
    expect(checkRoundTrip({ before: live, after: placeholder, ...same }).map((f) => f.check)).toEqual(['save→reload is not the identity']);
  });

  // #1831 G1 M1: a live world can hold a KEPT frame of a deleted prefab beside one it could not expand (an unexpanded row,
  // or a placeholder). The plain reload loses the kept frame, and the restored reload expands the other, so neither
  // comparison held. The restored comparison now lets exactly that frame come back expanded. Mutation: in `checkRoundTrip`,
  // compare against `rt.restored` raw — the first expectation goes red.
  it('harness: the restored comparison lets an unexpanded row or a placeholder of a deleted prefab come back expanded, and nothing else (#1831)', () => {
    const same = { firstBytes: '{}', secondBytes: '{}' };
    const gone = (src: string) => src === 'P';
    const ea = (name: string, parentId: string | number = 0) => ({ EntityAttributes: { name, parentId } });
    const pi = (source: string, rootInstanceId: string, extra: Record<string, unknown> = {}) => ({ PrefabInstance: { source, rootInstanceId, ...extra } });
    // Live: a kept P frame K (root k, member km), and O's instance o whose P row (localId 2) is unexpanded.
    const live = {
      k: { traits: { ...ea('R'), ...pi('P', 'k') } }, km: { traits: { ...ea('A', 'k'), ...pi('P', 'k') } },
      o: { traits: { ...ea('OR'), ...pi('O', 'o') } },
    };
    const plain = { o: live.o, kp: { traits: ea('R'), unresolved: 'P' } }; // the plain reload: K a placeholder
    const expandedRow = { n: { traits: { ...ea('R', 'o'), ...pi('P', 'n', { parentLocalId: 2 }) } }, nm: { traits: { ...ea('A', 'n'), ...pi('P', 'n') } }, extra: { traits: ea('Extra', 'nm') } };
    const restored = { ...live, ...expandedRow };
    const unexpanded = new Set(['o:2']);
    expect(checkRoundTrip({ before: live, after: plain, restored, unexpanded, ...same }, gone)).toEqual([]);
    // Reject: the row was NOT recorded unexpanded, so a gained frame is a gained frame.
    expect(checkRoundTrip({ before: live, after: plain, restored, unexpanded: new Set(), ...same }, gone)[0]?.detail).toMatch(/an entity was gained/);
    // Reject: a gained frame of a prefab that is NOT deleted.
    const notGone = { ...live, n: { traits: { ...ea('R', 'o'), ...pi('Q', 'n', { parentLocalId: 2 }) } } };
    expect(checkRoundTrip({ before: live, after: plain, restored: notGone, unexpanded, ...same }, gone)).toHaveLength(1);
    // Reject: the expansion forgiven, but a kept entity changed.
    const changed = { ...restored, km: { traits: { ...ea('A2', 'k'), ...pi('P', 'k') } } };
    expect(checkRoundTrip({ before: live, after: plain, restored: changed, unexpanded, ...same }, gone)[0]?.detail).toMatch(/^\/km\//);
    // A live placeholder of the deleted prefab comes back an instance root of it, with members: compared by placement.
    const livePh = { ...live, ph: { traits: ea('H'), unresolved: 'P' } };
    const back = { ...live, ph: { traits: { ...ea('H'), ...pi('P', 'ph') } }, phm: { traits: { ...ea('A', 'ph'), ...pi('P', 'ph') } } };
    expect(checkRoundTrip({ before: livePh, after: plain, restored: back, unexpanded: new Set(), ...same }, gone)).toEqual([]);
    // Reject: it came back somewhere else (its placement differs).
    const moved = { ...back, ph: { traits: { ...ea('H', 'o'), ...pi('P', 'ph') } } };
    expect(checkRoundTrip({ before: livePh, after: plain, restored: moved, unexpanded: new Set(), ...same }, gone)).toHaveLength(1);
  });

  it('harness: a prefab created and then deleted in one run passes the final round trip (#1805 route 2, allowed)', async () => {
    // Mutation: in `saveReload`, skip the restore (no `restored`) — the plain comparison fails: the live instance is
    // expanded, the reload gives its placeholder.
    const ops: Op[] = [
      { kind: 'instantiate', u: [0.5075831420253962, 0.8186536263674498, 0.4673538957722485, 0.9546289832796901, 0.39170667389407754, 0.5493532461114228, 0.4505586097948253, 0.8853592379018664] },
      { kind: 'duplicate', u: [0.39032594044692814, 0.04696453106589615, 0.3570088869892061, 0.40155923343263566, 0.5113228356931359, 0.29383464995771646, 0.025902038207277656, 0.7472156076692045] },
      { kind: 'createPrefab', u: [0.5959376466926187, 0.9407973305787891, 0.6634466790128499, 0.633407388580963, 0.013036289950832725, 0.15678744250908494, 0.8456963025964797, 0.3821238283999264] },
      { kind: 'trashPrefab', u: [0.3976654135622084, 0.9079436135943979, 0.3005773222539574, 0.4423462732229382, 0.34140314417891204, 0.17301023192703724, 0.8832939309068024, 0.3436738490127027] },
    ];
    const r = await runOps(be, ops, OPTS);
    expect(r.trace.slice(0, 4).every((l) => l.includes('→ done')), r.trace.join('\n')).toBe(true); // precondition: all ran
    // …with the created prefab's instance a placeholder on the plain reload, as production's reload gives: the loader never
    // held it. Mutation: drop the dance's loader restore (`invalidatePrefab` of an entry it seeded) — 0 placeholders.
    expect(r.trace[4], r.failure ? `${r.failure.check}: ${r.failure.detail}` : '').toMatch(/^4: final save→reload → done \(1 deleted prefab\(s\) restored for the comparison; [1-9]\d* placeholder\(s\) on the plain reload\)$/);
    // The round trip passed. The walk after it runs undo against the placeholder the reload made — #1819's class (group 1
    // of #1789: the owner ruled such an undo refuses and drops its step; not built yet), which this test does not judge.
    expect(r.failure === undefined || r.failure.op === 'undo/redo to the ends', r.failure ? `${r.failure.op} — ${r.failure.check}: ${r.failure.detail}` : '').toBe(true);
  }, 120_000);

  it('harness: a run is reproducible — the same list twice gives the same trace and the same outcome', async () => {
    const ops = generate(VERIFY_SEEDS[0], VERIFY_LEN);
    const [a, b] = [await runOps(be, ops, OPTS), await runOps(be, ops, OPTS)];
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

  it('KNOWN_OPEN claims no failure of a mechanism it does not name (#1777\'s shape, and regressions planted in review)', () => {
    // Generic failures on entities no drop, paste, detach or Create Prefab of the run touched: nothing may claim them, or
    // a regression would pass verify. #1777's duplicate inside one frame, values and marks that differ across a reload,
    // a lost, gained or placeholder'd entity of a live prefab, the review's planted regressions (a redo that loses an
    // override, an undo that loses a mark, a redo that misplaces a node), and a re-tag refusal logged for another tree —
    // each was once claimed by a predicate keyed on the check and the op list.
    const kinds: Op['kind'][] = ['createPrefab', 'detach', 'reparent', 'instantiate', 'removeComponent', 'undo', 'trashPrefab', 'saveReload', 'apply',
      'copy', 'cut', 'paste', 'delete', 'duplicate', 'editField', 'addComponent', 'addChild', 'prefabEdit', 'outsideEdit', 'renamePrefab', 'redo', 'revert'];
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
      const touched = { drop: [other(1)], paste: [other(2)], detach: [other(3)], create: [other(4)] };
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
        // A pasted node moved inside a created tree's member row (#1830 keys on the created row, not any node in it).
        f('redo to the end does not restore the scene', `/entities/${other(5)}/members//${other(4)}/added: [{"parentLocalId":1,"guid":"${other(2)}"}] vs undefined`, walk),
        // A lost top-level entity no drop touched.
        f('redo to the end does not restore the scene', '/entities/aaaaaaaa-0000-4000-8000-000000000005: {"traits":{}} vs undefined', walk),
        f('undo to the start does not restore the scene', '/entities/aaaaaaaa-0000-4000-8000-000000000005: {"traits":{}} vs undefined', walk),
      ];
    };
    for (const ops of lists) for (const g of generic(ops)) {
      expect(knownStop(g, ops)?.issue, `${g.check}: ${g.detail} after ${ops.map((o) => o.kind).slice(-3).join(', ')}`).toBeUndefined();
    }
    // And only the ops BEFORE the failure count: a #1792-shaped duplicate at step 0 whose detach runs later is unclaimed.
    const late = [{ kind: 'revert' as const, u: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }, { kind: 'detach' as const, u: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }];
    expect(knownStop({ check: 'I7 duplicate guid', detail: 'G held by R, R (under one top-level root; not rows of one frame)', op: 'revert(0.500)', step: 0 }, late)).toBeUndefined();
  });
});
