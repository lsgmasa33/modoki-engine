/** The prefab fuzzer's runner (#1789): run one op list against a fresh fixture and stop at the first failed check,
 *  and the shrinker that reduces a failing list to a short repro of the same failure. */

import { undoDepth, canRedo, undoStep } from '../../../packages/modoki/src/editor/undo/undoManager';
import { serializeScene } from '../../../packages/modoki/src/editor/scene/serialize';
import { instantiatePrefabInstance } from '../../../packages/modoki/src/editor/scene/prefab';
import { getAllEntities, getCurrentWorld } from '@modoki/engine/runtime';
import { startRun, settle, flushWatcher, editing, piOf, placeholderGuids, unexpandedRows, worldTree, type Fixture } from './harness';
import { execute, describe as describeOp, type Op, type RunState } from './ops';
import { checkWorld, checkFiles, forgetHistoryOf, checkScene, checkRoundTrip, canonScene, firstDiff, nodeMoved, signature, type Failure, type LocalIdHistory, type Tolerate } from './checks';
import type { FuzzBackend } from './backend';
import fs from 'fs';
import { resolveGuidToPath } from '../../../packages/modoki/src/runtime/loaders/assetManifest';
import path from 'path';
import { prefabTextIsDocument } from '../../../packages/modoki/src/editor/scene/prefabCommit';
import type { PrefabFile } from '../../../packages/modoki/src/editor/scene/prefab';

/** `MODOKI_PREFAB_FUZZ_DUMP=<dir>`: write every compared state there, for reading a finding by hand. */
function dump(name: string, value: unknown): void {
  const dir = process.env.MODOKI_PREFAB_FUZZ_DUMP;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export interface StepFailure extends Failure { step: number; op: string }

export interface RunOpts {
  /** A console.error the editor is expected to print; `prev` is the error logged just before it in the same step. */
  expectedError: (msg: string, prev?: string) => boolean;
  tolerate?: Tolerate;
}
export interface RunResult { failure?: StepFailure; trace: string[] }

/** Console errors the run produced; the test file's spy fills it and names what is expected (`expectedError`). */
export const consoleErrors: string[] = [];

/** Per op kind, how often each outcome happened across the process: the hunt reports it as coverage. */
export const opOutcomes = new Map<string, number>();

/** The fixture's last step: Q dropped under the H instance's root, a scene-added reference node (the Hierarchy drop's core). */
async function setupNest(f: Fixture): Promise<void> {
  const host = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; });
  if (!host) throw new Error('harness: fixture has no H instance');
  const q = JSON.parse((await (await fetch(f.prefabs.Q.path)).text()) as string);
  const id = await instantiatePrefabInstance(q, f.prefabs.Q.path, host.id);
  if (!id) throw new Error('harness: could not nest Q under H1');
}

/** Why a segment is TAINTED: a CLOSED list, each a mechanism that legitimately takes the segment out of reach of the
 *  undo stack, so the walk to its start can no longer be held to the bytes (#1845). A taint is what turns the undo-to-start
 *  and redo-to-end identities and the clean-segment refusal checks OFF for the rest of the segment, so an unnamed one is
 *  exactly how #1840 made those checks vacuous on Windows for a day: every editor write read as an outside edit. Anything
 *  that would taint for another reason FAILS the step instead ("unexpected outside write"), and every taint and every
 *  check it skipped is counted (`taintCounts`, `skippedChecks`), so two platforms' hunts can be compared.
 *  - `outsideEdit`: an `outsideEdit` op wrote a prefab file outside the editor (a hand edit, a pull). The simulated
 *    watcher raises it and the editor reloads; the scene's undo entries recorded against that file refuse by design (I10:
 *    each is conditional on the bytes it wrote), and nothing on the stack can put the outside bytes back. This is the ONE
 *    cause a watcher raise may have, and only for the paths the op itself changed.
 *  - `prefabEditSave`: a prefab edit wrote its prefab. That save is made in the EDIT world, on its own stack, which leaving
 *    prefab edit drops (U27, #1704), so the scene's stack cannot undo it; and the scene entries recorded against the file
 *    (Create Prefab's redo, an Apply's undo) refuse after it by the same I10 rule. It is the editor's OWN write, so it is
 *    marked and never raised by the watcher since #1840: the taint comes from the save itself, not from a reload.
 *  - `rulingR`: a world swap expanded as a Missing Prefab placeholder something the stack's entries were recorded against
 *    (owner ruling R, #1819, 2026-09-29): an undo against it refuses and is dropped, by design. Or the swap left a NESTED
 *    frame of a missing prefab unexpanded (#1790 ruling D: the loader records the row and spawns nothing under it), so
 *    the entities the stack recorded inside it are gone rather than placeholders: `require` refuses them the same way
 *    ("is no longer in the scene"), and it is the same ruling (#1849; work-ai3 hunt seeds 6191, 6356).
 *  - `assetDelete`: a Move to Trash of a prefab something the walk must restore still REFERENCES — the scene at the
 *    segment's start or now, or a prefab file then or now (`trashedPrefabReferenced`). It is not undoable (#1868, owner
 *    ruling D2; Unity: "You cannot undo the delete assets action."), so the file stays gone for the walk, and the stack's
 *    entries recorded against it (a respawn from it, a rebuild onto it) refuse after it by the same rule as `rulingR`. A
 *    trash of a prefab nothing references only leaves the baseline (`rebaseForFileOp`), and every check stays on. A
 *    RENAME is never a taint: a scene names a prefab by guid, so the runner only moves the path in the baseline.
 *    ⚠️ Known limit: a prefab only the undo/redo STACK names (placed, then undone, then trashed) is not seen, so its
 *    redo's refusal reads as one in a clean segment — a false finding a hunt would show, never a hidden one. */
