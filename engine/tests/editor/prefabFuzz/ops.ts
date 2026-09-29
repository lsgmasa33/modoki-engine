/** The prefab fuzzer's operations (#1789): the generator, and one executor per op through the entry point the editor's
 *  own UI calls (the Hierarchy, the Inspector, the Apply dialog, the Assets panel, prefab edit).
 *
 *  An op is `{ kind, u }`: `u` is a list of floats in [0, 1) drawn when the list is generated, and every choice the
 *  executor makes (which entity, which key, which value) reads one of them against what the world holds WHEN THE OP
 *  RUNS. So a list stays runnable when the shrinker drops ops from it: an op whose choice has nothing to choose from
 *  is a recorded no-op, not an error. A prefab-edit op carries its own inner list, which the shrinker also trims. */

import { createWorld } from 'koota';
import { getTraitByName, seedRng, rngNext } from '@modoki/engine/runtime';
import { pushAction } from '@modoki/engine/editor';
import { createPrefabFromEntity, deleteAssetFiles, deletionPathsFor, moveFileTo, planDeleteOutcome, planRename } from '../../../packages/modoki/src/editor/panels/assetOps';
import { makeDeleteUndo, makeRenameUndo, snapshotFromBytes, type DeleteResult } from '../../../packages/modoki/src/editor/panels/assetUndo';
import { applyAssetPathMoves, unbindDeletedAssetEditors } from '../../../packages/modoki/src/editor/panels/assetEditorBindings';
import {
  instantiatePrefabInstance, getCachedPrefabSync, preloadNestedPrefabsForSubtree, previewApply, staleInstanceRefusal,
  type PrefabFile,
} from '../../../packages/modoki/src/editor/scene/prefab';
import { makePrefabInstantiateAction } from '../../../packages/modoki/src/editor/undo/prefabInstantiateUndo';
import { detachPrefabInstanceWithUndo } from '../../../packages/modoki/src/editor/undo/detachPrefabUndo';
import {
  duplicateEntity, clipEntity, cutSourceId, pasteEntityCopy, deleteEntitiesWithUndo, writeTraitFieldWithUndo,
  addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo, createEntityWithUndo, planReparent, applyReparent,
  type EntityClipboard,
} from '../../../packages/modoki/src/editor/undo/entityActions';
import { collectInstanceOverrideKeys } from '../../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyTargetOptions } from '../../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { initialTargets, setAllTargets, toApplyTargets, applyBlocked } from '../../../packages/modoki/src/editor/panels/applyDialogModel';
import { applyToPrefabWithUndo } from '../../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { revertOverridesWithUndo } from '../../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { undoStep, breakUndoCoalescing } from '../../../packages/modoki/src/editor/undo/undoManager';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../../packages/modoki/src/editor/scene/prefabEdit';
import { saveScene, loadSceneReporting } from '../../../packages/modoki/src/editor/scene/serialize';
import { emptySpecs } from '../../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { parseAssetJson, isMissingAsset } from '../../../packages/modoki/src/runtime/loaders/assetFetch';
import { deleteEntity } from '../../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { authored, piOf, isInstanceRoot, editing, worldTree, settle, type Fixture } from './harness';
import type { FuzzBackend } from './backend';

export type OpKind =
  | 'createPrefab' | 'instantiate' | 'detach' | 'duplicate' | 'copy' | 'cut' | 'paste' | 'delete'
  | 'editField' | 'addComponent' | 'removeComponent' | 'addChild' | 'reparent'
  | 'apply' | 'revert' | 'prefabEdit' | 'undo' | 'redo' | 'saveReload'
  | 'trashPrefab' | 'renamePrefab' | 'outsideEdit';

export interface Op { kind: OpKind; u: number[]; inner?: Op[] }

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
  return op.inner ? `${op.kind}(${u})[${op.inner.map(describe).join('; ')}]` : `${op.kind}(${u})`;
}

