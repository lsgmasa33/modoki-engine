/** Per-scene dirty tracking for multi-scene save (scene-loading.md
 *  Phase 12, M2). `hasUnsavedChanges()` (serialize.ts) answers "is there ANY unsaved
 *  live-world work" for the destructive load_scene/new_scene guard — this module adds
 *  a second, finer-grained question `saveAll` needs: "which SPECIFIC BASE scenes does
 *  that work belong to". A field edit on a base entity must mark the base dirty so
 *  saveAll knows to write its file too.
 *
 *  Only BASE scenes are ever tracked here — an entity with an empty `sourceScene`
 *  (Phase 3's "empty means primary" rule) resolves to nothing and is skipped. The
 *  primary itself doesn't need this: `saveAll` always attempts it via `saveScene`,
 *  driven by its own state token in serialize.ts (`hasUnsavedChanges`), independent of
 *  this module. That is also what keeps this module's own dependency footprint light
 *  — no `SceneManager` import, so pulling it into `entityActions.ts` (a foundational,
 *  widely-mocked module) doesn't drag SceneManager's heavy loader-cache graph into
 *  every unit test that touches a trait edit. Scenes are tracked by guid, matching
 *  `EntityAttributes.sourceScene`'s own values directly. */

import { findEntity, readTraitData, writeTraitField, getAllEntities, subtreeIds } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { mintStateToken, UNREACHABLE_STATE } from '../undo/stateToken';

// ── Dirty = "not at its saved state" (#1904) ──────────────────────────────────
// A scene is dirty while its state token differs from the token it was saved (or loaded) at. The undo manager moves a
// scene's token forward on an edit and puts the entry's before/after token back on an undo/redo, so undoing every edit
// back to the saved state reads clean, as Unity does. It used to be a latch that only a save or a load cleared.
// A guid in neither map reads as `_epoch` in both, which is clean: the scene is as loaded. Each world replacement mints
// a new epoch, so an entry recorded before it — whose tokens name the OLD epoch — can never land a reloaded scene on
// "saved" (a kept stack's undo would otherwise read clean against a file that changed since).
const current = new Map<string, number>();
const saved = new Map<string, number>();
let _epoch = mintStateToken();

function currentOf(guid: string): number { return current.get(guid) ?? _epoch; }
function savedOf(guid: string): number { return saved.get(guid) ?? _epoch; }

/** The state token scene `guid` is at now — what an undo entry records before it moves the scene. */
export function sceneStateToken(guid: string): number { return currentOf(guid); }

/** Put scene `guid` at state `token` — the undo manager's move for an edit, an undo or a redo. Never pass a token the
 *  scene was not really in: this is what decides whether the scene reads saved. */
export function setSceneStateToken(guid: string, token: number): void {
  if (guid) current.set(guid, token);
}

/** Mark a scene (by guid) dirty from OUTSIDE the undo stack: no undo or redo can bring it back to saved, so it stays
 *  dirty until its next save or load. The undo manager does not call this — it moves tokens. Prefer
 *  `resolveAffectedScenes` + this when you already know the guid; use `markSceneDirtyForEntity` when you only have a
 *  live entity id. */
export function markSceneDirty(guid: string): void {
  if (guid) saved.set(guid, UNREACHABLE_STATE);
}

/** A live entity's raw `EntityAttributes.sourceScene` — '' (falsy) for a primary-owned
 *  entity or one with no EntityAttributes at all. Deliberately NOT resolved to the
 *  primary's own real guid (see the module doc comment for why). */
export function rawSourceScene(entityId: number): string {
  const meta = getTraitByName('EntityAttributes');
  const entity = meta ? findEntity(entityId) : null;
  const data = entity?.has(meta!.trait) ? (entity.get(meta!.trait) as { sourceScene?: string }) : undefined;
  return data?.sourceScene || '';
}

/** The scene a subtree CREATED under `parentId` belongs to: its parent's, or the primary at the root (#1429, #1760). */
export function createTargetScene(parentId: number): string {
  return parentId ? rawSourceScene(parentId) : '';
}