export type TaintCause = 'outsideEdit' | 'prefabEditSave' | 'rulingR' | 'assetDelete';

interface Segment { scene: unknown; prefabs: Map<string, string>; tainted: TaintCause | null }

/** Across the process, per cause: how many ops tainted a segment, and how many checks a taint turned off (keyed
 *  `<cause>: <check>`, attributed to the segment's FIRST cause). The hunt prints both. */
export const taintCounts = new Map<TaintCause, number>();
export const skippedChecks = new Map<string, number>();
const skipped = (seg: Segment, check: string) => {
  const k = `${seg.tainted}: ${check}`;
  skippedChecks.set(k, (skippedChecks.get(k) ?? 0) + 1);
};
function taint(seg: Segment, cause: TaintCause): void {
  taintCounts.set(cause, (taintCounts.get(cause) ?? 0) + 1);
  seg.tainted ??= cause;
}

const prefabBytes = (be: FuzzBackend) => new Map([...be.snapshot()].filter(([p]) => p.endsWith('.prefab.json')));

async function segmentHere(be: FuzzBackend): Promise<Segment> {
  return { scene: editing() ? null : await serializeScene(), prefabs: prefabBytes(be), tainted: null };
}

/** An Assets file op leaves undo (#1868, owner ruling D2), so the walk to the segment's start cannot put it back: the
 *  baseline takes it instead. A trash drops the path, a rename moves the bytes to the new path. */
/** Does anything the walk to the segment's start must restore name the trashed prefab — by its guid (the document's
 *  `id`) or its path? `texts`: the scene at the segment's start and now, and every prefab file then and now. */
export function trashedPrefabReferenced(bytes: string | undefined, path: string, texts: Iterable<string>): boolean {
  let id: string | undefined;
  try { id = bytes ? (JSON.parse(bytes) as { id?: string }).id : undefined; } catch { /* unreadable: by path only */ }
  for (const t of texts) if (t.includes(path) || (id && t.includes(id))) return true;
  return false;
}

export function rebaseForFileOp(prefabs: Map<string, string>, op: { from: string; to: string | null }): void {
  const text = prefabs.get(op.from);
  prefabs.delete(op.from);
  if (op.to !== null && text !== undefined) prefabs.set(op.to, text);
}

/** A restored prefab file is the document it held, except for the localId high-water mark: a restore that must raise
 *  `nextLocalId` splices it into the bytes and claims v8 in place (#1774, docs/prefabs.md § "The localId high-water
 *  mark"), so an undo cannot give back the exact bytes by design. Those two fields are set aside; everything else,
 *  formatting included, must match. */
