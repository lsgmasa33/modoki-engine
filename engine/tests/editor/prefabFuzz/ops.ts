/** The prefab fuzzer's operations (#1789): the generator, and one executor per op through the entry point the editor's
 *  own UI calls (the Hierarchy, the Inspector, the Apply dialog, the Assets panel, prefab edit).
 *
 *  An op is `{ kind, u }`: `u` is a list of floats in [0, 1) drawn when the list is generated, and every choice the
 *  executor makes (which entity, which key, which value) reads one of them against what the world holds WHEN THE OP
 *  RUNS. So a list stays runnable when the shrinker drops ops from it: an op whose choice has nothing to choose from
 *  is a recorded no-op, not an error. A prefab-edit op carries its own inner list, which the shrinker also trims. */

import { createWorld } from 'koota';
import { getTraitByName, seedRng, rngNext, findEntity, readTraitData } from '@modoki/engine/runtime';
import { getOverrideMarkSet } from '../../../packages/modoki/src/runtime/loaders/overrideMarks';
import { instanceBase } from '../../../packages/modoki/src/editor/scene/prefabChain';
import { pushAction } from '@modoki/engine/editor';
import { createPrefabFromEntity, deleteAssetFiles, deletionPathsFor, moveAsset, planDeleteOutcome, planRename } from '../../../packages/modoki/src/editor/panels/assetOps';
import { applyAssetPathMoves, unbindDeletedAssetEditors } from '../../../packages/modoki/src/editor/panels/assetEditorBindings';
import { type PrefabFile } from '../../../packages/modoki/src/editor/scene/prefab';
import {
  getCachedPrefabSync, preloadNestedPrefabsForSubtree,
} from '../../../packages/modoki/src/editor/scene/prefabCache';
import { previewApply } from '../../../packages/modoki/src/editor/scene/prefabApply';
import { revertRefusal } from '../../../packages/modoki/src/editor/scene/prefabRevert';
import { placePrefabFromPath } from '../../../packages/modoki/src/editor/scene/prefabPlace';
import { suppliedByPrefabChecker } from '../../../packages/modoki/src/editor/scene/restructureRefusal';
import { detachPrefabInstanceWithUndo, detachRefusal } from '../../../packages/modoki/src/editor/undo/detachPrefabUndo';
import {
  duplicateEntity, clipEntity, cutSourceId, pasteEntityCopy, deleteEntitiesWithUndo, writeTraitFieldWithUndo,
  addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo, createEntityWithUndo, planReparent, applyReparent,
  type EntityClipboard,
} from '../../../packages/modoki/src/editor/undo/entityActions';
import { collectInstanceOverrideKeys, effectiveDefaults } from '../../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyTargetOptions } from '../../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { initialTargets, setAllTargets, toApplyTargets, applyBlocked, groupToggle, retargetChecks } from '../../../packages/modoki/src/editor/panels/applyDialogModel';
import { applyToPrefabWithUndo } from '../../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { revertOverridesWithUndo } from '../../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { undoStep, breakUndoCoalescing } from '../../../packages/modoki/src/editor/undo/undoManager';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../../packages/modoki/src/editor/scene/prefabEdit';
import { saveScene, loadSceneReporting } from '../../../packages/modoki/src/editor/scene/serialize';
import { flushDirtyAssets } from '../../../packages/modoki/src/editor/scene/dirtyAssets';
import { answerParkedConflicts } from '../../../packages/modoki/src/editor/scene/saveCommand';
import { emptySpecs } from '../../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { PrefabEditRefusalError } from '../../../packages/modoki/src/editor/scene/prefabEditRefusal';
import { isPrefabEditWorld } from '../../../packages/modoki/src/editor/scene/prefabEditWorld';
import { getCachedPrefab, invalidatePrefab } from '../../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { authored, piOf, isInstanceRoot, editing, worldTree, placeholderGuids, unexpandedRows, getCurrentWorld, type Fixture } from './harness';
import { frameRootDoc } from '../../../packages/modoki/src/runtime/core/ecs/identityParents';
import { canonicalJson } from '../../../packages/modoki/src/runtime/core/localIdCounter';
import type { FuzzBackend } from './backend';
import { markFree } from './checks';

export type OpKind =
  | 'createPrefab' | 'instantiate' | 'detach' | 'duplicate' | 'copy' | 'cut' | 'paste' | 'delete'
  | 'editField' | 'addComponent' | 'removeComponent' | 'addChild' | 'reparent'
  | 'apply' | 'revert' | 'prefabEdit' | 'undo' | 'redo' | 'saveReload'
  | 'trashPrefab' | 'renamePrefab' | 'outsideEdit';