/** Put a NEWLY CREATED subtree in its target's scene (#1429, owner option A): its parent's, or the primary at the
 *  root. Nothing moves, so nothing is prompted: the subtree is born where it was put. Without this a child created
 *  under a base entity is primary-owned under a base parent, the state `planReparent` exists to prevent. And a ROOT
 *  kept whatever stamp it arrived with (#1760): a paste carries its SOURCE's stamp, so a copy of a base entity pasted
 *  at the root of a level without that base was saved into no file, and lost on reload. A stamp that was AUTHORED
 *  (an agent `addEntity`) is not re-targeted here: the agent op refuses one that disagrees with this target before
 *  creating anything (`createTargetScene`; refuse, never re-target — scene-loading.md § Readers of the world).
 *  Raw writes with no undo: call it BEFORE the caller snapshots or resolves `affectedScenes`, so redo respawns the
 *  stamped copy and the right scene is marked dirty. Returns the scene the subtree now belongs to. */
export function adoptParentScene(rootId: number): string {
  const attrMeta = getTraitByName('EntityAttributes');
  const attrs = attrMeta ? readTraitData(rootId, attrMeta) : null;
  if (!attrMeta || !attrs) return '';
  const target = createTargetScene((attrs.parentId as number) || 0);
  const ids = subtreeIds(getAllEntities(), rootId);
  for (const id of ids) {
    if (rawSourceScene(id) !== target) writeTraitField(id, attrMeta, 'sourceScene', target);
  }
  return target;
}

/** Resolve the set of BASE scene guids a batch of LIVE entity ids belongs to, deduped
 *  (a primary-owned entity contributes nothing — see the module doc comment). Call
 *  this BEFORE a structural mutation (delete, reparent) that could destroy the entity
 *  or change its sourceScene — resolving after the fact may read stale/gone data.
 *  Field edits don't change sourceScene, so resolving before or after is equivalent
 *  for those, but "before" is the uniform, always-safe convention. */
export function resolveAffectedScenes(entityIds: number[]): string[] {
  const guids = new Set<string>();
  for (const id of entityIds) {
    const g = rawSourceScene(id);
    if (g) guids.add(g);
  }
  return [...guids];
}

/** Mark the scene a single live entity belongs to as dirty. Convenience wrapper over
 *  `resolveAffectedScenes` + `markSceneDirty` for the common one-entity case. */
export function markSceneDirtyForEntity(entityId: number): void {
  for (const g of resolveAffectedScenes([entityId])) markSceneDirty(g);
}

/** Scene `guid` is saved: its file now holds the state it was at when serialized — `atToken`, read with
 *  {@link sceneStateToken} BEFORE the write's await. An edit landing during the write moved the scene past that token,
 *  so it still reads dirty afterwards; defaulting to the token NOW would record that edit as written. Omit it only
 *  where the file and the world became the same synchronously. */
export function clearSceneDirty(guid: string, atToken: number = currentOf(guid)): void {
  saved.set(guid, atToken);
}

function isDirty(guid: string): boolean { return currentOf(guid) !== savedOf(guid); }

/** Every scene guid with unsaved live-world edits pending. A snapshot copy. */
export function dirtySceneGuidsSnapshot(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const g of current.keys()) if (isDirty(g)) out.add(g);
  for (const g of saved.keys()) if (isDirty(g)) out.add(g);
  return out;
}

/** Is ANY base scene dirty? The allocation-free form of `dirtySceneGuidsSnapshot().size > 0`.
 *
 *  Exists for `hasUnsavedChanges()` (serialize.ts), which is called on hot paths and from a 1s
 *  poll in `FindReferencesDialog` — the snapshot copies the whole Set to answer a question that
 *  needs no copy. Every other cause already had a cheap predicate (`hasDirtyAssets`,
 *  `hasPendingMeta`, `hasPendingBaseScenes`); this was the one that did not, and it is why
 *  `hasUnsavedChanges()` could not be derived from the cause table without getting slower. */
export function hasDirtyScenes(): boolean {
  for (const g of current.keys()) if (isDirty(g)) return true;
  for (const g of saved.keys()) if (isDirty(g)) return true;
  return false;
}

export function isSceneDirty(guid: string): boolean {
  return isDirty(guid);
}

/** Reset all dirty tracking — call on a scene load/new-scene, mirroring
 *  `markSceneSaved()`'s "the freshly loaded world matches disk" baseline. A stale
 *  dirty guid from the PREVIOUS chain (e.g. a base scene no longer in the new chain)
 *  must not linger and cause a later saveAll to try writing a scene that isn't loaded. */
export function clearAllSceneDirty(): void {
  clearSceneDirtyExcept(new Set());
}

