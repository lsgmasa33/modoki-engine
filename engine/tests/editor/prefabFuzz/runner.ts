/** The prefab fuzzer's runner (#1789): run one op list against a fresh fixture and stop at the first failed check,
 *  and the shrinker that reduces a failing list to a short repro of the same failure. */

import { undoDepth, canRedo, undoStep } from '../../../packages/modoki/src/editor/undo/undoManager';
import { serializeScene, saveScene, loadSceneReporting } from '../../../packages/modoki/src/editor/scene/serialize';
import { instantiatePrefabInstance } from '../../../packages/modoki/src/editor/scene/prefabInstantiate';
import { getAllEntities, getCurrentWorld, findEntity } from '@modoki/engine/runtime';
import { startRun, settle, flushWatcher, editing, piOf, placeholderGuids, unexpandedRows, swallowedGuids, worldTree, authored, type Fixture } from './harness';
import { execute, describe as describeOp, deletedPrefabs, type Op, type RunState } from './ops';
import { checkWorld, checkFiles, checkMarks, forgetHistoryOf, checkScene, checkRoundTrip, canonScene, firstDiff, markFree, nodeMoved, signature, alignEqualOrientations, type Failure, type LocalIdHistory, type MarkHistory } from './checks';
import type { FuzzBackend } from './backend';
import fs from 'fs';
import { resolveGuidToPath } from '../../../packages/modoki/src/runtime/loaders/assetManifest';
import path from 'path';
import { prefabTextIsDocument } from '../../../packages/modoki/src/editor/scene/prefabCommit';
import type { PrefabFile } from '../../../packages/modoki/src/editor/scene/prefab';
import { getDirtyAssetPaths, parkedPrefab } from '../../../packages/modoki/src/editor/scene/dirtyAssets';
import { jsonFileBody } from '../../../packages/modoki/src/editor/backend/editorBackend';
import { localIdCounter, LOCAL_ID_MARK_VERSION, type CountedDoc } from '../../../packages/modoki/src/runtime/core/localIdCounter';
import { refreshInstances, preloadRebuildEntry } from '../../../packages/modoki/src/editor/scene/prefabRebuild';
import { getCachedPrefabSync } from '../../../packages/modoki/src/editor/scene/prefabCache';
import { isStoredRoot } from '../../../packages/modoki/src/runtime/core/assetRefRules';
import { frameRootDoc } from '../../../packages/modoki/src/runtime/core/ecs/identityParents';
import { findEntityByGuid } from '../../../packages/modoki/src/runtime/core/ecs/world';
import { unresolvedRefOf } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';

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
 *    ("is no longer in the scene"), and it is the same ruling (#1849; work-ai3 hunt seeds 6191, 6356). Or, in the walk to
 *    the ends, a same-world step (a delete's undo) respawned a placeholder whose record took in an entity the segment had
 *    live (#1831, seed 6356).
 *  - `assetDelete`: a Move to Trash of a prefab something the walk must restore still REFERENCES — the scene at the
 *    segment's start or now, or a prefab file then or now (`trashedPrefabReferenced`). It is not undoable (#1868, owner
 *    ruling D2; Unity: "You cannot undo the delete assets action."), so the file stays gone for the walk, and the stack's
 *    entries recorded against it (a respawn from it, a rebuild onto it) refuse after it by the same rule as `rulingR`. A
 *    trash of a prefab nothing references only leaves the baseline (`rebaseForFileOp`), and every check stays on. A
 *    RENAME is never a taint: a scene names a prefab by guid, so the runner only moves the path in the baseline.
 *    ⚠️ Known limit: a prefab only the undo/redo STACK names (placed, then undone, then trashed) is not seen, so its
 *    redo's refusal reads as one in a clean segment — a false finding a hunt would show, never a hidden one. */
export type TaintCause = 'outsideEdit' | 'prefabEditSave' | 'rulingR' | 'assetDelete';

/** `live`: every guid the segment has had live (its start, and after each step) — what the stack's entries can name. */
interface Segment { scene: unknown; prefabs: Map<string, string>; tainted: TaintCause | null; live: Set<string> }

/** Across the process, per cause: how many ops tainted a segment, and how many checks a taint turned off (keyed
 *  `<cause>: <check>`, attributed to the segment's FIRST cause). The hunt prints both. */
export const taintCounts = new Map<TaintCause, number>();
export const skippedChecks = new Map<string, number>();
/** How many times each of #1880's added checks RAN (T2 rebuild ≡ reload, T4 respawn identity): a check that never runs
 *  on the verify seeds guards nothing, so the verify run says how often it did. */
export const checksRun = new Map<string, number>();
const ran = (check: string) => checksRun.set(check, (checksRun.get(check) ?? 0) + 1);
const skipped = (seg: Segment, check: string) => {
  const k = `${seg.tainted}: ${check}`;
  skippedChecks.set(k, (skippedChecks.get(k) ?? 0) + 1);
};
function taint(seg: Segment, cause: TaintCause): void {
  taintCounts.set(cause, (taintCounts.get(cause) ?? 0) + 1);
  seg.tainted ??= cause;
}

/** Every prefab as the editor holds it: the file's bytes, or — where an undo or redo parked a document for Save to write
 *  (#1868, D1 = Park) — the park, as the flush would write it. The undo walk compares THESE, since an undone Apply,
 *  Replace or rig update changes memory and leaves the file until Save. */
const prefabBytes = (be: FuzzBackend) => {
  const out = new Map([...be.snapshot()].filter(([p]) => p.endsWith('.prefab.json')));
  for (const p of getDirtyAssetPaths()) {
    const parked = parkedPrefab(p);
    if (parked) out.set(p, jsonFileBody(parked));
  }
  return out;
};

/** {@link RunState.lastPrefabs}, brought up to date: each prefab the editor holds now, by document id. */
/** A prefab file's contents as a DOCUMENT, with the localId mark and the version set aside (what a restore may raise,
 *  #1774/#1797) and the formatting normalized (a park is the editor's own serialization of what it read). */
const docForm = (t: string): string => { try { return JSON.stringify(markFree(JSON.parse(t) as object)); } catch { return t; } };

/** Which held paths a hand edit wrote (#1880 T1): `handEdited`, by its bytes or as the same DOCUMENT (a park is the
 *  editor's re-serialization of what it read), is held to nothing by the file checks; `handBytes`, by its own bytes only,
 *  by the mark check — a document form sets the mark aside, so a park of the hand edit's document with its mark LOWERED
 *  would match it and escape, the one thing that check is for (close-out review). */
export function handEditedPaths(view: ReadonlyMap<string, string>, handTexts: ReadonlySet<string>): { handEdited: Set<string>; handBytes: Set<string> } {
  const handDocs = new Set([...handTexts].map(docForm));
  return {
    handEdited: new Set([...view].filter(([, t]) => handTexts.has(t) || handDocs.has(docForm(t))).map(([p]) => p)),
    handBytes: new Set([...view].filter(([, t]) => handTexts.has(t)).map(([p]) => p)),
  };
}

/** I15's "verbatim carry" test (#1880 T1): contents the run has had, or the same DOCUMENT at a version it had it at or at
 *  v8, the version a raised localId mark claims (#1797). Any other version is the editor rewriting a known document at an
 *  old version, which is what I15 exists to catch (close-out review). `see` records contents as the run meets them. */
export function carryTracker(): { see: (t: string) => void; carried: (t: string) => boolean } {
  const seen = new Set<string>();
  const docs = new Map<string, Set<number | undefined>>();
  const versionOf = (t: string): number | undefined => { try { return (JSON.parse(t) as { version?: number }).version; } catch { return undefined; } };
  return {
    see: (t) => { seen.add(t); const f = docForm(t); if (!docs.has(f)) docs.set(f, new Set()); docs.get(f)!.add(versionOf(t)); },
    carried: (t) => {
      if (seen.has(t)) return true;
      const versions = docs.get(docForm(t));
      return !!versions && (versions.has(versionOf(t)) || versionOf(t) === LOCAL_ID_MARK_VERSION);
    },
  };
}

/** The prefab paths the editor holds a PARKED document for (#1868): `prefabBytes` shows the park there, not the file. */
const parkedPaths = (): Set<string> => new Set(getDirtyAssetPaths().filter((p) => p.endsWith('.prefab.json') && parkedPrefab(p)));

/** #1880 T2, rebuild ≡ reload: after an op that changed a template the scene's instances are expanded from (an Apply, an
 *  outside edit), the live world — rebuilt or rebased in place — must be what LOADING the scene as it stood before the op
 *  gives under the new template, marks included. The round trip cannot see a rebuild that DROPS an edit and then saves
 *  the loss consistently (#1877 3b S3, L4); this compares the rebuild with an independent expansion of the pre-op
 *  statements instead. An Apply's own top-level instance is left out: the Apply rewrote its statements too (the applied
 *  overrides are subtracted, promoted nodes leave its scene list). Skipped while a prefab the run deleted is gone (a
 *  live instance stays expanded where a load gives a placeholder, as `saveReload` handles) or a placeholder is live.
 *
 *  The comparison reloads the scene, so afterwards the post-op scene (saved first) is loaded back and the run goes on
 *  from it, with the undo stack reset as a save→reload leaves it. */
async function rebuildIsReload(st: RunState, sBefore: unknown, kind: string): Promise<Failure | null> {
  // Every skip is COUNTED by its reason (close-out review): a check whose guards quietly return reads as coverage it is not.
  const skip = editing() ? 'prefab edit open' : deletedPrefabs(st).length ? 'a deleted prefab' : placeholderGuids().size ? 'a placeholder live' : null;
  if (skip) { ran(`rebuild≡reload after ${kind}: skipped (${skip})`); return null; }
  const except = st.appliedTop;
  const live = worldTree();
  const saved = await saveScene({ allowDialog: false });
  // Nothing to restore the run from; the round trip judges the save itself.
  if (!saved.saved) { ran(`rebuild≡reload after ${kind}: skipped (the save refused)`); return null; }
  const afterBytes = st.be.read(st.f.scenePath)!;
  st.be.write(st.f.scenePath, `${JSON.stringify(sBefore, null, 2)}\n`);
  const back = await loadSceneReporting(st.f.scenePath);
  if (back.outcome !== 'loaded') throw new Error(`rebuild≡reload: the pre-op scene did not load (${back.outcome})`);
  await settle();
  const reloaded = worldTree();
  st.be.write(st.f.scenePath, afterBytes);
  const again = await loadSceneReporting(st.f.scenePath);
  if (again.outcome !== 'loaded') throw new Error(`rebuild≡reload: the post-op scene did not load back (${again.outcome})`);
  await settle();
  const without = (tree: Record<string, unknown>): Record<string, unknown> => {
    if (!except) return tree;
    type N = { traits?: { EntityAttributes?: { parentId?: unknown } } };
    const top = (k: string): string => { let cur = k; for (let i = 0; i < 256; i++) { const p = (tree[cur] as N | undefined)?.traits?.EntityAttributes?.parentId; if (typeof p !== 'string' || !(p in tree)) return cur; cur = p; } return cur; };
    return Object.fromEntries(Object.entries(tree).filter(([k]) => top(k) !== except));
  };
  dump('t2-before', sBefore); dump('t2-live', live); dump('t2-reloaded', reloaded); dump('t2-except', except ?? null);
  const [a, b] = [without(live), without(reloaded)];
  const d = firstDiff(a, alignEqualOrientations(a, b));
  ran(`rebuild≡reload after ${kind}`);
  st.note = `rebuild≡reload checked${except ? ' (the Apply\'s own instance left out)' : ''}`;
  return d ? { check: 'a rebuild is not a reload', detail: d, moved: nodeMoved(d, a, b) } : null;
}

/** #1880 T4, the RESPAWN form of "fold(chain + capture(live)) ≡ live": every stored instance root, rebuilt from its own
 *  capture onto the very document it was expanded from (`refreshInstances(src, [root], doc, doc)`, what a rebase does to
 *  a frame whose template did not change), must give back the world it tore down — traits, marks, template keys, parents
 *  and order. The rebuild respawns from a capture in the respawn form while the save writes the rows form, and nothing
 *  pins the two together but this (#1826's class: a respawn in the read form lost a reference node's own rows). The rows
 *  form is held by the round trip (`checkRoundTrip`); the template form by the round trips after Create Prefab and a
 *  prefab-edit save. Run once, at the END of the run: a rebuild renumbers ids, and the ops pick their targets in id
 *  order, so running it between ops would change every seed's path. */
async function respawnIdentity(): Promise<Failure | null> {
  if (editing()) return null;
  const before = worldTree();
  const roots = authored().filter((e) => {
    const pi = piOf(e.id);
    const ent = findEntity(e.id);
    return !!e.guid && !!pi && isStoredRoot(pi as never, e.id) && !!ent && !unresolvedRefOf(ent as never);
  }).map((e) => e.guid!);
  const world = getCurrentWorld();
  for (const guid of roots) {
    // Warmed as every editor caller warms a rebuild: the load of the frame's whole scene entry (#1880 F7a).
    const at = findEntityByGuid(guid)?.id();
    if (at != null) await preloadRebuildEntry(at);
    const ent = findEntityByGuid(guid);
    const pi = ent ? piOf(ent.id()) : undefined;
    const doc = pi ? getCachedPrefabSync(pi.source) : null;
    if (!ent || !pi || !doc) continue;
    const expandedFrom = (frameRootDoc(world, ent)?.doc as PrefabFile | undefined) ?? doc;
    refreshInstances(pi.source, [ent.id()], expandedFrom, doc);
    await settle();
  }
  const after = worldTree();
  dump('t4-before', before); dump('t4-after', after);
  ran(`respawn identity (${roots.length ? 'instances' : 'none'})`);
  const d = firstDiff(before, alignEqualOrientations(before, after));
  return d ? { check: 'a no-op rebuild is not the identity', detail: d, moved: nodeMoved(d, before, after) } : null;
}

/** The file checks and the mark check over what the editor HOLDS (#1880 T1): the files with each park laid over its
 *  file. A park is what the next writer mints from and what Save writes, so I4 (a localId re-bound, the mark), I16 (a
 *  template containing itself) and the validator hold for it as for a file (#1877 3b S1, L1: an undo's restore parked a
 *  lowered mark or a self-containing document, and no check read a park). I15 judges only a file the run WROTE, so a
 *  park — often an older document an undo put back, at its old version — is left out of `written`. */
function checkHeld(be: FuzzBackend, history: LocalIdHistory, marks: MarkHistory, written: ReadonlySet<string>, handTexts: ReadonlySet<string>): Failure[] {
  const view = prefabBytes(be);
  const parked = parkedPaths();
  // A hand edit's document is held to nothing wherever the editor holds it: in its file, or parked (re-serialized).
  const { handEdited, handBytes } = handEditedPaths(view, handTexts);
  return [
    ...checkFiles(view, history, new Set([...written].filter((p) => !parked.has(p))), handEdited),
    ...checkMarks(view, marks, parked, handBytes),
  ];
}

function recordPrefabs(st: RunState): void {
  for (const [p, t] of prefabBytes(st.be)) {
    let id: string | undefined;
    try { id = (JSON.parse(t) as { id?: string }).id; } catch { /* unreadable: not a document to restore */ }
    if (id) st.lastPrefabs!.set(id, [p, t]);
  }
}

function noteLive(seg: Segment): void {
  if (!editing()) for (const e of getAllEntities()) if (e.guid) seg.live.add(e.guid);
}

/** Owner ruling R, reached in the SAME world (hunt seed 6356): a step that respawned a Missing Prefab placeholder whose
 *  record took in an entity the segment had live. That entity is no longer in the scene, so an undo recorded against it
 *  refuses, by design. `before`: {@link swallowedGuids} before the step. */
function swallowedRecorded(seg: Segment, before: ReadonlySet<string>): boolean {
  return !editing() && newlySwallowed(seg.live, before, swallowedGuids());
}

/** The decision itself, pure: a guid a placeholder swallowed during the step (`now`, not `before`) that the segment had
 *  live. Neither half alone: a placeholder that took in only guids nothing live ever had (a template row's, an asset's),
 *  or one already swallowed before the step, does not taint, and a taint forgives every refusal after it. */
export function newlySwallowed(live: ReadonlySet<string>, before: ReadonlySet<string>, now: ReadonlySet<string>): boolean {
  return [...now].some((g) => !before.has(g) && live.has(g));
}

async function segmentHere(be: FuzzBackend): Promise<Segment> {
  const seg: Segment = { scene: editing() ? null : await serializeScene(), prefabs: prefabBytes(be), tainted: null, live: new Set() };
  noteLive(seg);
  return seg;
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

/** Drop the mark of the document `text` holds: an outside edit numbers its own rows, and the next check re-seeds it. */
function forgetMarkOf(marks: MarkHistory, text: string): void {
  try { const id = (JSON.parse(text) as { id?: string }).id; if (id) marks.delete(id); } catch { /* not a document */ }
}

export function rebaseForFileOp(prefabs: Map<string, string>, op: { from: string; to: string | null }): void {
  const text = prefabs.get(op.from);
  prefabs.delete(op.from);
  if (op.to !== null && text !== undefined) prefabs.set(op.to, text);
}

/** A restored prefab file is the document it held, except for the localId high-water mark: a restore that must raise
 *  `nextLocalId` splices it into the bytes and claims v8 in place (#1774, docs/prefabs.md § "The localId high-water
 *  mark"), so an undo cannot give back the exact bytes by design. Those two fields are set aside as long as they only
 *  went UP; everything else, formatting included, must match. */
export function diffFiles(a: Map<string, string>, b: Map<string, string>, created?: readonly string[]): string | null {
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(p) === b.get(p)) continue;
    // A file a Create Prefab made, still there at the segment's start: its undo LEAVES the file (#1795, hub ruling (i),
    // Unity). Only while it holds what a create wrote (the bytes, or the same document under a raised #1774 mark) — a
    // leftover with any other content is a wrong write under a right path, and still a finding (hub review). Matched by
    // DOCUMENT, at any path: a Rename of the new prefab moves it, and the move is not undone by the create's undo (hunt
    // seed 6029, minimized).
    if (a.get(p) === undefined && created?.some((made) => prefabTextIsDocument(b.get(p)!, JSON.parse(made) as PrefabFile))) continue;
    if (a.get(p) === undefined || b.get(p) === undefined) return `${p}: ${a.has(p) ? 'present' : 'absent'} vs ${b.has(p) ? 'present' : 'absent'}`;
    const [da, db] = [JSON.parse(a.get(p)!) as CountedDoc & { version?: number }, JSON.parse(b.get(p)!) as CountedDoc & { version?: number }];
    const d = firstDiff(markFree(JSON.parse(a.get(p)!) as object), markFree(JSON.parse(b.get(p)!) as object));
    if (d) return `${p}: ${d}`;
    // Set aside, but only in the direction a restore may move them (#1880 T1): an undo or a redo that gives back a LOWER
    // mark than the side it returns to frees a number a row took, which is the whole of I4 (#1877 3b S1), and deleting
    // both fields let exactly that pass.
    if (localIdCounter(db) < localIdCounter(da)) return `${p}: the localId mark went down (${localIdCounter(da)} → ${localIdCounter(db)})`;
    if ((db.version ?? 0) < (da.version ?? 0)) return `${p}: the format version went down (v${da.version} → v${db.version})`;
  }
  return null;
}

/** Undo to the segment's start and compare, then redo to the end and compare. Only a segment nothing outside the
 *  undo stack has touched (an outside edit, a prefab-edit save, a watcher reload) is held to the bytes. */
async function undoIdentity(be: FuzzBackend, seg: Segment, created: readonly string[]): Promise<Failure | null> {
  const canon = (scene: unknown) => canonScene(scene, placeholderGuids());
  if (editing()) return null;
  const end = { scene: await serializeScene(), prefabs: prefabBytes(be) };
  let steps = 0;
  for (; steps < 400; steps++) {
    const swallowedBefore = editing() ? new Set<string>() : swallowedGuids();
    const r = await undoStep('undo');
    await settle();
    if (swallowedRecorded(seg, swallowedBefore)) taint(seg, 'rulingR');
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
  const trace: string[] = [];
  consoleErrors.length = 0;
  const f = await startRun(be, setupNest, JSON.stringify(ops));
  const st: RunState = { be, f, clip: null, touched: { drop: new Set(), paste: new Set(), detach: new Set(), create: new Set() }, lastPrefabs: new Map(), created: [] };
  recordPrefabs(st);
  const history: LocalIdHistory = new Map();
  /** Every file content the run has had, at any path: a write of one of these is a verbatim carry (an undo's restore, a
   *  move), which I15 exempts. */
  // A restore that had to RAISE the localId mark splices it into bytes the run has had and claims v8 in place (#1774,
  // #1797), so a park flushed by Save All is still a verbatim carry, not the editor's own write (hunt seed 1037).
  const { see, carried } = carryTracker();
  const written = new Set<string>();
  /** Contents an outside edit wrote (a rename or an undo's restore can carry them to another path verbatim). */
  const handTexts = new Set<string>();
  for (const t of be.snapshot().values()) see(t);
  checkFiles(be.snapshot(), history, written); // seed the localId history with the fixture
  const marks: MarkHistory = new Map();
  checkMarks(be.snapshot(), marks, new Set()); // and the marks
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
    st.appliedTop = undefined;
    // Taken before the op, for the rebuild ≡ reload check the generator wrote into it (#1880 T2).
    const sBefore = op.check === 'rebuild-reload' && !editing() ? await serializeScene() : undefined;
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
    // A T2 op that did not land is counted too (close-out re-review): it checked nothing, and the tally must say so.
    if (sBefore !== undefined && outcome !== 'done') ran(`rebuild≡reload after ${op.kind}: not run (the op was ${outcome})`);
    if (sBefore !== undefined && outcome === 'done') {
      let t2Failure: Failure | null;
      try { t2Failure = await rebuildIsReload(st, sBefore, op.kind); } catch (e) { return fail(i, label, { check: 'rebuild≡reload threw', detail: String(e) }); }
      // Said in the step's own trace line, which was written before the check ran (close-out review).
      // Read back through the declared type, as `roundTrip` below: the reset above narrows `st.note` to undefined.
      const t2Note = (st as RunState).note;
      if (t2Note?.startsWith('rebuild≡reload')) trace[trace.length - 1] += ` [${t2Note}]`;
      if (t2Failure) return fail(i, label, t2Failure);
      const t2Errors = consoleErrors.splice(0).filter((m, k, all) => !opts.expectedError(m, all[k - 1]));
      if (t2Errors.length) return fail(i, label, { check: 'console.error', detail: t2Errors[0].slice(0, 300) });
    }

    const after = be.snapshot();
    recordPrefabs(st);
    for (const [p, t] of after) {
      if (before.get(p) === t) continue;
      // A write the editor made of content no file in the run has had before.
      if (!carried(t) && op.kind !== 'outsideEdit') written.add(p); else written.delete(p);
      see(t);
    }
    // Read back through the declared type: the reset above narrows `st.roundTrip` to undefined, and `execute` sets it.
    const rt = st.roundTrip as RunState['roundTrip'];
    if (rt) { dump(`step${i}-rt-before`, rt.before); dump(`step${i}-rt-after`, rt.after); dump(`step${i}-rt-bytes1`, rt.firstBytes); dump(`step${i}-rt-bytes2`, rt.secondBytes); if (rt.restored !== undefined) dump(`step${i}-rt-restored`, rt.restored); }
    if (process.env.MODOKI_PREFAB_FUZZ_DUMP && !editing()) dump(`step${i}-scene`, await serializeScene());
    if (process.env.MODOKI_PREFAB_FUZZ_DUMP) dump(`step${i}-prefabs`, Object.fromEntries([...after].filter(([p]) => p.endsWith('.prefab.json')).map(([p, t]) => [p, JSON.parse(t) as unknown])));
    if (process.env.MODOKI_PREFAB_FUZZ_DUMP && !editing()) dump(`step${i}-world`, worldTree());
    if (op.kind === 'outsideEdit') for (const [p, t] of after) if (before.get(p) !== t) handTexts.add(t);
    // An outside edit numbers its own rows (it may take a freed number, as a hand edit or a merge does): I4 holds the
    // EDITOR's writes, so the history of each file it touched restarts from what it wrote.
    if (op.kind === 'outsideEdit') for (const [p, t] of after) if (before.get(p) !== t) { forgetHistoryOf(history, t); forgetMarkOf(marks, t); }
    const failures = [
      ...checkWorld(),
      ...checkHeld(be, history, marks, written, handTexts),
      ...(rt ? checkRoundTrip(rt, (src) => { const p = resolveGuidToPath(src); return !p || !after.has(p); }) : []),
    ];
    if (!editing()) {
      try { failures.push(...checkScene(await serializeScene())); } catch (e) { failures.push({ check: 'serializeScene threw', detail: String(e) }); }
    }
    // Owner ruling R (#1819, 2026-09-29): once a WORLD SWAP (a reload, leaving prefab edit, a watcher reload) has expanded
    // as a Missing Prefab placeholder something the stack's entries were recorded against, an undo against it REFUSES and
    // its entry is dropped, so the walk to the start can no longer restore the segment's scene, by design. Only a swap
    // here: a same-world placeholder (a duplicate or paste of one, a drop whose nested reference is missing) changes no
    // recorded entity's kind, and tainting there would hide a false refusal for the rest of the segment (#1819 close-out
    // review). The one same-world exception, a delete's undo whose placeholder swallows an entity the segment had live,
    // is taken in the WALK (`swallowedRecorded`, hunt seed 6356). ⚠️ Known limit: an `undo` op here reaching it reads as
    // a refusal in a clean segment: a false finding a hunt would show, never a hidden one (no seed reaches it, so it is
    // not built). The per-step I6/I7 checks run either way.
    // ⚠️ Taken BEFORE the op's own refusal is judged (#1862): one `undo` op runs up to three steps, so its first step can
    // swap (an Apply's undo reloads its snapshot) and its second refuse on what that swap left unexpanded — ruling R inside
    // one op, which judged first read as a refusal in a clean segment (seed 6191). Sound either way round: a refused step
    // changes nothing, so every swap this op made came before its refusal.
    const swapped = getCurrentWorld() !== worldBefore;
    if (swapped && ([...placeholderGuids()].some((g) => !placeholdersBefore.has(g)) || [...unexpandedRows()].some((k) => !unexpandedBefore.has(k)))) taint(seg, 'rulingR');
    noteLive(seg);
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
  const u = await undoIdentity(be, seg, st.created!);
  if (u) return fail(walkStep, 'undo/redo to the ends', { ...u, console: [...consoleErrors] });
  const walkErrors = consoleErrors.splice(0).filter((m, k, list) => !opts.expectedError(m, list[k - 1]));
  if (walkErrors.length) return fail(walkStep, 'undo/redo to the ends', { check: 'console.error', detail: walkErrors[0].slice(0, 300) });
  const walkAfter = be.snapshot();
  // As after each step: a file the walk put back to bytes the run has had before (an undo restoring the fixture's) is not
  // the editor's write any more, so I15 does not judge it.
  for (const [p, t] of walkAfter) if (walkBefore.get(p) !== t) { if (!carried(t)) written.add(p); else written.delete(p); see(t); }
  const endFailures = [...checkWorld(), ...checkHeld(be, history, marks, written, handTexts)];
  if (!editing()) {
    try { endFailures.push(...checkScene(await serializeScene())); } catch (e) { endFailures.push({ check: 'serializeScene threw', detail: String(e) }); }
  }
  if (endFailures.length) return fail(walkStep, 'undo/redo to the ends', endFailures[0]);
  const respawn = await respawnIdentity();
  if (respawn) return fail(walkStep + 1, 'a no-op rebuild of every stored instance', respawn);
  const respawnErrors = consoleErrors.splice(0).filter((m, k, list) => !opts.expectedError(m, list[k - 1]));
  if (respawnErrors.length) return fail(walkStep + 1, 'a no-op rebuild of every stored instance', { check: 'console.error', detail: respawnErrors[0].slice(0, 300) });
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