export interface Op {
  kind: OpKind; u: number[]; inner?: Op[];
  /** A `saveReload` that is Cmd+S (#1880 T1): `all` flushes every parked prefab first, then saves and reloads; `all-no-reload`
   *  stops at the save, as Cmd+S does, so the undo stack survives it. WRITTEN INTO THE OP by the generator, never derived
   *  from `u` at run time: a list recorded before the field existed (REGRESSIONS, KNOWN_OPEN) carries draws that would
   *  otherwise select it, and would silently stop testing what it was recorded for (close-out review: #1794's regression
   *  passed with #1794's fix deleted). */
  save?: 'all' | 'all-no-reload';
  /** An Apply or outside edit the runner checks rebuild ≡ reload after (#1880 T2) — written by the generator, for the same
   *  reason: the check reloads the scene and drops the undo stack, so a recorded list must never gain it unasked. */
  check?: 'rebuild-reload';
  /** A variant the generator wrote (#1914 R0), read off draws the op already makes, for the same reason as `save`:
   *  - `toBase` (an `editField`): the field is set to the value the instance's effective base gives it, a deliberate edit
   *    equal to the prefab's value (Unity keeps a recorded one, #1914 F1/F2);
   *  - `toOverride` (an `outsideEdit`): a template field is set to the value an instance records for it, so the template
   *    now agrees with the override (it must stay recorded, #1914 § 4 row 8ii);
   *  - `removeLeaf` / `restoreLeaf` (an `outsideEdit`): a plain leaf row is taken out of a template, as a merge of another
   *    clone's prefab-edit delete writes it, and later put back as a revert of that merge would; the instances' records of
   *    it must survive in between as unused overrides (#1914 F5, I18). */
  variant?: 'toBase' | 'toOverride' | 'removeLeaf' | 'restoreLeaf';
}

/** Relative weights. Structure-changing ops and the three that CHECK (save→reload, undo, apply) are weighted up. */
const WEIGHTS: Record<OpKind, number> = {
  createPrefab: 4, instantiate: 6, detach: 2, duplicate: 6, copy: 3, cut: 2, paste: 5, delete: 5,
  editField: 12, addComponent: 4, removeComponent: 4, addChild: 5, reparent: 6,
  apply: 9, revert: 5, prefabEdit: 4, undo: 9, redo: 4, saveReload: 8,
  trashPrefab: 1, renamePrefab: 2, outsideEdit: 2,
};

/** What prefab edit may do inside its edit world: the entity ops, instantiate (nesting), undo/redo. */
const INNER: OpKind[] = ['editField', 'addComponent', 'removeComponent', 'addChild', 'delete', 'duplicate', 'reparent', 'instantiate', 'undo', 'redo'];

const U_PER_OP = 8;

/** The whole list for one seed, drawn up front from the engine's seeded RNG (`runtime/core/rng.ts`) on a throwaway
 *  world: the RNG's state is per world, and a run replaces its world many times. `exclude` drops kinds (KNOWN_OPEN). */
export function generate(seed: number, length: number, exclude: ReadonlySet<OpKind> = new Set()): Op[] {
  const world = createWorld();
  try {
    seedRng(seed, world);
    const next = () => rngNext(world);
    const pickKind = (pool: OpKind[]): OpKind => {
      const live = pool.filter((k) => !exclude.has(k));
      const total = live.reduce((s, k) => s + WEIGHTS[k], 0);
      let r = next() * total;
      for (const k of live) { r -= WEIGHTS[k]; if (r < 0) return k; }
      return live[live.length - 1];
    };
    const draw = (kind: OpKind): Op => ({ kind, u: Array.from({ length: U_PER_OP }, next) });
    const ops: Op[] = [];
    for (let i = 0; i < length; i++) {
      const op = draw(pickKind(Object.keys(WEIGHTS) as OpKind[]));
      if (op.kind === 'prefabEdit') {
        const n = 1 + Math.floor(next() * 4);
        op.inner = Array.from({ length: n }, () => draw(pickKind(INNER)));
      }
      // The variants are read off draws the op already made (no draw is added, so every seed's list and every later draw
      // are what they were), and WRITTEN into the op, which a replay or a recorded repro then carries as it is.
      if (op.kind === 'saveReload' && op.u[1]! >= 0.65) op.save = op.u[3]! < 0.5 ? 'all-no-reload' : 'all';
      if ((op.kind === 'apply' || op.kind === 'outsideEdit') && op.u[7]! >= 0.7) op.check = 'rebuild-reload';
      if (op.kind === 'editField' && op.u[4]! >= 0.75) op.variant = 'toBase';
      if (op.kind === 'outsideEdit') op.variant = op.u[4]! < 0.25 ? 'toOverride' : op.u[4]! < 0.45 ? 'removeLeaf' : op.u[4]! < 0.6 ? 'restoreLeaf' : undefined;
      if (op.variant === undefined) delete op.variant;
      ops.push(op);
    }
    return ops;
  } finally {
    world.destroy();
  }
}

/** A short, stable spelling of an op for reports. */
export function describe(op: Op): string {
  const u = op.u.slice(0, 4).map((x) => x.toFixed(3)).join(',');
  const tag = [op.save, op.check, op.variant].filter(Boolean).map((t) => `{${t}}`).join('');
  return op.inner ? `${op.kind}${tag}(${u})[${op.inner.map(describe).join('; ')}]` : `${op.kind}${tag}(${u})`;
}