export function diffFiles(a: Map<string, string>, b: Map<string, string>, created?: readonly string[]): string | null {
  const markFree = (t: string) => { const d = JSON.parse(t) as Record<string, unknown>; delete d.nextLocalId; delete d.version; return d; };
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(p) === b.get(p)) continue;
    // A file a Create Prefab made, still there at the segment's start: its undo LEAVES the file (#1795, hub ruling (i),
    // Unity). Only while it holds what a create wrote (the bytes, or the same document under a raised #1774 mark) — a
    // leftover with any other content is a wrong write under a right path, and still a finding (hub review). Matched by
    // DOCUMENT, at any path: a Rename of the new prefab moves it, and the move is not undone by the create's undo (hunt
    // seed 6029, minimized).
    if (a.get(p) === undefined && created?.some((made) => prefabTextIsDocument(b.get(p)!, JSON.parse(made) as PrefabFile))) continue;
    if (a.get(p) === undefined || b.get(p) === undefined) return `${p}: ${a.has(p) ? 'present' : 'absent'} vs ${b.has(p) ? 'present' : 'absent'}`;
    const d = firstDiff(markFree(a.get(p)!), markFree(b.get(p)!));
    if (d) return `${p}: ${d}`;
  }
  return null;
}

/** Undo to the segment's start and compare, then redo to the end and compare. Only a segment nothing outside the
 *  undo stack has touched (an outside edit, a prefab-edit save, a watcher reload) is held to the bytes. */
async function undoIdentity(be: FuzzBackend, seg: Segment, tolerate: Tolerate, created: readonly string[]): Promise<Failure | null> {
  const canon = (scene: unknown) => canonScene(scene, placeholderGuids(), !!tolerate.nodeOrder);
  if (editing()) return null;
  const end = { scene: await serializeScene(), prefabs: prefabBytes(be) };
  let steps = 0;
  for (; steps < 400; steps++) {
    const r = await undoStep('undo');
    await settle();
    if (r.failed && !r.failed.refused) return { check: 'undo threw', detail: `${r.failed.label}: ${r.failed.error}` };
    if (r.refused || r.failed) {
      if (seg.tainted) { skipped(seg, 'undo refusal forgiven (rest of the walk not run)'); return null; }
      return { check: 'undo refused in a clean segment', detail: String(r.refused ?? r.failed!.error) };
    }
    if (!r.did) break;
  }
  if (seg.tainted) skipped(seg, 'undo to the start identity');
  if (!seg.tainted) {
    const back = await serializeScene();
    dump('undo-start', seg.scene); dump('undo-back', back);
    const [ca, cb] = [canon(seg.scene), canon(back)];
    const d = firstDiff(ca, cb);
    if (d) return { check: 'undo to the start does not restore the scene', detail: d, moved: nodeMoved(d, ca, cb) };
    const fd = diffFiles(seg.prefabs, prefabBytes(be), created);
    if (fd) return { check: 'undo to the start does not restore the prefab files', detail: fd };
  }
  for (let i = 0; i < steps; i++) {
    const r = await undoStep('redo');
    await settle();
    if (r.failed && !r.failed.refused) return { check: 'redo threw', detail: `${r.failed.label}: ${r.failed.error}` };
    if (r.refused || r.failed) {
      if (seg.tainted) { skipped(seg, 'redo refusal forgiven (rest of the walk not run)'); return null; }
      return { check: 'redo refused in a clean segment', detail: String(r.refused ?? r.failed!.error) };
    }
  }
  if (seg.tainted) skipped(seg, 'redo to the end identity');
  if (!seg.tainted) {
    const again = await serializeScene();
    dump('redo-end', end.scene); dump('redo-again', again);
    const [ca, cb] = [canon(end.scene), canon(again)];
    const d = firstDiff(ca, cb);
    if (d) return { check: 'redo to the end does not restore the scene', detail: d, moved: nodeMoved(d, ca, cb) };
    const fd = diffFiles(end.prefabs, prefabBytes(be));
    if (fd) return { check: 'redo to the end does not restore the prefab files', detail: fd };
  }
  return null;
}

const FINAL_ROUND_TRIP: Op = { kind: 'saveReload', u: [0, 0, 0, 0, 0, 0, 0, 0] };