// ── Execution ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunState {
  be: FuzzBackend;
  f: Fixture;
  clip: EntityClipboard | null;
  /** What the round trip inside a save→reload op measured; the checks read it. */
  roundTrip?: { before: unknown; after: unknown; firstBytes: string; secondBytes: string };
  /** Set by an executor when an op could not run (nothing to choose, or the editor refused as the UI would show). */
  note?: string;
  /** Set by a prefab edit: whether it wrote the prefab (a discard changes no file the scene's undo cannot see). */
  prefabEditSaved?: boolean;
  /** Every guid a drop or a paste introduced, and every guid a detach or a Create Prefab covered, this run (a failure
   *  carries them). */
  touched: { drop: Set<string>; paste: Set<string>; detach: Set<string>; create: Set<string> };
}

const liveGuids = () => new Set(authored().map((e) => e.guid).filter((g): g is string => !!g));
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

/** Prefab files on disk, sorted. */
function prefabFiles(st: RunState): string[] {
  return [...st.be.snapshot().keys()].filter((p) => p.endsWith('.prefab.json')).sort();
}

/** A prefab dropped into the Hierarchy, as `Hierarchy.tsx`'s drop handler does it: read the file, instantiate, push. */
async function dropPrefab(path: string, parentId: number): Promise<Outcome> {
  let prefab: PrefabFile;
  try { prefab = await parseAssetJson(await fetch(path), path) as PrefabFile; } catch (e) { if (isMissingAsset(e)) return 'noop'; throw e; }
  const currentId = await instantiatePrefabInstance(prefab, path, parentId);
  // Pushed whatever the instantiate returned, as the Hierarchy's drop does (it has no refusal branch).
  pushAction(makePrefabInstantiateAction({
    label: `Instantiate "${prefab.name}"`,
    initialId: currentId,
    respawn: async () => {
      let p: PrefabFile;
      try { p = await parseAssetJson(await fetch(path), path) as PrefabFile; } catch (e) { if (isMissingAsset(e)) return null; throw e; }
      return instantiatePrefabInstance(p, path, parentId);
    },
    remove: (id) => { deleteEntity(id); },
  }));
  return currentId ? 'done' : 'refused';
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
  if (u < 0.45) return new Set(all);
  const one = pick(u2, all)!;
  if (u < 0.7) {
    // One component: every field key of the same member and trait (`<member>.<Trait>.<field>`).
    const m = /^(.*)\.([A-Za-z0-9]+)\.[^.]+$/.exec(one);
    if (m) return new Set(all.filter((k) => k.startsWith(`${m[1]}.${m[2]}.`)));
  }
  return new Set([one]);
}

const TRANSFORM_FIELDS = ['x', 'y', 'z', 'rx', 'sx'];
const ADDABLE = ['Rotate3D', 'Renderable3DPrimitive'];
/** Transform is a core trait: the Inspector offers no Remove for it (`traitRemoveRefusal`). */
const REMOVABLE = ['Rotate3D', 'Renderable3DPrimitive'];