// ── Execution ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunState {
  be: FuzzBackend;
  f: Fixture;
  clip: EntityClipboard | null;
  /** What the round trip inside a save→reload op measured; the checks read it. `restored`: the same saved file reloaded
   *  with every deleted prefab put back, when the run deleted one (#1805). */
  roundTrip?: { before: unknown; after: unknown; firstBytes: string; secondBytes: string; restored?: unknown; unexpanded?: ReadonlySet<string> };
  /** Every prefab DOCUMENT the run has seen, by id: the last path it had and the text the editor last held for it — the
   *  file, or the document an undo parked for Save (#1868). The runner records them after each step. What a deleted
   *  prefab's restore puts back: the document the live world was built on (hunt seed 7023: an Apply's undo is memory-only,
   *  so its file still held the applied value), at the path it had last (7078: renamed, then trashed). */
  lastPrefabs?: Map<string, [string, string]>;
  /** Set by an executor when an op could not run (nothing to choose, or the editor refused as the UI would show). */
  note?: string;
  /** Set by a prefab edit: whether it wrote the prefab (a discard changes no file the scene's undo cannot see). */
  prefabEditSaved?: boolean;
  /** Every guid a drop or a paste introduced, and every guid a detach or a Create Prefab covered, this run (a failure
   *  carries them). */
  touched: { drop: Set<string>; paste: Set<string>; detach: Set<string>; create: Set<string> };
  /** The bytes each Create Prefab of a FRESH path wrote, one entry per create: its undo leaves the file (#1795, hub
   *  ruling (i)), so the walk to a segment's start may find it still there — holding exactly this document, at that path
   *  or wherever a Rename moved it. A list, not keyed by path: a later create can reuse the path a rename freed. */
  created?: string[];
  /** Set by an Apply that landed: the guid of the TOP-LEVEL entity its instance hangs under. The rebuild ≡ reload check
   *  (#1880 T2) leaves that subtree out, since an Apply rewrites its own instance's statements, not only the template. */
  appliedTop?: string;
  /** The leaf rows `removeLeaf` took out, newest last, for `restoreLeaf` to put back: the document's id and the row. */
  removedRows?: Array<{ docId: string; row: Record<string, unknown> }>;
  /** Set by an Assets file op that landed (a trash: `to` null; a rename): it is not undoable (#1868, owner ruling D2), so
   *  the runner carries it into the segment's baseline rather than expecting the walk to put it back. */
  fileOp?: { from: string; to: string | null };
}

const liveGuids = () => new Set(authored().map((e) => e.guid).filter((g): g is string => !!g));

/** A prefab document's content under #1892's one "same document" rule ({@link markFree}), keys sorted: a frame expanded
 *  before an Apply that was then undone is current, as the undo keeps the mark it raised on the same rows (#1913, hunt
 *  seed 3066). */
const docContent = (doc: object): string => canonicalJson(markFree(doc));

/** #1820: when a Paste RETURNS — before anything is awaited — every frame it made is on the cached copy of its prefab,
 *  whenever every prefab in the pasted tree is cached: the rebase is synchronous then, and an async one would be a
 *  window a world switch can land in (#1833). The settle after the op cannot tell the two apart; this can. */
function requirePastedFramesCurrent(pre: ReadonlySet<string>): void {
  const pasted = authored().filter((e) => e.guid && !pre.has(e.guid));
  const sources = pasted.map((e) => piOf(e.id)?.source).filter((s): s is string => !!s);
  if (sources.some((src) => !getCachedPrefabSync(src))) return; // a fetch is needed: the async rebase is the right one
  const world = getCurrentWorld();
  for (const e of pasted) {
    const pi = piOf(e.id);
    if (!pi?.source || pi.rootInstanceId !== e.id) continue;
    const rec = frameRootDoc(world, findEntity(e.id)!);
    if (rec && docContent(rec.doc) !== docContent(getCachedPrefabSync(pi.source)!)) {
      throw new Error(`harness: pasted frame "${e.name}" is still expanded from an older ${pi.source} when the paste returns (#1820)`);
    }
  }
}
function subtreeGuids(rootId: number): string[] {
  const all = authored(); const out: string[] = []; const ids = new Set([rootId]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (!ids.has(e.id) && e.parentId !== undefined && ids.has(e.parentId)) { ids.add(e.id); grew = true; } }
  for (const e of all) if (ids.has(e.id) && e.guid) out.push(e.guid);
  return out;
}

export type Outcome = 'done' | 'noop' | 'refused';

const pick = <T,>(u: number, arr: readonly T[]): T | undefined => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(u * arr.length))] : undefined);
const meta = (name: string) => getTraitByName(name)!;
const noSelect = () => {};

/** Every prefab DOCUMENT the run has seen that is in no file now (by id), with the last path and text it had. One whose
 *  last path another file holds now is left out: restored there, it would overwrite that file. */
export function deletedPrefabs(st: RunState): Array<[string, string]> {
  const idOf = (t: string) => { try { return (JSON.parse(t) as { id?: string }).id; } catch { return undefined; } };
  const present = new Set([...st.be.snapshot()].filter(([p]) => p.endsWith('.prefab.json')).map(([, t]) => idOf(t)));
  return [...(st.lastPrefabs ?? new Map<string, [string, string]>())].filter(([id, [p]]) => !present.has(id) && st.be.read(p) === undefined).map(([, entry]) => entry);
}

/** Prefab files on disk, sorted. */
function prefabFiles(st: RunState): string[] {
  return [...st.be.snapshot().keys()].filter((p) => p.endsWith('.prefab.json')).sort();
}

/** A gesture the editor may refuse in prefab edit (#1817, #1836): the panels toast the refusal, so here it is an outcome,
 *  not a failure. Anything else it throws still is one. */
async function editRefusable(gesture: () => Outcome | Promise<Outcome>, st: RunState): Promise<Outcome> {
  try {
    return await gesture();
  } catch (e) {
    // Only in a prefab-edit WORLD, the refusal's own ground truth (not `editing()`, which also needs the session flag):
    // outside one the refusal must never fire, and a gesture it refused there is a finding. The one reason that holds
    // in the scene too is a new child under a Missing Prefab placeholder (#1831 M2).
    if (!(e instanceof PrefabEditRefusalError) || (!isPrefabEditWorld() && e.reason !== 'under-missing-prefab')) throw e;
    st.note = e.message;
    return 'refused';
  }
}