/** Run `ops` from a fresh fixture; the first failed check ends the run. */
export async function runOps(be: FuzzBackend, ops: readonly Op[], opts: RunOpts): Promise<RunResult> {
  const tolerate = opts.tolerate ?? {};
  const trace: string[] = [];
  consoleErrors.length = 0;
  const f = await startRun(be, setupNest, JSON.stringify(ops));
  const st: RunState = { be, f, clip: null, touched: { drop: new Set(), paste: new Set(), detach: new Set(), create: new Set() }, prefabBytes: new Map(), created: [] };
  for (const [p, t] of be.snapshot()) if (p.endsWith('.prefab.json')) st.prefabBytes!.set(p, t);
  const history: LocalIdHistory = new Map();
  /** Every file content the run has had, at any path: a write of one of these is a verbatim carry (an undo's restore, a
   *  move), which I15 exempts. */
  const seen = new Set<string>();
  const written = new Set<string>();
  /** Contents an outside edit wrote (a rename or an undo's restore can carry them to another path verbatim). */
  const handTexts = new Set<string>();
  for (const t of be.snapshot().values()) seen.add(t);
  checkFiles(be.snapshot(), history, written); // seed the localId history with the fixture
  let seg = await segmentHere(be);

  const fail = (step: number, op: string, f: Failure): RunResult => ({
    failure: { ...f, step, op, touched: { drop: [...st.touched.drop], paste: [...st.touched.paste], detach: [...st.touched.detach], create: [...st.touched.create] } }, trace,
  });

  const all = [...ops, FINAL_ROUND_TRIP];
  for (let i = 0; i < all.length; i++) {
    const op = all[i];
    const label = i < ops.length ? describeOp(op) : 'final save→reload';
    const before = be.snapshot();
    const placeholdersBefore = editing() ? new Set<string>() : placeholderGuids();
    const unexpandedBefore = editing() ? new Set<string>() : unexpandedRows();
    const worldBefore = getCurrentWorld();
    st.note = undefined;
    st.roundTrip = undefined;
    st.prefabEditSaved = undefined;
    st.fileOp = undefined;
    let outcome: string;
    try {
      outcome = await execute(op, st);
      await settle();
    } catch (e) {
      // The message leads (the signature keys on it); a bare stack left every throw signed "op threw: Error" (review).
      const err = e as Error;
      return fail(i, label, { check: 'op threw', detail: `${err?.message ?? String(e)} | ${String(err?.stack ?? '').split('\n').slice(1, 3).join(' | ')}` });
    }
    let raised: string[];
    try { raised = await flushWatcher(be, before); } catch (e) { return fail(i, label, { check: 'watcher reload threw', detail: String(e) }); }
    // A watcher raise has ONE legitimate cause: an outside edit, of the paths that op itself wrote (#1845). Anything else
    // is a write the router did not mark as the editor's own — the #1840 class (a mark keyed by a string the watcher's
    // lookup never builds) — and it would taint the segment and silently turn the undo checks off. It fails here instead.
    const opWrote = op.kind === 'outsideEdit' ? new Set([...be.snapshot()].filter(([p, t]) => before.get(p) !== t).map(([p]) => p)) : new Set<string>();
    const unexpected = raised.filter((p) => !opWrote.has(p));
    if (unexpected.length) {
      return fail(i, label, { check: 'unexpected outside write', detail: `${unexpected[0]} after op ${i} (${label}): the watcher raised a write that no outside edit made${unexpected.length > 1 ? ` (+${unexpected.length - 1} more)` : ''}` });
    }
    opOutcomes.set(`${op.kind}:${outcome}`, (opOutcomes.get(`${op.kind}:${outcome}`) ?? 0) + 1);
    trace.push(`${i}: ${label} → ${outcome}${st.note ? ` (${st.note})` : ''}${raised.length ? ` [watcher: ${raised.join(', ')}]` : ''}`);

    const logged = consoleErrors.splice(0);
    const errors = logged.filter((m, k, all) => !opts.expectedError(m, all[k - 1]));
    if (errors.length) return fail(i, label, { check: 'console.error', detail: errors[0].slice(0, 300) });

    const after = be.snapshot();
    for (const [p, t] of after) if (p.endsWith('.prefab.json')) st.prefabBytes!.set(p, t);
    for (const [p, t] of after) {
      if (before.get(p) === t) continue;
      // A write the editor made of content no file in the run has had before.
      if (!seen.has(t) && op.kind !== 'outsideEdit') written.add(p); else written.delete(p);
      seen.add(t);
    }
    // Read back through the declared type: the reset above narrows `st.roundTrip` to undefined, and `execute` sets it.
    const rt = st.roundTrip as RunState['roundTrip'];
    if (rt) { dump(`step${i}-rt-before`, rt.before); dump(`step${i}-rt-after`, rt.after); dump(`step${i}-rt-bytes1`, rt.firstBytes); dump(`step${i}-rt-bytes2`, rt.secondBytes); if (rt.restored !== undefined) dump(`step${i}-rt-restored`, rt.restored); }
    if (process.env.MODOKI_PREFAB_FUZZ_DUMP && !editing()) dump(`step${i}-scene`, await serializeScene());
    if (process.env.MODOKI_PREFAB_FUZZ_DUMP) dump(`step${i}-prefabs`, Object.fromEntries([...after].filter(([p]) => p.endsWith('.prefab.json')).map(([p, t]) => [p, JSON.parse(t) as unknown])));
    if (process.env.MODOKI_PREFAB_FUZZ_DUMP && !editing()) dump(`step${i}-world`, worldTree());
    if (op.kind === 'outsideEdit') for (const [p, t] of after) if (before.get(p) !== t) handTexts.add(t);
    const handEdited = new Set([...after].filter(([, t]) => handTexts.has(t)).map(([p]) => p));
    // An outside edit numbers its own rows (it may take a freed number, as a hand edit or a merge does): I4 holds the
    // EDITOR's writes, so the history of each file it touched restarts from what it wrote.
    if (op.kind === 'outsideEdit') for (const [p, t] of after) if (before.get(p) !== t) forgetHistoryOf(history, t);
    const failures = [
      ...checkWorld(),
      ...checkFiles(after, history, written, handEdited),
      ...(rt ? checkRoundTrip(rt, tolerate, (src) => { const p = resolveGuidToPath(src); return !p || !after.has(p); }) : []),
    ];
    if (!editing()) {
      try { failures.push(...checkScene(await serializeScene())); } catch (e) { failures.push({ check: 'serializeScene threw', detail: String(e) }); }
    }
    // Owner ruling R (#1819, 2026-09-29): once a WORLD SWAP (a reload, leaving prefab edit, a watcher reload) has expanded
    // as a Missing Prefab placeholder something the stack's entries were recorded against, an undo against it REFUSES and
    // its entry is dropped, so the walk to the start can no longer restore the segment's scene, by design. Only a swap:
    // a same-world op that makes a placeholder (a duplicate or paste of one, a delete's undo, a drop whose nested
    // reference is missing) changes no recorded entity's kind, and tainting there would hide a false refusal for the
    // rest of the segment (#1819 close-out review). The per-step I6/I7 checks run either way.
    // ⚠️ Taken BEFORE the op's own refusal is judged (#1862): one `undo` op runs up to three steps, so its first step can
    // swap (an Apply's undo reloads its snapshot) and its second refuse on what that swap left unexpanded — ruling R inside
    // one op, which judged first read as a refusal in a clean segment (seed 6191). Sound either way round: a refused step
    // changes nothing, so every swap this op made came before its refusal.
    const swapped = getCurrentWorld() !== worldBefore;
    if (swapped && ([...placeholderGuids()].some((g) => !placeholdersBefore.has(g)) || [...unexpandedRows()].some((k) => !unexpandedBefore.has(k)))) taint(seg, 'rulingR');
    if ((op.kind === 'undo' || op.kind === 'redo') && outcome === 'refused') {
      if (seg.tainted) skipped(seg, `${op.kind} op refusal forgiven`);
      else failures.push({ check: `${op.kind} refused in a clean segment`, detail: st.note ?? '' });
    }
    if (failures.length) return fail(i, label, failures[0]);

    if (op.kind === 'outsideEdit' && outcome === 'done') taint(seg, 'outsideEdit');
    if (op.kind === 'prefabEdit' && outcome === 'done' && st.prefabEditSaved) taint(seg, 'prefabEditSave');
    // Read back through the declared type, as `roundTrip` above: the reset narrows it to undefined, and `execute` sets it.
    const fileOp = st.fileOp as RunState['fileOp'];
    if (fileOp) {
      const trashedBytes = fileOp.to === null ? (seg.prefabs.get(fileOp.from) ?? before.get(fileOp.from)) : undefined;
      rebaseForFileOp(seg.prefabs, fileOp);
      if (fileOp.to === null && !seg.tainted) {
        const texts = [JSON.stringify(seg.scene ?? null), editing() ? '' : JSON.stringify(await serializeScene()),
          ...seg.prefabs.values(), ...[...be.snapshot()].filter(([k]) => k.endsWith('.prefab.json')).map(([, t]) => t)];
        if (trashedPrefabReferenced(trashedBytes, fileOp.from, texts)) taint(seg, 'assetDelete');
      }
    }
    // A raise got here only as the outside edit's own (checked above), which tainted the segment as `outsideEdit`.
    // The stack was reset (a reload, a scene open): a new segment starts here.
    if (op.kind !== 'undo' && undoDepth() === 0 && !canRedo()) seg = await segmentHere(be);
  }
  // The walk to the ends is the most-exercised undo path of the run, so it answers to the same checks as a step: what it
  // logs, and the world and files it leaves (review: errors logged there were never read).
  const walkStep = all.length;
  const walkBefore = be.snapshot();
  const u = await undoIdentity(be, seg, tolerate, st.created!);
  if (u) return fail(walkStep, 'undo/redo to the ends', { ...u, console: [...consoleErrors] });
  const walkErrors = consoleErrors.splice(0).filter((m, k, list) => !opts.expectedError(m, list[k - 1]));
  if (walkErrors.length) return fail(walkStep, 'undo/redo to the ends', { check: 'console.error', detail: walkErrors[0].slice(0, 300) });
  const walkAfter = be.snapshot();
  // As after each step: a file the walk put back to bytes the run has had before (an undo restoring the fixture's) is not
  // the editor's write any more, so I15 does not judge it.
  for (const [p, t] of walkAfter) if (walkBefore.get(p) !== t) { if (!seen.has(t)) written.add(p); else written.delete(p); seen.add(t); }
  const handEditedEnd = new Set([...walkAfter].filter(([, t]) => handTexts.has(t)).map(([p]) => p));
  const endFailures = [...checkWorld(), ...checkFiles(walkAfter, history, written, handEditedEnd)];
  if (!editing()) {
    try { endFailures.push(...checkScene(await serializeScene())); } catch (e) { endFailures.push({ check: 'serializeScene threw', detail: String(e) }); }
  }
  if (endFailures.length) return fail(walkStep, 'undo/redo to the ends', endFailures[0]);
  return { trace };
}