/** The world-replacement form of `clearAllSceneDirty`: clear every flag EXCEPT a kept base's
 *  (#1417). `SceneManager.loadScene` carries a kept base's entities over from the live world, so
 *  its unsaved edits survive the swap. Clearing its flag then made `saveAll` skip the base and
 *  the unsaved-work guard stop asking, which lost the edit silently while it was still on screen.
 *  Every other flag goes, including a base that dropped out of the chain.
 *
 *  Every other scene starts a new epoch (#1904): it was reloaded from its file, so no token an undo entry recorded
 *  before now may read as its saved state. A KEPT base is not reloaded, but it moves to a fresh token too — still
 *  clean if it was clean, dirty until its next save if it was dirty: its old tokens were recorded by stacks that are
 *  parked or dropped now, and a stack of another scene sharing the base may have moved it since. Keeping them let a
 *  parked stack coming back undo/redo the base onto its saved token while another scene's unwritten edit was still in
 *  it, so Save All skipped the base and the next switch dropped the edit (#1904 close-out review F1, reproduced). The
 *  cost is conservative: an undo into a kept base after a swap reads unsaved until a save. Not Stop's route: its
 *  restore keeps the same stack, so it puts every token back as it was at the press (`restoreSceneTokens`). */
export function clearSceneDirtyExcept(keptGuids: ReadonlySet<string>): void {
  const dirtyKept = new Set([...keptGuids].filter(isDirty));
  current.clear();
  saved.clear();
  for (const g of keptGuids) {
    const fresh = mintStateToken();
    current.set(g, fresh);
    saved.set(g, dirtyKept.has(g) ? UNREACHABLE_STATE : fresh);
  }
  _epoch = mintStateToken();
}

/** Every scene's tokens, as a value Stop can put back. */
export interface SceneTokens { readonly current: ReadonlyMap<string, number>; readonly saved: ReadonlyMap<string, number>; readonly epoch: number }
export function captureSceneTokens(): SceneTokens {
  return { current: new Map(current), saved: new Map(saved), epoch: _epoch };
}
/** Stop's restore (#1904): the world is reverted to the Play-press snapshot and the SAME stack goes on, cut to Play's
 *  barrier, so every scene is back at the token it had at the press — its pre-Play entries still name it, and an undo
 *  or redo onto the saved state reads clean. Re-minting instead (the swap's route above) pinned a scene dirty after
 *  Stop even when that undo landed on its saved bytes (close-out re-review 1, then third review for a scene clean at
 *  the press). No other stack can come in: a scene change during Play skips the restore.
 *  `unknownState`: the snapshot may lack an edit made during its own awaits, so what the reverted world holds is not
 *  known — every scene edited since the load reads unsaved until its next save. */
export function restoreSceneTokens(tokens: SceneTokens, opts: { unknownState?: boolean } = {}): void {
  const savedAtStop = new Map(saved);
  current.clear();
  saved.clear();
  for (const [g, t] of tokens.current) current.set(g, t);
  for (const [g, t] of tokens.saved) saved.set(g, t);
  _epoch = tokens.epoch;
  // A scene SAVED since the press — Save All's base loop can land in Play's startup window, after the primary's own
  // write — wrote a world Stop has reverted, so its press-time saved token no longer names its file (#1904 close-out,
  // fifth review, reproduced: the base read clean over a file holding a startup-window edit). Unsaved until saved.
  // Only a real token is a save: `markSceneDirty`'s poison is not, and the restore rightly drops it with the edit.
  for (const [g, t] of savedAtStop) {
    if (t !== UNREACHABLE_STATE && t !== tokens.saved.get(g)) saved.set(g, UNREACHABLE_STATE);
  }
  if (opts.unknownState) forgetSceneSavedStates();
}
/** Every scene edited since the load reads unsaved until its next save: what its world holds is not known. */
export function forgetSceneSavedStates(): void {
  for (const g of current.keys()) saved.set(g, UNREACHABLE_STATE);
}

/** Is any scene dirty that is NOT in `keptGuids`? That is base-scene work a world replacement
 *  throws away, as opposed to work it carries (#1417). */
export function hasDirtySceneOutside(keptGuids: ReadonlySet<string>): boolean {
  for (const g of dirtySceneGuidsSnapshot()) if (!keptGuids.has(g)) return true;
  return false;
}