/** A prefab dropped into the Hierarchy, as `Hierarchy.tsx`'s drop handler does it: read the file, instantiate, push. */
async function dropPrefab(path: string, parentId: number): Promise<Outcome> {
  // The Hierarchy's own drop (`placePrefabFromPath`), not a copy of it: a copy kept the raw parent id after the drop
  // itself stopped holding one (#1793), and the harness would have gone on reproducing a bug the editor no longer has.
  const gone = await fetch(path).then((r) => !r.ok, () => true);
  if (gone) return 'noop';
  const id = await placePrefabFromPath(path, { tag: 'fuzz', parentId });
  return id ? 'done' : 'refused';
}

/** The entity draw `u` makes among `all`; when it lands on one `allowed` refuses (a gesture #1869 refuses: moving, cutting
 *  or saving as a prefab an object a prefab supplies), the draw `u` makes among the allowed ones instead. So a seed whose
 *  draw was already legal replays exactly as it did before #1869, and only a draw that reached a refused gesture moves. */
function legalPick<T extends { id: number }>(u: number, all: T[], allowed: (x: T) => boolean): T | undefined {
  const first = pick(u, all);
  if (!first || allowed(first)) return first;
  return pick(u, all.filter(allowed));
}

/** `Hierarchy.tsx`'s `requestReparent`, with the scene-move modal answered "Move". */
function requestReparent(entityId: number, newParentId: number): Outcome {
  const plan = planReparent(entityId, newParentId);
  if (plan.kind === 'refused') return 'refused';
  return applyReparent(entityId, newParentId).ok ? 'done' : 'refused';
}

/** The keys the Apply/Revert dialog lists for an instance, and a selection among them: all, one component's, or one. */
function selectKeys(root: number, prefab: PrefabFile, mode: 'apply' | 'revert', u: number, u2: number): Set<string> {
  const keys = collectInstanceOverrideKeys(root, prefab);
  const all = mode === 'apply' ? [...keys.all, ...keys.nested] : [...keys.all];
  if (all.length === 0) return new Set();
  // The dialog's Apply All / Revert All: what it checks to start, which leaves the root's default overrides at their
  // default target, the instance's own prefab (#1831). A later "Apply all to" re-checks them (`retargetChecks`, below).
  if (u < 0.45) { const leave = effectiveDefaults(keys.defaultOverrides, {}, prefab.id ?? '', () => undefined); return new Set(all.filter((k) => !leave.has(k))); }
  const one = pick(u2, all)!;
  if (u < 0.7) {
    // One component, as its checkbox toggles it: every field key of the same member and trait (`<member>.<Trait>.<field>`).
    const m = /^(.*)\.([A-Za-z0-9]+)\.[^.]+$/.exec(one);
    if (m) return groupToggle(new Set(), all.filter((k) => k.startsWith(`${m[1]}.${m[2]}.`)), new Set(keys.defaultOverrides), 'on');
  }
  return new Set([one]);
}

const TRANSFORM_FIELDS = ['x', 'y', 'z', 'rx', 'sx'];
const ADDABLE = ['Rotate3D', 'Renderable3DPrimitive'];
/** Transform is a core trait: the Inspector offers no Remove for it (`traitRemoveRefusal`). */
const REMOVABLE = ['Rotate3D', 'Renderable3DPrimitive'];

/** The value the member's effective base gives `field` of its Transform (`instanceBase`: the frame's document under
 *  every enclosing row), or undefined when the member's row is not found. An absent field is the schema default. */
function baseTransformValue(id: number, field: string): number | undefined {
  const pi = piOf(id);
  if (!pi) return undefined;
  const doc = frameRootDoc(getCurrentWorld(), findEntity(pi.rootInstanceId) as never)?.doc ?? getCachedPrefabSync(pi.source);
  if (!doc) return undefined;
  const row = instanceBase(pi.rootInstanceId, doc as PrefabFile).entities.find((r) => r.localId === pi.localId);
  if (!row) return undefined;
  const tf = (row.traits as { Transform?: Record<string, number> }).Transform ?? {};
  return typeof tf[field] === 'number' ? tf[field] : field.startsWith('s') ? 1 : 0;
}

/** `outsideEdit`'s `toOverride` and `restoreLeaf` (see `Op.variant`). */
function outsideVariant(op: Op, st: RunState): Outcome {
  const u = op.u;
  if (op.variant === 'restoreLeaf') {
    const last = st.removedRows?.at(-1);
    const path = last ? st.lastPrefabs?.get(last.docId)?.[0] : undefined;
    const text = path ? st.be.read(path) : undefined;
    if (!last || !path || !text) return 'noop';
    const doc = JSON.parse(text) as PrefabFile;
    const parent = (last.row.traits as { EntityAttributes?: { parentId?: number } })?.EntityAttributes?.parentId;
    if (doc.entities.some((r) => r.localId === last.row.localId) || !doc.entities.some((r) => r.localId === parent)) return 'noop';
    doc.entities.push(last.row as never);
    st.removedRows!.pop();
    st.be.write(path, `${JSON.stringify(doc, null, 2)}\n`);
    st.note = `restored ${String(last.row.name)} (${String(last.row.localId)}) to ${path}`;
    return 'done';
  }
  // toOverride: a member with a recorded Transform field, whose frame's template row is in a file the run knows.
  const cands = authored().flatMap((e) => {
    const pi = piOf(e.id);
    const ent = findEntity(e.id);
    if (!pi || !ent || !e.traits.includes('Transform')) return [];
    const path = st.lastPrefabs?.get(pi.source)?.[0];
    if (!path || !st.be.read(path)) return [];
    const fields = [...(getOverrideMarkSet(ent) ?? [])].filter((m) => m.startsWith('Transform.')).map((m) => m.slice(10)).sort();
    return fields.map((f) => ({ id: e.id, pi, path, f }));
  });
  const c = pick(u[1], cands);
  if (!c) return 'noop';
  const doc = JSON.parse(st.be.read(c.path)!) as PrefabFile;
  const row = doc.entities.find((r) => r.localId === c.pi.localId && (!c.pi.nodeGuid || r.nodeGuid === c.pi.nodeGuid));
  if (!row) return 'noop';
  const tf = ((row.traits as Record<string, unknown>).Transform ??= {}) as Record<string, unknown>;
  tf[c.f] = (readTraitData(c.id, meta('Transform')) as Record<string, unknown>)[c.f];
  st.be.write(c.path, `${JSON.stringify(doc, null, 2)}\n`);
  st.note = `template ${c.path} row ${row.localId} Transform.${c.f} := the instance's override`;
  return 'done';
}