/** The failure `ops` produces, as a signature, or null when it passes. */
async function failsAs(be: FuzzBackend, ops: readonly Op[], opts: RunOpts): Promise<string | null> {
  try {
    const r = await runOps(be, ops, opts);
    return r.failure ? signature(r.failure) : null;
  } catch (e) {
    return `harness: ${String(e)}`.slice(0, 120);
  }
}

/** Delta debugging (ddmin) over the op list, then over each prefab edit's inner list: the smallest list that still
 *  fails with the SAME signature. Bounded by `budget` replays. */
export async function shrink(
  be: FuzzBackend, ops: readonly Op[], sig: string, opts: RunOpts, budget = 300,
): Promise<{ ops: Op[]; replays: number }> {
  let replays = 0;
  const same = async (cand: Op[]) => { if (replays >= budget) return false; replays++; return (await failsAs(be, cand, opts)) === sig; };
  const ddmin = async (list: Op[], test: (l: Op[]) => Promise<boolean>): Promise<Op[]> => {
    let cur = list;
    let n = 2;
    while (cur.length >= 2 && replays < budget) {
      const size = Math.ceil(cur.length / n);
      let reduced = false;
      for (let i = 0; i < n && replays < budget; i++) {
        const complement = [...cur.slice(0, i * size), ...cur.slice((i + 1) * size)];
        if (complement.length && await test(complement)) { cur = complement; n = Math.max(n - 1, 2); reduced = true; break; }
      }
      if (!reduced) { if (n >= cur.length) break; n = Math.min(cur.length, n * 2); }
    }
    if (cur.length === 1 && replays < budget && await test([])) return [];
    return cur;
  };
  let cur = await ddmin([...ops], same);
  for (let i = 0; i < cur.length; i++) {
    const op = cur[i];
    if (!op.inner?.length) continue;
    const inner = await ddmin(op.inner, (l) => same(cur.map((o, j) => (j === i ? { ...o, inner: l } : o))));
    cur = cur.map((o, j) => (j === i ? { ...o, inner } : o));
  }
  return { ops: cur, replays };
}