/** Run one op. Throws only on a real failure (an exception from the editor); a refusal or a no-op returns. */
export async function execute(op: Op, st: RunState): Promise<Outcome> {
  const u = op.u;
  breakUndoCoalescing();
  const ents = authored();
  switch (op.kind) {
    case 'createPrefab': {
      if (editing()) return 'noop';
      const e = pick(u[0], ents);
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
      return 'done';
    }
    case 'instantiate': {
      // Any prefab, the one being edited included: the Hierarchy's drop has no prefab-edit guard, so neither does this.
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      const parent = u[1] < 0.4 ? 0 : (pick(u[2], ents)?.id ?? 0);
      const pre = liveGuids();
      const r = await dropPrefab(path, parent);
      for (const g of liveGuids()) if (!pre.has(g)) st.touched.drop.add(g);
      return r;
    }
    case 'detach': {
      const e = pick(u[0], ents.filter((x) => piOf(x.id)));
      if (!e) return 'noop';
      const root = piOf(e.id)!.rootInstanceId || e.id;
      for (const g of subtreeGuids(root)) st.touched.detach.add(g);
      detachPrefabInstanceWithUndo(root, 'Detach prefab', '[fuzz]');
      return 'done';
    }
    case 'duplicate': {
      const e = pick(u[0], ents);
      if (!e) return 'noop';
      return duplicateEntity(e.id, noSelect) == null ? 'refused' : 'done';
    }
    case 'copy':
    case 'cut': {
      const e = pick(u[0], ents);
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
      pasteEntityCopy(st.clip.snapshot, parent, noSelect);
      for (const g of liveGuids()) if (!pre.has(g)) st.touched.paste.add(g);
      return 'done';
    }
    case 'delete': {
      const e = pick(u[0], ents);
      if (!e) return 'noop';
      if (editing() && e.parentId === 0) return 'noop'; // the edit world's root is the prefab itself
      deleteEntitiesWithUndo([e.id]);
      return 'done';
    }
    case 'editField': {
      const e = pick(u[0], ents.filter((x) => x.traits.includes('Transform')));
      if (!e) return 'noop';
      const field = pick(u[1], TRANSFORM_FIELDS)!;
      const value = Math.round(u[2] * 20 - 10);
      writeTraitFieldWithUndo(e.id, meta('Transform'), field, value);
      return 'done';
    }
    case 'addComponent': {
      const e = pick(u[0], ents);
      if (!e) return 'noop';
      const name = pick(u[1], ADDABLE.filter((t) => !e.traits.includes(t)));
      if (!name) return 'noop';
      addTraitToEntitiesWithUndo([e.id], meta(name));
      return 'done';
    }
    case 'removeComponent': {
      // Drawn from the entities that HAVE a removable component: drawing any entity first left this a no-op 97% of the
      // time (the coverage tally of the first 100-seed hunt).
      const e = pick(u[0], ents.filter((x) => REMOVABLE.some((t) => x.traits.includes(t))));
      if (!e) return 'noop';
      const name = pick(u[1], REMOVABLE.filter((t) => e.traits.includes(t)));
      if (!name) return 'noop';
      removeTraitFromEntitiesWithUndo([e.id], meta(name));
      return 'done';
    }
    case 'addChild': {
      const parent = u[0] < 0.25 ? 0 : (pick(u[1], ents)?.id ?? 0);
      const { specs } = emptySpecs(parent);
      const name = `N${Math.floor(u[2] * 1000)}`;
      const named = specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name } } : s));
      return createEntityWithUndo(`Create ${name}`, parent, named, noSelect) == null ? 'refused' : 'done';
    }
    case 'reparent': {
      const e = pick(u[0], ents);
      if (!e) return 'noop';
      // Three shapes of the Hierarchy drag: to the root, anywhere, or inside the entity's own instance (a member moved
      // under another member of its frame — the move Apply writes into the template, #1437). Drawn uniformly, the last
      // almost never happened (the first 100-seed hunt called /api/prefab-member-paths zero times).
      const pi = piOf(e.id);
      const frame = pi && pi.rootInstanceId !== e.id ? pi.rootInstanceId : undefined;
      const sameFrame = frame ? ents.filter((x) => x.id !== e.id && (x.id === frame || piOf(x.id)?.rootInstanceId === frame)) : [];
      const parent = u[1] < 0.2 ? 0 : u[1] < 0.55 && sameFrame.length ? pick(u[2], sameFrame)!.id : (pick(u[2], ents)?.id ?? 0);
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
      // Directed, on a fifth of the Applies: first move one of the frame's own members under another member of the SAME
      // frame, then Apply all — the one gesture pair that writes a row move and so runs /api/prefab-member-paths (#1751).
      // Undirected, 400 hunt seeds never composed it (the route was called zero times). Reported as a generator change.
      let directed = false;
      if (op.kind === 'apply' && u[5] < 0.2) {
        const members = ents.filter((x) => x.id !== root && piOf(x.id)?.rootInstanceId === root);
        const mover = pick(u[6], members);
        const parents = mover ? [root, ...members.map((x) => x.id)].filter((id) => id !== mover.id && id !== mover.parentId) : [];
        const to = pick(u[7], parents);
        if (mover && to !== undefined && requestReparent(mover.id, to) === 'done') { directed = true; await settle(); }
      }
      const sel = selectKeys(root, prefab, op.kind, directed ? 0 : u[1], u[2]);
      if (sel.size === 0) return 'noop';
      if (op.kind === 'revert') {
        const refusal = staleInstanceRefusal(root);
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
        if (t) choice = setAllTargets(choice, opts, sel, t);
      }
      const targets = toApplyTargets(choice, sel);
      const preview = await previewApply(root, new Set(sel), targets);
      const blocked = applyBlocked({ ...preview, request: 'r' }, 'r');
      if (blocked) { st.note = blocked; return 'refused'; }
      const result = await applyToPrefabWithUndo(root, sel, targets, { expect: preview.fingerprint });
      if (result.refused) { st.note = result.refused; return 'refused'; }
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
      const before = worldTree();
      const s1 = await saveScene({ allowDialog: false });
      if (!s1.saved) { st.note = `save: ${s1.reason}`; return 'refused'; }
      const firstBytes = st.be.read(st.f.scenePath) ?? '';
      const loaded = await loadSceneReporting(st.f.scenePath);
      if (loaded.outcome !== 'loaded') throw new Error(`reload: ${loaded.outcome}`);
      const after = worldTree();
      const s2 = await saveScene({ allowDialog: false });
      if (!s2.saved) throw new Error(`second save: ${s2.reason}`);
      st.roundTrip = { before, after, firstBytes, secondBytes: st.be.read(st.f.scenePath) ?? '' };
      return 'done';
    }
    case 'trashPrefab': {
      if (editing()) return 'noop';
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      // `Assets.tsx`'s `executeDeletion` for one asset.
      const bytes = st.be.read(path);
      const deletePaths = deletionPathsFor(path, 'prefab', null);
      const asset = { path, name: path.split('/').pop()!.replace(/\.prefab\.json$/, ''), type: 'prefab' };
      const results: DeleteResult[] = [{ asset, snapshots: bytes === undefined ? [] : [snapshotFromBytes(path, new TextEncoder().encode(bytes))], deletePaths }];
      const del = await deleteAssetFiles(deletePaths);
      if (!del.ok) { st.note = 'delete did not complete'; return 'refused'; }
      const outcome = planDeleteOutcome(deletePaths, [path], del.failed);
      unbindDeletedAssetEditors(outcome.went);
      pushAction(makeDeleteUndo(results, () => {}, { missing: del.missing, failed: del.failed }));
      return 'done';
    }
    case 'renamePrefab': {
      if (editing()) return 'noop';
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      const base = `R${Math.floor(u[1] * 100)}`;
      const plan = planRename(path, base, prefabFiles(st));
      if (!plan.ok) return 'noop';
      if (!(await moveFileTo(path, plan.toPath))) { st.note = 'move refused'; return 'refused'; }
      applyAssetPathMoves([{ from: path, to: plan.toPath, name: plan.base }]);
      pushAction(makeRenameUndo({ originalPath: path, originalName: path.split('/').pop()!.replace(/\.prefab\.json$/, ''), toPath: plan.toPath, newName: plan.base, refresh: () => {} }));
      return 'done';
    }
    case 'outsideEdit': {
      // A hand edit of a prefab file, or a pull that merges another clone's edit: not the editor's own write, so the
      // watcher raises it. Two shapes: a value change, or a new row as a merged editor write numbers it, at or above
      // the file's mark (`nextLocalId`, #1774). Taking a number BELOW the mark is outside the editor's contract (the mark
      // exists to stop exactly that), and it produced a false I7 (the hunt's seed 1142).
      const path = pick(u[0], prefabFiles(st));
      if (!path) return 'noop';
      const doc = JSON.parse(st.be.read(path)!) as PrefabFile & { nextLocalId?: number };
      if (u[3] < 0.5) {
        const row = pick(u[1], doc.entities.filter((r) => (r.traits as Record<string, unknown>)?.Transform));
        if (!row) return 'noop';
        const tf = (row.traits as Record<string, Record<string, number>>).Transform;
        tf.x = Math.round(u[2] * 20 - 10);
      } else {
        const parent = pick(u[1], doc.entities);
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