/** Run one op. Throws only on a real failure (an exception from the editor); a refusal or a no-op returns. */
export async function execute(op: Op, st: RunState): Promise<Outcome> {
  const u = op.u;
  breakUndoCoalescing();
  const ents = authored();
  switch (op.kind) {
    case 'createPrefab': {
      if (editing()) return 'noop';
      // Part of a prefab instance is not saved as a prefab (#1869, Unity's rule), so the op draws from what may be.
      const supplied = suppliedByPrefabChecker(); // `partOfInstanceRefusal`'s predicate, built once for the draw
      const e = legalPick(u[0], ents, (x) => !supplied(x.id));
      if (!e) return 'noop';
      const safe = (e.name || 'Entity').replace(/[^a-zA-Z0-9_-]/g, '_');
      const coveredBefore = subtreeGuids(e.id);
      const target = `${st.f.root}/prefabs/${safe}.prefab.json`;
      const priorText = st.be.snapshot().get(target) ?? '';
      const result = await createPrefabFromEntity(e.id, target, `Save prefab "${e.name}"`, async () => u[1] < 0.7);
      if (result === 'declined') return 'noop';
      if (!result || 'refused' in result) { st.note = result ? String(result.refused) : 'createPrefabFromEntity returned null'; return 'refused'; }
      pushAction(result.action);
      for (const g of coveredBefore) st.touched.create.add(g);
      // And the guids the tag stamped: Create Prefab re-derives its members' guids, so the tree's guids after it are
      // new (a later failure on that tree names these).
      for (const g of subtreeGuids(e.id)) st.touched.create.add(g);
      // And the rows' nodeGuids the write introduced (a member path in a later diff is keyed by them; a Replace's
      // rows the file already had are not this create's).
      const nodeGuids = (t: string) => new Set([...t.matchAll(/"nodeGuid":\s*"([^"]+)"/g)].map((m) => m[1]));
      const prior = nodeGuids(priorText);
      for (const g of nodeGuids(st.be.snapshot().get(target) ?? '')) if (!prior.has(g)) st.touched.create.add(g);
      const wrote = st.be.snapshot().get(result.savePath);
      if (!priorText && wrote !== undefined) (st.created ??= []).push(wrote);
      return 'done';
    }
    case 'instantiate': {
      // Any prefab, the one being edited included, anywhere: the editor's prefab-edit refusal is part of what is tested.
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      const parent = u[1] < 0.4 ? 0 : (pick(u[2], ents)?.id ?? 0);
      const pre = liveGuids();
      const r = await editRefusable(() => dropPrefab(path, parent), st);
      for (const g of liveGuids()) if (!pre.has(g)) st.touched.drop.add(g);
      return r;
    }
    case 'detach': {
      const e = pick(u[0], ents.filter((x) => piOf(x.id)));
      if (!e) return 'noop';
      // The Hierarchy greys Detach on anything but an outermost instance root and names that root (`detachRefusal`,
      // #1764, #1869 — Unity's Unpack): the person detaches the root it names.
      const refused = detachRefusal(e.id);
      const root = refused ? refused.rootId : e.id;
      if (!root) return 'refused';
      for (const g of subtreeGuids(root)) st.touched.detach.add(g);
      detachPrefabInstanceWithUndo(root, 'Detach prefab', '[fuzz]');
      return 'done';
    }
    case 'duplicate': {
      const e = pick(u[0], ents);
      if (!e) return 'noop';
      return editRefusable(() => (duplicateEntity(e.id, noSelect) == null ? 'refused' : 'done'), st);
    }
    case 'copy':
    case 'cut': {
      // A cut is spent by a move, so it draws from what may move, as `reparent` does (#1869); a copy takes anything.
      const supplied = suppliedByPrefabChecker();
      const e = op.kind === 'cut' ? legalPick(u[0], ents, (x) => !supplied(x.id)) : pick(u[0], ents);
      if (!e) return 'noop';
      st.clip = clipEntity(e.id, op.kind);
      return st.clip ? 'done' : 'refused';
    }
    case 'paste': {
      if (!st.clip) return 'noop';
      const parent = u[0] < 0.3 ? 0 : (pick(u[1], ents)?.id ?? 0);
      if (st.clip.op === 'cut') {
        const src = cutSourceId(st.clip);
        if (src == null) { st.clip = null; return 'noop'; }
        const r = requestReparent(src, parent);
        if (r === 'done') st.clip = null;
        return r;
      }
      const pre = liveGuids();
      const clip = st.clip;
      const r = await editRefusable(() => { pasteEntityCopy(clip.snapshot, parent, noSelect); requirePastedFramesCurrent(pre); return 'done'; }, st);
      for (const g of liveGuids()) if (!pre.has(g)) st.touched.paste.add(g);
      return r;
    }
    case 'delete': {
      const e = pick(u[0], ents);
      if (!e) return 'noop';
      // The prefab-edit root included: the editor refuses its delete (#1836), and that refusal is part of what is tested.
      return editRefusable(() => { deleteEntitiesWithUndo([e.id]); return 'done'; }, st);
    }
    case 'editField': {
      const e = pick(u[0], ents.filter((x) => x.traits.includes('Transform') && (op.variant !== 'toBase' || !!piOf(x.id))));
      if (!e) return 'noop';
      const field = pick(u[1], TRANSFORM_FIELDS)!;
      const value = op.variant === 'toBase' ? baseTransformValue(e.id, field) : Math.round(u[2] * 20 - 10);
      if (value === undefined) { st.note = 'no base for the field'; return 'noop'; }
      // A refusal is the placeholder gate's (#1818): the save would drop the edit.
      return writeTraitFieldWithUndo(e.id, meta('Transform'), field, value) ? 'refused' : 'done';
    }
    case 'addComponent': {
      const e = pick(u[0], ents);
      if (!e) return 'noop';
      const name = pick(u[1], ADDABLE.filter((t) => !e.traits.includes(t)));
      if (!name) return 'noop';
      return addTraitToEntitiesWithUndo([e.id], meta(name)) ? 'refused' : 'done';
    }
    case 'removeComponent': {
      // Drawn from the entities that HAVE a removable component: drawing any entity first left this a no-op 97% of the
      // time (the coverage tally of the first 100-seed hunt).
      const e = pick(u[0], ents.filter((x) => REMOVABLE.some((t) => x.traits.includes(t))));
      if (!e) return 'noop';
      const name = pick(u[1], REMOVABLE.filter((t) => e.traits.includes(t)));
      if (!name) return 'noop';
      return removeTraitFromEntitiesWithUndo([e.id], meta(name)) ? 'refused' : 'done';
    }
    case 'addChild': {
      const parent = u[0] < 0.25 ? 0 : (pick(u[1], ents)?.id ?? 0);
      const { specs } = emptySpecs(parent);
      const name = `N${Math.floor(u[2] * 1000)}`;
      const named = specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name } } : s));
      return editRefusable(() => (createEntityWithUndo(`Create ${name}`, parent, named, noSelect) == null ? 'refused' : 'done'), st);
    }
    case 'reparent': {
      // The Hierarchy drag of what may move: a scene-added node, a stored instance root, a plain entity. An object a
      // prefab supplies is refused by `restructureRefusal` (#1869, Unity's "Cannot restructure Prefab instance"), so the
      // op does not spend its draw on it (`legalPick`): to the root, or anywhere.
      const supplied = suppliedByPrefabChecker();
      const e = legalPick(u[0], ents, (x) => !supplied(x.id));
      if (!e) return 'noop';
      const parent = u[1] < 0.2 ? 0 : (pick(u[2], ents)?.id ?? 0);
      return requestReparent(e.id, parent);
    }
    case 'apply':
    case 'revert': {
      const root = pick(u[0], ents.filter((x) => isInstanceRoot(x.id)))?.id;
      if (root == null) return 'noop';
      const source = piOf(root)!.source;
      await preloadNestedPrefabsForSubtree(root);
      const prefab = getCachedPrefabSync(source);
      if (!prefab) { st.note = `no cached prefab for ${source}`; return 'noop'; }
      // (Until #1869 a fifth of the Applies first moved a member within its frame, to write a row move. A member no
      // longer moves, so no gesture authors one.)
      const sel = selectKeys(root, prefab, op.kind, u[1], u[2]);
      if (sel.size === 0) return 'noop';
      if (op.kind === 'revert') {
        const refusal = await revertRefusal(root);
        if (refusal) { st.note = refusal; return 'refused'; }
        return (await revertOverridesWithUndo(root, sel)) ? 'done' : 'refused';
      }
      const opts = applyTargetOptions(root, prefab, [...sel]);
      let choice = initialTargets(opts);
      if (u[3] < 0.35) {
        // In the order the dialog lists them, not sorted: a prefab this run created has a minted guid, and sorting by
        // guid made the choice differ between replays (review).
        const targets = [...new Set([...opts.values()].flatMap((t) => t.options.map((o) => o.target)))];
        const t = pick(u[4], targets);
        if (t) {
          choice = setAllTargets(choice, opts, sel, t);
          // As the dialog: a default override that is an ordinary override at `t` (a nested instance's root placement sent
          // into the prefab that contains it) is checked, and takes `t` (#1831). Its targets are read apart from `opts`,
          // so the pick above draws from the same list it always did and recorded replays keep their meaning.
          const defaults = collectInstanceOverrideKeys(root, prefab).defaultOverrides;
          const dOpts = applyTargetOptions(root, prefab, defaults);
          const d0 = initialTargets(dOpts);
          const d1 = setAllTargets(d0, dOpts, defaults, t);
          for (const k of retargetChecks(sel, defaults, d0, d1, source, () => undefined)) if (!sel.has(k)) { sel.add(k); choice = { ...choice, [k]: d1[k]! }; }
        }
      }
      const targets = toApplyTargets(choice, sel);
      const preview = await previewApply(root, new Set(sel), targets);
      const blocked = applyBlocked({ ...preview, request: 'r' }, 'r');
      if (blocked) { st.note = blocked; return 'refused'; }
      const topGuid = (() => { let id = root; for (let e = ents.find((x) => x.id === id); e?.parentId; e = ents.find((x) => x.id === id)) id = e.parentId; return ents.find((x) => x.id === id)?.guid; })();
      const result = await applyToPrefabWithUndo(root, sel, targets, { expect: preview.fingerprint });
      if (result.refused) { st.note = result.refused; return 'refused'; }
      st.appliedTop = topGuid;
      return result.applied ? 'done' : 'refused';
    }
    case 'prefabEdit': {
      if (editing()) return 'noop';
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      const name = path.split('/').pop()!.replace(/\.prefab\.json$/, '');
      const refusal = await openPrefabForEditing({ path, name }, { confirmDiscard: async () => true });
      if (refusal) { st.note = refusal.refused; return 'refused'; }
      if (!editing()) { st.note = 'prefab edit did not open'; return 'refused'; }
      for (const inner of op.inner ?? []) await execute(inner, st);
      let saved = false;
      if (u[1] < 0.65) {
        const r = await savePrefabEditReport({});
        saved = r.saved;
        if (!r.saved) st.note = `prefab edit save: ${r.conflict ? 'conflict' : r.warnings.join('; ') || 'not saved'}`;
      }
      await exitPrefabEditing();
      st.prefabEditSaved = saved;
      return 'done';
    }
    case 'undo':
    case 'redo': {
      const n = 1 + Math.floor(u[0] * 3);
      for (let i = 0; i < n; i++) {
        const r = await undoStep(op.kind);
        // A step that threw part-way is a failure; an UndoRefusedError (nothing applied) is a refusal, which the runner
        // judges by whether anything outside the stack has changed the files since the segment began.
        if (r.failed && !r.failed.refused) throw new Error(`${op.kind} "${r.failed.label}" threw: ${r.failed.error}`);
        if (r.refused || r.failed) { st.note = r.refused ?? r.failed!.error; return 'refused'; }
        if (!r.did) break;
      }
      return 'done';
    }
    case 'saveReload': {
      if (editing()) return 'noop';
      // `op.save` (#1880 T1): Cmd+S as the editor runs it, Save All (`runSaveAll`): every PARKED prefab (an undone prefab
      // write, #1868) is flushed to its file BEFORE the scene is written. The scene-only save alone never landed a park, so
      // every bug that needs a park written between two undos (#1877 3b S1: the restore lowering the localId mark below
      // what a Save wrote) was out of reach. A conflict (the file changed under the park) is answered as the modal would
      // be, Overwrite or Cancel, by `u[2]`. `all-no-reload` stops at the save, as Cmd+S does: the reload drops the undo
      // stack, and the bugs a Save All exposes live in the undos AFTER it. No round trip is measured then.
      if (op.save) {
        const flushed = await answerParkedConflicts(await flushDirtyAssets(), async () => u[2] < 0.5);
        st.note = `save all: ${flushed.saved.length} parked flushed${flushed.failed.length ? `, ${flushed.failed.length} left parked` : ''}`;
        if (op.save === 'all-no-reload') {
          const saved = await saveScene({ allowDialog: false });
          if (!saved.saved) { st.note += `; save: ${saved.reason}`; return 'refused'; }
          st.note += '; no reload';
          return 'done';
        }
      }
      const before = worldTree();
      const unexpanded = unexpandedRows(); // the frames the live world could not expand (#1831 G1 M1, `forgiveExpandedFrames`)
      const s1 = await saveScene({ allowDialog: false });
      if (!s1.saved) { st.note = `save: ${s1.reason}`; return 'refused'; }
      const firstBytes = st.be.read(st.f.scenePath) ?? '';
      // A prefab the run DELETED (#1805): its live instances stay expanded — Unity keeps an instance's objects when its
      // asset is deleted — while a reload gives the Missing Prefab placeholder, so the live world cannot equal the reload.
      // What must hold instead is that the save LOST nothing: the same file, reloaded with the deleted prefabs put back,
      // is the live world. So: put them back, reload, measure, take them away again through the real delete repair, and
      // then do the ordinary reload. A deleted prefab is one whose DOCUMENT is in no file now (by id: a rename is not a
      // delete), put back at the last path it had.
      const gone = deletedPrefabs(st);
      let restored: unknown;
      if (gone.length) {
        // The loader's entry for each, as the dance found it: the restored reload fetches and OWNS it, and a production
        // reload never would for one the loader did not hold (a prefab created and deleted in the session), so the entry
        // the dance seeded goes again — or the ordinary reload below expands the deleted prefab from it (close-out review).
        const idOf = (t: string) => { try { return (JSON.parse(t) as { id?: string }).id; } catch { return undefined; } };
        const heldBefore = new Set(gone.filter(([, t]) => { const id = idOf(t); return !!id && getCachedPrefab(id) !== undefined; }).map(([p]) => p));
        for (const [p, t] of gone) st.be.write(p, t);
        // The renderer's manifest learns of them, as the watcher's push would (#1835).
        st.be.pushManifest();
        const back = await loadSceneReporting(st.f.scenePath);
        if (back.outcome !== 'loaded') throw new Error(`reload with the deleted prefabs restored: ${back.outcome}`);
        restored = worldTree();
        for (const [p] of gone) st.be.remove(p);
        st.be.pushManifest();
        applyAssetPathMoves(gone.map(([from]) => ({ from, to: null })));
        for (const [p] of gone) if (!heldBefore.has(p)) invalidatePrefab(p);
      }
      const loaded = await loadSceneReporting(st.f.scenePath);
      if (loaded.outcome !== 'loaded') throw new Error(`reload: ${loaded.outcome}`);
      const after = worldTree();
      // Said in the trace, so a test can see the plain reload really gave placeholders (production's shape), not an
      // expansion from an entry the dance left behind.
      if (gone.length) st.note = `${st.note ? `${st.note}; ` : ''}${gone.length} deleted prefab(s) restored for the comparison; ${placeholderGuids().size} placeholder(s) on the plain reload`;
      const s2 = await saveScene({ allowDialog: false });
      if (!s2.saved) throw new Error(`second save: ${s2.reason}`);
      st.roundTrip = { before, after, firstBytes, secondBytes: st.be.read(st.f.scenePath) ?? '', ...(gone.length ? { restored, unexpanded } : {}) };
      return 'done';
    }
    case 'trashPrefab': {
      if (editing()) return 'noop';
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      // `Assets.tsx`'s `executeDeletion` for one asset, confirmed: no undo entry (#1868, owner ruling D2).
      const deletePaths = deletionPathsFor(path, 'prefab', null);
      const del = await deleteAssetFiles(deletePaths);
      if (!del.ok) { st.note = 'delete did not complete'; return 'refused'; }
      const outcome = planDeleteOutcome(deletePaths, [path], del.failed);
      unbindDeletedAssetEditors(outcome.went);
      st.fileOp = { from: path, to: null };
      return 'done';
    }
    case 'renamePrefab': {
      if (editing()) return 'noop';
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      const base = `R${Math.floor(u[1] * 100)}`;
      const plan = planRename(path, base, prefabFiles(st));
      if (!plan.ok) return 'noop';
      const moved = await moveAsset(path, plan.toPath);
      if (!moved.ok) { st.note = `move refused: ${moved.error}`; return 'refused'; }
      applyAssetPathMoves([{ from: path, to: plan.toPath, name: plan.base }]);
      st.fileOp = { from: path, to: plan.toPath }; // no undo entry (#1868, owner ruling D2)
      return 'done';
    }
    case 'outsideEdit': {
      // A hand edit of a prefab file, or a pull that merges another clone's edit: not the editor's own write, so the
      // watcher raises it. ONLY shapes a real producer writes, since a shape nothing writes reports a finding nobody can
      // hit (#1839). Two:
      //  - a value change (`Transform.x` of an existing row): a hand edit.
      //  - a new PLAIN row under a PLAIN row, numbered at or above the file's mark (`nextLocalId`, #1774): what an editor
      //    Add Child in prefab edit writes, arriving by a merge. Taking a number BELOW the mark is outside the editor's
      //    contract (the mark exists to stop exactly that), and it produced a false I7 (the hunt's seed 1142).
      // NOT generated: a plain row under a REFERENCE row (one with `prefab`). The editor writes a child of a nested
      // instance as a keyed `added` node on the reference row (docs/prefabs.md § reference row), never as a plain row,
      // and the loader derives such a row's guid from the nested frame's member with the same localId: a false I7 (win's
      // hunt seed 3130). Whether the loader should refuse that hand-edited shape is a separate, unfiled question.
      if (op.variant === 'toOverride' || op.variant === 'restoreLeaf') return outsideVariant(op, st);
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      const doc = JSON.parse(st.be.read(path)!) as PrefabFile & { nextLocalId?: number };
      if (op.variant === 'removeLeaf') {
        // A plain row with no child row, not the root, named by no move and no member token (a hand-maintained ref to it
        // would dangle: that is a different finding).
        const text = JSON.stringify(doc);
        const leaf = pick(u[1], doc.entities.filter((r) => !(r as { prefab?: unknown }).prefab && r.localId !== doc.rootLocalId
          && !doc.entities.some((c) => (c.traits as { EntityAttributes?: { parentId?: number } })?.EntityAttributes?.parentId === r.localId)
          && !text.includes('@member') && !(doc as { moved?: object }).moved));
        if (!leaf || !doc.id) return 'noop';
        doc.entities = doc.entities.filter((r) => r !== leaf);
        (st.removedRows ??= []).push({ docId: doc.id, row: leaf as unknown as Record<string, unknown> });
        st.note = `removed ${leaf.name} (${leaf.localId}) from ${path}`;
      } else if (u[3] < 0.5) {
        const row = pick(u[1], doc.entities.filter((r) => (r.traits as Record<string, unknown>)?.Transform));
        if (!row) return 'noop';
        const tf = (row.traits as Record<string, Record<string, number>>).Transform;
        tf.x = Math.round(u[2] * 20 - 10);
      } else {
        const parent = pick(u[1], doc.entities.filter((r) => !(r as { prefab?: unknown }).prefab));
        if (!parent || typeof parent.localId !== 'number') return 'noop';
        const localId = Math.max(doc.nextLocalId ?? 0, Math.max(0, ...doc.entities.map((r) => r.localId ?? 0)) + 1);
        const hex = (x: number, w: number) => Math.floor(x * 16 ** w).toString(16).padStart(w, '0');
        const nodeGuid = `9${hex(u[4], 7)}-${hex(u[5], 4)}-4${hex(u[6], 3)}-8${hex(u[7], 3)}-${hex(u[2], 12)}`;
        doc.entities.push({ localId, name: 'Pulled', nodeGuid, traits: { EntityAttributes: { name: 'Pulled', parentId: parent.localId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } } as never);
      }
      st.be.write(path, `${JSON.stringify(doc, null, 2)}\n`);
      return 'done';
    }
  }
}

