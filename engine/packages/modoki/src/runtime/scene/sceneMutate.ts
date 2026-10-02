/** Scene-file mutation — pure operations on the on-disk scene JSON shape.
 *
 *  The scene file is the source of truth (see docs/scene-loading.md). An agent
 *  mutates it through validated ops here instead of hand-editing raw JSON, then
 *  the dev-server watcher + hot-reload reflect the change in the browser. Pure
 *  and side-effect-free (GUID minting is injected), so it unit-tests without a
 *  live world and runs identically in Node (the dev server) and the browser.
 *
 *  Entity identity is by the scene file's numeric `id`, the top-level `name`,
 *  or the `EntityAttributes.guid`. New entities get the next free numeric id and
 *  a fresh guid. */

import { newGuid, durableGuid, findRuntimeGuids } from '../core/assetRefRules';
import { traitRemoveRefusal, traitWriteRefusal, fieldWriteRefusal } from '../core/ecs/traitEditPolicy';
import { parentLinkRefusal, type ParentGraph } from '../core/ecs/parentLink';
import { parentWorldTrs, localToWorldTrs, worldToLocalTrs, mergeTrs, persistedTrsKeys, collapsedParentAxes, storedTransformOf, fileHierarchy, fittedOnChain, reparentSuffixes, reparentWrite, isTemplatePlaced, sameTrsMatrix, sameRotationScale, IDENTITY_TRS, type TRS } from './transformSpace';

/** Minimal on-disk entity shape (matches editor SerializedEntity / runtime
 *  SceneEntityEntry — kept structural to avoid a cross-layer import). */
export interface MutableEntity {
  id: number;
  name?: string;
  traits: Record<string, Record<string, unknown> | boolean>;
  prefab?: string;
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  /** Prefab INSTANCE nodes store their identity guid at the node top level
   *  (not in EntityAttributes, which comes from the expanded prefab). */
  guid?: string;
}

export interface MutableScene {
  entities: MutableEntity[];
  [key: string]: unknown;
}

/** How an op refers to an existing entity. At least one field is required. */
export interface EntityRef {
  id?: number;
  name?: string;
  guid?: string;
}

/** The subset of the shared MCP `ErrorCode` union (`docs/mcp-tool-conventions.md` §5) this
 *  resolver can name precisely. Spelled out locally rather than imported — this file is
 *  `@modoki/engine`'s own published runtime (`rootDir: "./src"`), and a relative import
 *  reaching outside `packages/modoki/src` (into `engine/tools/shared`) would break its build.
 *  The VALUES still have to match the shared set exactly. That is enforced by the dedicated
 *  subset check in `engine/tests/tools/mcpErrorCodes.test.ts`, NOT by that file's reachability
 *  guard — which does not scan this package at all, and passes only because the same literals
 *  happen to appear in `app/debug/entityResolve.ts`. (This comment claimed the reachability
 *  guard covered it; the close-out review caught that, and the subset check was added.) */
export type EntityResolveCode = 'NOT_FOUND' | 'AMBIGUOUS';

export type MutateOp =
  /** `space` applies to `trait:'Transform'` ONLY. Omitted (the default) the fields are written
   *  VERBATIM — `x/y/z` etc. ARE the local fields, which is this op's literal contract. Pass
   *  `'world'` to give world-space values and have them converted against the parent chain.
   *  `modoki_set_transform` REQUIRES the caller to state the space; this low-level op keeps the
   *  literal default because writing trait fields is exactly what it is for. */
  | { op: 'setTrait'; entity: EntityRef; trait: string; fields?: Record<string, unknown>; space?: 'local' | 'world' }
  | { op: 'removeTrait'; entity: EntityRef; trait: string }
  | { op: 'addEntity'; name?: string; parentId?: number | string; traits?: Record<string, Record<string, unknown> | boolean> }
  | { op: 'removeEntity'; entity: EntityRef }
  | { op: 'setBaseScene'; baseScene: string | null };

export interface ApplyResult {
  scene: MutableScene;
  /** Number of ops that produced a change. */
  changed: number;
  /** Entity refs that matched NOTHING in this scene FILE. (C7)
   *
   *  This module is a pure function over the file — it cannot know whether such a ref
   *  exists in the LIVE world. That distinction is exactly what an agent needs ("does not
   *  exist" vs "exists live, not saved yet"), so report the refs and let a caller that CAN
   *  reach the renderer explain them. (The C7 save-state audit in docs/connect-claude-code.md
   *  assumed this resolver knew both; it does not, and cannot.) */
  unresolved: EntityRef[];
  /** What each `addEntity` op CREATED, in op order (S3.12).
   *
   *  `changed:N` alone left the agent to re-find its own new entity by name — which this very
   *  surface refuses outright when the name is ambiguous, so "create then edit" could dead-end on
   *  the second step. The sibling `create-entity` op returns `{id, name, guid}` for exactly this
   *  reason; both mutate paths now do too. Omitted (absent, not `[]`) when nothing was created, so
   *  a caller can't mistake "no adds in this batch" for "the add produced nothing". */
  created?: Array<{ op: number; id: number; guid: string; name: string }>;
  /** A trait an entity did NOT have, added because a `setTrait` set fields on it (#1216 C-12, #1223 D6):
   *  `{op, id, guid, trait}` in op order — the same row as the live path's. `changed:1` alone could not tell a field write from a new component,
   *  and a typo'd trait name that happens to be registered lands as a whole new trait. A no-fields
   *  `setTrait` (a tag) is not listed — adding is what it asked for. Absent when nothing was added.
   *  ⚠️ Only for an entity whose own `traits` are written: a prefab-instance root writes an override,
   *  and whether the PREFAB carries the trait is not visible from this file. */
  addedTraits?: Array<{ op: number; id: number; guid: string | undefined; trait: string }>;
  /** The descendants every `removeEntity` op took with the entity it named, for the whole call — see
   *  {@link AlsoDeletedFields}. Absent when no remove cascaded. */
  alsoDeleted?: string[];
  alsoDeletedNoGuidIds?: number[];
  alsoDeletedTotal?: number;
  /** Hard errors (entity not found, malformed op). Non-empty means some ops
   *  were skipped — the caller decides whether to still write. */
  errors: string[];
  /** Soft warnings — the op applied but produced a suspect result (a now-dangling
   *  entity ref after a remove, an addEntity under a non-existent parent). The agent
   *  reads these to self-correct; they do NOT block the write. */
  warnings: string[];
  /** The FIRST entity-resolution failure's machine code, if any op hit one — see
   *  `EntityResolveCode`. A single-op call is the common case, so the first failure is the
   *  one that actually blocked the op the caller cares about. */
  code?: EntityResolveCode;
  /** The ops, by index, that CHANGED something, and the ops that FAILED (#1910) — see {@link partialApplyVerdict}.
   *  Cleared with `changed` when the runtime-guid tripwire refuses the whole write, since nothing is then written. */
  appliedOps: number[];
  failedOps: number[];
}

/** The verdict for an op list whose ops apply ONE BY ONE (#1910) — both `/api/scene-mutate` paths, file and live.
 *
 *  Per-op is the contract, not an accident: what can only be learned while applying (an entity-not-found, a refused
 *  write) fails ITS op and the ops around it still apply (docs/mcp-tool-conventions.md § "Mutation semantics",
 *  the "proven wrong BEFORE starting" rule). The defect was the VERDICT. A mixed call answered `ok:false` with the failing op's own code
 *  (`NOT_FOUND`), and a caller reading that reasonably assumes nothing happened — and fixing the ref and resending the
 *  whole list would apply the ops that already landed a second time (an `addEntity` makes a duplicate). On the file
 *  path those ops were already on disk.
 *
 *  So a call where something changed AND something failed is `PARTIAL`, with the applied and failed ops named and a
 *  remedy that says not to resend the list. Decided on `changed`/`errors` alone, so a renderer too old to send the
 *  op lists still gets the right code; the lists are the detail. `null` when the call was not mixed — all-applied is
 *  `ok:true`, all-failed keeps its own code, and neither changed anything that a retry could repeat. */
export function partialApplyVerdict(
  r: { changed: number; errors: readonly string[]; appliedOps?: readonly number[]; failedOps?: readonly number[]; code?: string },
  appliedTo: 'live' | 'file',
): { code: 'PARTIAL'; error: string; options: string[]; appliedOps?: number[]; failedOps?: number[]; failedCode?: string } | null {
  if (r.changed <= 0 || r.errors.length === 0) return null;
  const list = (ops: readonly number[]) => ops.map((i) => `op[${i}]`).join(', ');
  // Counts only for a renderer too old to send the lists.
  const applied = r.appliedOps?.length ? list(r.appliedOps) : `${r.changed} op(s)`;
  const failed = r.failedOps?.length ? list(r.failedOps) : 'the ops named in `errors`';
  // ⚠️ The FILE path's ops are invisible to a live read: modoki_get_scene_state reads the open world, which is another
  // scene, or this one with the write held until a refresh (#1879). Sending the agent there to "check" shows it
  // nothing, and it resends the list — the double-apply this verdict exists to stop (close-out review).
  const where = appliedTo === 'live'
    ? 'They are in the LIVE world, as ONE undo step with the rest of this call, and not yet on disk.'
    : 'They are already WRITTEN to the scene file, and modoki_get_scene_state will NOT show them: it reads the open '
      + 'live world, if an editor is open at all — another scene (which shows them only once loaded), or this one with '
      + 'the write held until modoki_refresh.';
  return {
    code: 'PARTIAL',
    error: `PARTIALLY APPLIED — ${applied} applied and ${failed} failed. Ops apply one by one, and a failing op does `
      + `NOT undo the ones that applied: ${where} Do NOT resend the whole list — that applies ${applied} AGAIN `
      + '(an addEntity makes a duplicate). Fix and resend ONLY the failed ops.',
    options: [
      `resend only the failed ops (${failed}), fixed — never the whole list`,
      ...(appliedTo === 'live'
        ? [
          'modoki_get_scene_state — re-read what the applied ops did before retrying',
          'modoki_history {action:"undo"} — reverts the WHOLE call (it is one undo step), then resend all of it fixed',
        ]
        : [
          'trust this reply\'s receipts (`appliedOps`, `created`, `alsoDeleted`) for what landed — the file already holds them',
          'modoki_refresh — if this is the open scene, loads the held write, after which modoki_get_scene_state shows it',
        ]),
    ],
    ...(r.appliedOps ? { appliedOps: [...r.appliedOps] } : {}),
    ...(r.failedOps ? { failedOps: [...r.failedOps] } : {}),
    // The FIRST coded failure's code (NOT_FOUND / AMBIGUOUS), which PARTIAL replaces — not per op: an uncoded refusal (a
    // missing 'trait', a refused field) sets none, so with several failed ops it need not be `failedOps[0]`'s.
    ...(r.code ? { failedCode: r.code } : {}),
  };
}

/** How many cascaded descendants a delete reply names before it only counts them. */
export const ALSO_DELETED_CAP = 100;

/** What a delete took WITH the entities it was asked for (#1216 C-6, #1262), as reply fields: `alsoDeleted`
 *  (guids) + `alsoDeletedNoGuidIds`, and `alsoDeletedTotal` when more than the cap were taken. All absent
 *  when nothing cascaded. Every delete surface removes a whole subtree and used to answer only with what
 *  it was named, so a parent's delete removed its children without a word. Capped because the list is
 *  unbounded (a scene root's subtree is the scene) and an over-budget reply is elided whole. */
export interface AlsoDeletedFields { alsoDeleted?: string[]; alsoDeletedNoGuidIds?: number[]; alsoDeletedTotal?: number }

/** Builds {@link AlsoDeletedFields} across one or more deletes — the ONE shape every delete reply uses
 *  (`delete_entities` on both surfaces, both `removeEntity` backends). `room()` is how many more ids
 *  would still be listed, so a caller that must mint a guid before naming an entity mints only those. */
export function alsoDeletedTally() {
  const guids: string[] = [];
  const noGuidIds: number[] = [];
  let total = 0;
  const room = () => Math.max(0, ALSO_DELETED_CAP - guids.length - noGuidIds.length);
  return {
    room,
    /** Read the guids BEFORE the delete: afterwards a live descendant has none to read. */
    add(descendants: readonly number[], guidOf: (id: number) => string | null | undefined) {
      for (const id of descendants.slice(0, room())) {
        const g = guidOf(id);
        if (g) guids.push(g); else noGuidIds.push(id);
      }
      total += descendants.length;
    },
    fields(): AlsoDeletedFields {
      if (!total) return {};
      return {
        alsoDeleted: [...guids],
        ...(noGuidIds.length ? { alsoDeletedNoGuidIds: [...noGuidIds] } : {}),
        ...(total > guids.length + noGuidIds.length ? { alsoDeletedTotal: total } : {}),
      };
    },
  };
}

/** What `applyOps` knows about the project that the file alone cannot say. */
export interface ApplyOptions {
  /** Trait names whose category is `resource`, from the editor's trait schema — a scene file carries no categories.
   *  Absent (no renderer has pushed a schema — the headless route, which already says no editor was checked): the
   *  resource half of the parent rule is not asked; self, cycle and a dead parent still are (#1825). */
  resourceTraits?: ReadonlySet<string>;
  /** The entries `assignSyntheticEntityIds` gave a TEMPORARY id, which the caller strips before writing: a parent named
   *  by one of those ids would name nothing once stored, so it is treated as naming nothing (#1825 close-out review). */
  syntheticIds?: ReadonlySet<MutableEntity>;
}

/** Apply a list of mutation ops to a scene object. Mutates `scene` in place and
 *  also returns it. `mint` is injectable so tests get deterministic ids. */
export function applyOps(scene: MutableScene, ops: MutateOp[], mint: () => string = newGuid, opts: ApplyOptions = {}): ApplyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unresolved: EntityRef[] = [];
  const created: Array<{ op: number; id: number; guid: string; name: string }> = [];
  const addedTraits: NonNullable<ApplyResult['addedTraits']> = [];
  let alsoDeleted = alsoDeletedTally();
  let changed = 0;
  // FIRST resolveEntity failure's code, if any op hit one — see `ApplyResult.code`.
  const codeOut: { code?: EntityResolveCode } = {};
  const appliedOps: number[] = [];
  const failedOps: number[] = [];

  if (!scene || !Array.isArray(scene.entities)) {
    return { scene, changed: 0, errors: ['scene.entities is missing or not an array'], warnings, unresolved, appliedOps, failedOps };
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const where = `op[${i}] (${op?.op ?? 'unknown'})`;
    const errorsBefore = errors.length;
    const changedBefore = changed;
    try {
      if (op.op === 'setTrait') {
        const entity = resolveEntity(scene, op.entity, errors, where, unresolved, codeOut);
        if (!entity) continue;
        if (!op.trait) { errors.push(`${where}: missing 'trait'`); continue; }
        const writeRefused = traitWriteRefusal(op.trait);
        if (writeRefused) { errors.push(`${where}: ${writeRefused}`); continue; }
        const fields = op.fields ?? {};
        // A file never stores the stamp (the loader sets it), so any value but '' is a scene move (#1757).
        const stored = entity.traits[op.trait];
        // An instance root keeps its guid at the entry's top level, not in its EntityAttributes (#1785 close-out re-review):
        // asked of the trait alone, its guid read as absent and a rename passed that the live twin refuses.
        const fieldRefused = Object.entries(fields).map(([f, v]) => fieldWriteRefusal(op.trait!, f, v,
          op.trait === 'EntityAttributes' && f === 'guid' ? entityGuid(entity)
            : stored && typeof stored === 'object' ? (stored as Record<string, unknown>)[f] : undefined)).find((r) => r);
        if (fieldRefused) { errors.push(`${where}: ${fieldRefused}`); continue; }
        // Check `space` BEFORE the empty-fields (tag) branch. It used to sit in the `else if`
        // after it, so `{op:'setTrait', trait:'<non-Transform>', space:'world'}` with no fields was
        // accepted and tagged — the parameter silently ignored — while the LIVE twin refused it
        // unconditionally. Same op, two behaviours, decided by whether an editor happened to have
        // the scene open (§9).
        if (op.space && op.trait !== 'Transform') {
          errors.push(`${where}: 'space' applies only to trait 'Transform' (got '${op.trait}').`);
          continue;
        }
        // A parent change is judged by the one parent rule, against this file's own entries (#1825).
        const parentGiven = op.trait === 'EntityAttributes' && fields.parentId !== undefined;
        // Taken BEFORE any write: the pose is read under the parent the entry has now.
        let pose: Record<string, number> | null = null;
        if (parentGiven) {
          const judged = judgeFileParent(scene, entity, fields.parentId, opts);
          if ('error' in judged) { errors.push(`${where}: ${judged.error} — nothing was applied`); continue; }
          if (judged.moves) {
            const kept = keepWorldPose(scene, entity, judged.parent);
            if ('error' in kept) { errors.push(`${where}: ${kept.error} — nothing was applied`); continue; }
            if (kept.warning) warnings.push(`${where}: ${kept.warning}`);
            pose = kept.write;
          }
        }
        // Prefab-instance roots route trait writes into their overrides (see helper).
        const container = traitWriteContainer(entity);
        if (Object.keys(fields).length === 0) {
          // No fields → treat as a tag (presence). Don't clobber existing data.
          // Only count as changed when the tag was actually added — re-tagging an
          // existing trait is a genuine no-op and must not report changed (F6).
          if (container[op.trait] === undefined) {
            container[op.trait] = true;
            changed++;
          }
        } else {
          const existing = container[op.trait];
          const base = existing && typeof existing === 'object' ? existing : {};
          let write = fields;
          if (op.space === 'world') {
            const converted = worldFieldsToLocal(scene, entity, base as Record<string, unknown>, fields);
            if ('error' in converted) { errors.push(`${where}: ${converted.error}`); continue; }
            write = converted.fields;
          }
          if (pose) {
            // The world-pose compensation lands where the entry keeps its Transform: an instance root's in its
            // overrides (`container`), anything else's in its traits (#1847).
            const tf = container.Transform;
            container.Transform = { ...(tf && typeof tf === 'object' ? tf : {}), ...pose };
          }
          if (parentGiven && container !== entity.traits) {
            // An instance root's parent is the ENTRY's own, read by the loader from `traits` (where a Hierarchy drop and
            // a save put it). In the overrides it moved nothing, and Apply would carry it into the template (#1825).
            const { parentId, ...rest } = write;
            const own = entity.traits.EntityAttributes;
            entity.traits.EntityAttributes = { ...(own && typeof own === 'object' ? own : {}), parentId };
            write = rest;
            if (Object.keys(write).length === 0) { changed++; continue; }
          }
          if (existing === undefined && container === entity.traits) addedTraits.push({ op: i, id: entity.id, guid: entityGuid(entity), trait: op.trait });
          container[op.trait] = { ...base, ...write };
          changed++;
        }
      } else if (op.op === 'removeTrait') {
        const entity = resolveEntity(scene, op.entity, errors, where, unresolved, codeOut);
        if (!entity) continue;
        if (!op.trait) { errors.push(`${where}: missing 'trait'`); continue; }
        const removeRefused = traitRemoveRefusal(op.trait);
        if (removeRefused) { errors.push(`${where}: ${removeRefused}`); continue; }
        // Removing a trait the entity doesn't have is a genuine no-op (not an
        // error) — mirrors removeTraitFromEntitiesWithUndo's skip-if-absent.
        // Prefab-instance roots remove the override (same container as setTrait).
        const container = traitWriteContainer(entity);
        if (container[op.trait] !== undefined) {
          delete container[op.trait];
          changed++;
        }
      } else if (op.op === 'addEntity') {
        // A new entity cannot carry a hand-made prefab link either (#1454) — refused whole.
        const linkRefused = Object.keys(op.traits ?? {}).map(traitWriteRefusal).find((r) => r);
        if (linkRefused) { errors.push(`${where}: ${linkRefused}`); continue; }
        const authoredEa = op.traits?.EntityAttributes;
        // Asked only when the stamp is AUTHORED: an EntityAttributes that never names it is an ordinary create.
        const stampRefused = authoredEa && typeof authoredEa === 'object' && 'sourceScene' in authoredEa
          ? fieldWriteRefusal('EntityAttributes', 'sourceScene', (authoredEa as Record<string, unknown>).sourceScene, '') : null;
        if (stampRefused) { errors.push(`${where}: ${stampRefused}`); continue; }
        // The parent may arrive as `op.parentId` OR inside the authored EntityAttributes; both answer to the same rule,
        // as in the live addEntity (#1248). A parent that names no entity of this file (ops apply in order, so one an
        // earlier op added IS present) or a resource goes to the scene root with a warning, as the live create does
        // (#1825): the entity is still created somewhere that is saved, never stored as an orphan.
        const authoredParent = authoredEa && typeof authoredEa === 'object' ? (authoredEa as { parentId?: unknown }).parentId : undefined;
        const askedParent: unknown = op.parentId ?? authoredParent;
        let parentRef: string | number = 0;
        if (askedParent !== undefined && askedParent !== 0 && askedParent !== '') {
          const graph = fileParentGraph(scene, opts);
          const parent = graph.find(askedParent);
          if (!parent) {
            warnings.push(`${where}: parentId ${JSON.stringify(askedParent)} matches no entity in this scene file — '${op.name ?? 'new entity'}' was parented to the scene root instead`);
          } else if (graph.isResource(parent)) {
            warnings.push(`${where}: parent ${JSON.stringify(askedParent)} is a resource and holds no children — '${op.name ?? 'new entity'}' was parented to the scene root instead`);
          } else {
            parentRef = askedParent as string | number;
          }
        }
        const id = nextId(scene);
        const traits: Record<string, Record<string, unknown> | boolean> = { ...(op.traits ?? {}) };
        // Ensure EntityAttributes carries a stable guid + name + parentId so the
        // entity round-trips through load/save and selection-restore.
        const existingAttrs = (traits.EntityAttributes && typeof traits.EntityAttributes === 'object')
          ? (traits.EntityAttributes as Record<string, unknown>)
          : {};
        traits.EntityAttributes = {
          name: op.name ?? existingAttrs.name ?? `Entity ${id}`,
          ...existingAttrs,
          // After the spread, so a caller's guid cannot override it: an EMPTY one would leave the
          // entity unaddressable, and a RUNTIME one (#1210) — copied from a live-world read — is
          // valid only until reload and must never reach a file.
          guid: durableGuid(existingAttrs.guid as string) || mint(),
          ...(op.name ? { name: op.name } : {}),
          // Always the JUDGED parent: the authored data may name a dead entity or a resource, re-rooted above.
          parentId: parentRef,
        };
        // EntityAttributes.name is canonical (the loader reads only that). The
        // top-level `name` is decorative (serialize parity / labels) — derive it
        // from the same value so the two can't diverge at creation.
        const entity: MutableEntity = { id, name: (traits.EntityAttributes as { name: string }).name, traits };
        scene.entities.push(entity);
        changed++;
        created.push({
          op: i,
          id,
          guid: String((traits.EntityAttributes as { guid?: unknown }).guid ?? ''),
          name: (traits.EntityAttributes as { name: string }).name,
        });
      } else if (op.op === 'removeEntity') {
        const entity = resolveEntity(scene, op.entity, errors, where, unresolved, codeOut);
        if (!entity) continue;
        const toRemove = collectSubtree(scene, entity.id);
        // Collect the removed guids BEFORE filtering so we can flag any surviving
        // entity that still references the deleted subtree (a now-dangling ref). (F5)
        const removedGuids = new Set<string>();
        const byId = new Map<number, MutableEntity>();
        for (const e of scene.entities) {
          if (!toRemove.has(e.id)) continue;
          byId.set(e.id, e);
          const g = entityGuid(e);
          if (g) removedGuids.add(g);
        }
        // The subtree, not just the named entity, leaves the file — name the rest (#1262). The Set is in
        // walk order, root first, so a parent is listed before its children.
        alsoDeleted.add([...toRemove].filter((id) => id !== entity.id), (id) => entityGuid(byId.get(id)!));
        scene.entities = scene.entities.filter((e) => !toRemove.has(e.id));
        if (removedGuids.size) flagDanglingRefs(scene, removedGuids, warnings, where);
        changed++;
      } else if (op.op === 'setBaseScene') {
        // Top-level scene-format field (scene-loading.md), not an
        // entity — the only op that touches `scene` directly rather than `scene.entities`.
        // null/'' clears it (a scene with no base omits the field entirely, not `baseScene: ''`).
        if (op.baseScene) {
          if (scene.baseScene !== op.baseScene) { scene.baseScene = op.baseScene; changed++; }
        } else if ('baseScene' in scene) {
          delete scene.baseScene;
          changed++;
        }
      } else {
        errors.push(`${where}: unknown op '${(op as { op?: string }).op}'`);
      }
    } catch (e) {
      errors.push(`${where}: ${String(e)}`);
    } finally {
      // `finally`, because every refusal above leaves its op with `continue` (#1910).
      if (changed > changedBefore) appliedOps.push(i);
      if (errors.length > errorsBefore) failedOps.push(i);
    }
  }

  // Tripwire (#1210): a runtime guid is a LIVE-world address, valid only until reload, and this
  // edits the FILE. One arrives when an agent copies a guid from a live read (scene-state, a
  // journal event) into a ref field, a parentId or an authored string. Refuse the whole write —
  // `changed = 0` is what the route reads as "leave the file untouched" — rather than persist an
  // address that names a different entity next session. Checked after every op, so it cannot
  // matter which op introduced it.
  const runtimeHits = findRuntimeGuids(scene.entities);
  if (runtimeHits.length > 0) {
    for (const h of runtimeHits.slice(0, 5)) {
      errors.push(`entities.${h.path}: '${h.guid}' is a RUNTIME guid — a live-world address valid only `
        + `until reload, so it cannot be written to a scene file. Save the live world first (modoki_save_all) `
        + `so the entity gets a durable guid, then use that.`);
    }
    changed = 0;
    created.length = 0; // nothing is written, so nothing was created
    addedTraits.length = 0; // …and no trait was added to anything
    alsoDeleted = alsoDeletedTally(); // …or removed from the file
    appliedOps.length = 0; // …so no op is named as applied (`changed = 0` is what keeps the verdict from PARTIAL)
  }

  return { scene, changed, errors, warnings, unresolved, appliedOps, failedOps, ...(created.length ? { created } : {}), ...(addedTraits.length ? { addedTraits } : {}), ...alsoDeleted.fields(), ...(codeOut.code ? { code: codeOut.code } : {}) };
}

/** Scan surviving entities for entity-ref fields that still point at a removed guid.
 *  Today the only entity→entity refs in the on-disk format are `UIAction.bindings[].target`
 *  (the entity a button writes to / passes to its handler). Reported as warnings so an
 *  agent can re-wire the dangling button instead of silently shipping broken UI. (F5) */
function flagDanglingRefs(scene: MutableScene, removedGuids: Set<string>, warnings: string[], where: string): void {
  for (const e of scene.entities) {
    const ua = e.traits?.UIAction;
    if (!ua || typeof ua !== 'object') continue;
    const bindings = (ua as { bindings?: unknown }).bindings;
    if (!Array.isArray(bindings)) continue;
    for (const b of bindings) {
      const target = b && typeof b === 'object' ? (b as { target?: unknown }).target : undefined;
      if (typeof target === 'string' && removedGuids.has(target)) {
        warnings.push(`${where}: ${entityName(e) ?? `entity ${e.id}`} UIAction.target '${target}' references a removed entity (now dangling)`);
      }
    }
  }
}

/** Resolve an entity ref to an entity, pushing an error if not found/ambiguous. `codeOut`,
 *  when passed, gets the FIRST failure's machine code written into it (see `ApplyResult.code`) —
 *  an out-param rather than a return value so every existing `if (!entity) continue;` call site
 *  stays unchanged. */
function resolveEntity(scene: MutableScene, ref: EntityRef, errors: string[], where: string, unresolved?: EntityRef[], codeOut?: { code?: EntityResolveCode }): MutableEntity | null {
  // The live resolver's rules (`app/debug/entityRef.ts`, #1223), applied to the FILE: an empty string is
  // absent, and more than one address is refused rather than resolved by precedence. This path used to
  // let `id` win over a `guid` given beside it, the opposite of the live path, so the same ref named
  // different entities depending on the persistence mode. (`id` here is the FILE's authored id, not a
  // runtime one, so the live path's id-only-for-a-guid-less-entity rule does not apply.)
  const given = ref ? ([ref.id != null ? 'id' : '', ref.guid ? 'guid' : '', ref.name ? 'name' : ''].filter(Boolean)) : [];
  if (given.length === 0) {
    errors.push(`${where}: entity ref needs an id, name, or guid`);
    return null;
  }
  if (given.length > 1) {
    errors.push(`${where}: ${given.map((k) => `{${k}}`).join(' | ')} given together — pass exactly one. Two addresses can name two different entities.`);
    if (codeOut && codeOut.code === undefined) codeOut.code = 'AMBIGUOUS';
    return null;
  }
  let matches: MutableEntity[];
  if (ref.id != null) {
    matches = scene.entities.filter((e) => e.id === ref.id);
  } else if (ref.guid) {
    matches = scene.entities.filter((e) => entityGuid(e) === ref.guid);
  } else {
    matches = scene.entities.filter((e) => entityName(e) === ref.name);
  }
  if (matches.length === 0) {
    errors.push(`${where}: no entity matching ${JSON.stringify(ref)} in this scene FILE`);
    unresolved?.push(ref);
    if (codeOut && codeOut.code === undefined) codeOut.code = 'NOT_FOUND';
    return null;
  }
  if (matches.length > 1) {
    errors.push(`${where}: ${matches.length} entities match ${JSON.stringify(ref)} — use 'id' or 'guid' to disambiguate`);
    if (codeOut && codeOut.code === undefined) codeOut.code = 'AMBIGUOUS';
    return null;
  }
  return matches[0];
}

function entityName(e: MutableEntity): string | undefined {
  if (e.name) return e.name;
  const attrs = e.traits?.EntityAttributes;
  return attrs && typeof attrs === 'object' ? (attrs as { name?: string }).name : undefined;
}

/** Which guid identifies a scene-FILE entity entry — the one rule, for every reader.
 *
 *  Exported because it is not obvious and gets re-derived wrong: a plain entity's
 *  identity is `EntityAttributes.guid`, but a PREFAB INSTANCE has no such trait on
 *  disk and carries its guid at the node top level instead (the trait comes from the
 *  expanded prefab). The asset-tree-shaker's reverse-reference walk (#284) read only
 *  the trait and so treated all 25 of `games/court`'s prefab instances as identity-less,
 *  which made 26 live entity references look dangling. One helper, so the next reader
 *  cannot half-learn it.
 *
 *  Deliberately takes a structural subset rather than `MutableEntity`: callers outside
 *  the mutate path (the shaker) have their own entry type and no numeric `id`. */
export function entityGuid(e: { traits?: Record<string, unknown>; guid?: string }): string | undefined {
  const attrs = e.traits?.EntityAttributes;
  const attrGuid = attrs && typeof attrs === 'object' ? (attrs as { guid?: string }).guid : undefined;
  return attrGuid ?? e.guid;
}

/** Convert WORLD-space Transform fields into the LOCAL fields actually stored.
 *
 *  Converts the WHOLE POSE, not field-by-field. With a rotated parent a world X depends on the
 *  child's world Y and Z too, so converting `{x}` against a base of zeros would silently move the
 *  other axes. The current local transform is therefore lifted to world, the caller's fields are
 *  overlaid on THAT, and the result converted back — so a partial world write moves only what the
 *  caller named.
 *
 *  A ROOT entity's parent chain is empty, so this is an exact no-op there.
 *
 *  Refused when a Frame2D fit takes part (the entity's own, or an ancestor's, #1952): the fit depends on what is on
 *  screen, which a file cannot know, so any answer here would place the entity right on one screen shape only. */
function worldFieldsToLocal(
  scene: MutableScene,
  entity: MutableEntity,
  existingLocal: Record<string, unknown>,
  fields: Record<string, unknown>,
): { fields: Record<string, unknown> } | { error: string } {
  const fitted = fittedOnChain(scene.entities, entity);
  if (fitted) {
    return { error:
      `space:'world' is not solvable from the scene file here: '${fitted.name ?? entityGuid(fitted) ?? fitted.id}' is a `
      + 'Frame2D fitted to what is on screen of its canvas, which a scene file cannot know. Open the scene in the editor '
      + "(the live write knows the fit), or write space:'local'." };
  }
  const parent = parentWorldTrs(scene.entities, entity);
  if (!parent) return { fields }; // root: world == local
  // A collapsed (zero-scale) ancestor makes the request unsatisfiable — refuse rather than answer
  // with the identity parent `decompose` silently substitutes. See `collapsedParentAxes`.
  const collapsed = collapsedParentAxes(parent);
  if (collapsed) {
    return { error:
      `space:'world' is not solvable here: an ancestor has ZERO scale on ${collapsed.join('/')}, which `
      + 'collapses every descendant onto its origin, so no local transform can place this entity at the '
      + "requested world point. Give the ancestor a non-zero scale, or write space:'local'." };
  }
  const n = (k: string, d: number) => (typeof existingLocal[k] === 'number' ? (existingLocal[k] as number) : d);
  const local: TRS = {
    x: n('x', 0), y: n('y', 0), z: n('z', 0),
    rx: n('rx', 0), ry: n('ry', 0), rz: n('rz', 0),
    sx: n('sx', 1), sy: n('sy', 1), sz: n('sz', 1),
  };
  const wantWorld = mergeTrs(localToWorldTrs(local, parent), fields);
  const nextLocal = worldToLocalTrs(wantWorld, parent);
  // Write back the whole GROUP each named axis belongs to — see `persistedTrsKeys`. Filtering to
  // the named keys alone discarded part of the conversion's own answer under a rotated parent.
  const out: Record<string, unknown> = {};
  for (const k of persistedTrsKeys(fields)) out[k] = nextLocal[k];
  return { fields: out };
}

/** The object a setTrait/removeTrait write should land in. For a normal entity
 *  that's `entity.traits`. For a PREFAB INSTANCE root, trait edits are authored
 *  as overrides keyed by the root's localId — writing a top-level trait instead
 *  is silently ignored by the loader (the instance's traits come from the prefab),
 *  which is the bug that made `setTrait Transform` on an instance apply scale but
 *  not position. Route into `overrides[rootLocalId]` (created on demand) so the
 *  edit is authoritative. */
function traitWriteContainer(entity: MutableEntity): Record<string, unknown> {
  const pi = entity.traits?.PrefabInstance;
  const localId = entity.prefab && pi && typeof pi === 'object'
    ? (pi as { localId?: number }).localId
    : undefined;
  if (localId != null) {
    entity.overrides ??= {};
    entity.overrides[localId] ??= {};
    return entity.overrides[localId] as Record<string, unknown>;
  }
  return entity.traits as Record<string, unknown>;
}

/** A serialized parentId reference: a GUID string (current files), a numeric file id
 *  (legacy), or 0/'' for root. */
function parentKeyOf(e: MutableEntity): string | number {
  const attrs = e.traits?.EntityAttributes;
  if (attrs && typeof attrs === 'object') {
    const p = (attrs as { parentId?: unknown }).parentId;
    if (typeof p === 'string') return p;   // guid (current)
    if (typeof p === 'number') return p;    // numeric file id (legacy)
  }
  return 0;
}

/** The file's hierarchy, for the one parent rule (`parentLinkRefusal`, #1825): its nodes are the file's entries, and a
 *  parent is the entry a stored `parentId` names — a guid (current files, an instance root's top-level one included)
 *  or a numeric file id (legacy). `find` answers null for the root (0 / ''), undefined for a ref that names nothing. */
function fileParentGraph(scene: MutableScene, opts: ApplyOptions):
  ParentGraph<MutableEntity> & { find(ref: unknown): MutableEntity | null | undefined } {
  const { resourceTraits, syntheticIds } = opts;
  const byGuid = new Map<string, MutableEntity>();
  const byId = new Map<number, MutableEntity>();
  for (const e of scene.entities) {
    const g = entityGuid(e);
    if (g) byGuid.set(g, e);
    // Only an id the FILE stores is a parent reference; a backfilled one is stripped before the write.
    if (typeof e.id === 'number' && !syntheticIds?.has(e)) byId.set(e.id, e);
  }
  const find = (ref: unknown): MutableEntity | null | undefined =>
    ref === 0 || ref === '' ? null : typeof ref === 'string' ? byGuid.get(ref) : typeof ref === 'number' ? byId.get(ref) : undefined;
  return {
    find,
    parentOf: (e) => find(parentKeyOf(e)) ?? null,
    isResource: (e) => !!resourceTraits && Object.keys(e.traits ?? {}).some((t) => resourceTraits.has(t)),
    size: scene.entities.length,
  };
}

/** Judge a `parentId` written to an EXISTING entry: the file twin of the live setTrait's parent check. A parent that
 *  names no entry of this file is REFUSED, never stored (the loader would re-root or orphan it): this moves an entity
 *  the caller named, and a wrong-place success is worse than a refusal. A prefab member is not an entry, so a member
 *  parent is reached through the live editor's reparent, which can split and unpack an instance. */
function judgeFileParent(scene: MutableScene, entity: MutableEntity, raw: unknown, opts: ApplyOptions):
  { ok: true; parent: MutableEntity | null; moves: boolean } | { error: string } {
  const shown = JSON.stringify(raw);
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `EntityAttributes.parentId must be a guid string, an entity id, or 0 for the root (got ${shown})` };
  const graph = fileParentGraph(scene, opts);
  const parent = graph.find(raw);
  if (parent === undefined) {
    return { error: `EntityAttributes.parentId ${shown} names no entity in this scene file. A parent here must be an entity of this file (a prefab member is not one: move under a member with modoki_reparent_entity while the scene is open in the editor)` };
  }
  const refusal = parentLinkRefusal(graph, entity, parent);
  if (refusal === 'self-parent') return { error: `EntityAttributes.parentId ${shown} is the entity itself — an entity cannot be its own parent` };
  if (refusal === 'cycle') return { error: `EntityAttributes.parentId ${shown} is a descendant of this entity — the move would close a cycle, which makes the hierarchy untraversable` };
  if (refusal === 'resource') return { error: `EntityAttributes.parentId ${shown} would put a resource entity into the hierarchy (this entity or the parent carries a resource trait such as a game config) — resources stay at the root and hold no children` };
  return { ok: true, parent, moves: parent !== graph.parentOf(entity) };
}

/** The local Transform that keeps `entity`'s WORLD pose once `newParent` (null = the root) holds it — the file twin of
 *  the live reparent's compensation (#1847; Unity's editor reparent keeps the world pose too).
 *
 *  Only what the move depends on is read: the two parent chains below their shared prefix (`reparentSuffixes`), since
 *  the shared part cancels. When those compose to the same pose the entity keeps its local transform exactly — whatever
 *  its own local is, even one this file cannot read. Otherwise it is recomputed by `reparentWrite` (the owner the live
 *  reparent shares, #1848), and only what CHANGES is written: the
 *  position group when it moves, and the rotation and scale groups only when their LINEAR part changes
 *  (`sameRotationScale`). A decomposition picks its own Euler angles and mirror axis, so comparing numbers rewrote an
 *  untouched `{sy:-1}` as `{sx:-1, rz:π}` and a backwards yaw as `{rx:-π, ry:…, rz:-π}` on every move — not equivalent
 *  to a game reading the sign of `sy` (#1847 close-out re-review). When the recompute needs a pose this file cannot
 *  read — the entity's own, or an entry on either suffix, being an instance root placed partly by its template, or an
 *  entry on either suffix being a Frame2D fitted to its canvas (#1952: the fit depends on the screen) — the
 *  entity keeps its local transform and the reply says so, rather than computing against a guessed identity. A
 *  ZERO-scale new suffix cannot hold any pose, so the move is refused, as `space:'world'` refuses it. */
function keepWorldPose(scene: MutableScene, entity: MutableEntity, newParent: MutableEntity | null):
  { write: Record<string, number> | null; warning?: string } | { error: string } {
  const stored = storedTransformOf(entity);
  if (!stored && !entity.prefab) return { write: null };
  const { from, to, unknown } = reparentSuffixes(fileHierarchy(scene.entities), entity, newParent);
  // A suffix entry this file cannot read makes that suffix's pose a guess, so "same pose" cannot be judged either. The
  // entity's OWN local, by contrast, cancels when the suffixes match — so it is asked only after.
  const same = !unknown && sameTrsMatrix(from, to);
  if (same) return { write: null };
  // An instance root whose rotation/scale is partly in its template is still computable when the move keeps the linear
  // part (the suffixes differ by translation only) and its override stores x, y, z: its new position depends on its own
  // translation alone, and its rotation and scale do not change (#1847, fourth review — 12 of 29 instance roots in the
  // repo's scenes store exactly that shape).
  const positionOnly = !!stored && (['x', 'y', 'z'] as const).every((k) => typeof stored[k] === 'number')
    && sameRotationScale(from ?? IDENTITY_TRS, to ?? IDENTITY_TRS);
  const unknownName = unknown ? `'${unknown.name ?? entityGuid(unknown) ?? unknown.id}'` : '';
  const why = unknown && !isTemplatePlaced(unknown)
    ? `${unknownName} (a Frame2D on the parent chain) is fitted to what is on screen of its canvas, which a scene file cannot know` // #1952
    : unknown ? `${unknownName} (a prefab instance root on the parent chain) takes part of its placement from its prefab, which this route does not read`
      : isTemplatePlaced(entity) && !positionOnly ? 'this instance root takes part of its placement from its prefab, which this route does not read' : null;
  if (why) {
    return { write: null, warning: `${why}, so the world pose cannot be kept: the entity kept its LOCAL transform and its world position follows the new parent. modoki_reparent_entity with the scene open keeps it` };
  }
  // The write itself is the one owner every reparent route shares (#1848). A template-placed root is compensated on its
  // POSITION only: its rotation and scale are partly in the template, and a rotation written into the partial override
  // would replace the template's (fifth review: a 5e-5 rad suffix turn that the suffix check's tolerance let through
  // wrote `rx`, dropping a template `rx:0.4`).
  const kept = reparentWrite(mergeTrs(IDENTITY_TRS, stored ?? {}), from, to, { positionOnly: isTemplatePlaced(entity) });
  if ('collapsed' in kept) {
    return { error: `the new parent's chain has ZERO scale on ${kept.collapsed.join('/')}, which collapses every child onto its origin, so no local transform keeps this entity's world pose. Give that ancestor a non-zero scale first` };
  }
  return { write: kept.write as Record<string, number> | null };
}

/** Collect an entity id plus all descendants (by EntityAttributes.parentId).
 *  Works whether parentId is a GUID (current) or a numeric file id (legacy), and
 *  even a mix — a child is matched against its parent's guid AND numeric id. */
function collectSubtree(scene: MutableScene, rootId: number): Set<number> {
  const childrenByKey = new Map<string | number, MutableEntity[]>();
  for (const e of scene.entities) {
    const p = parentKeyOf(e);
    if (p) {
      const arr = childrenByKey.get(p) ?? [];
      arr.push(e);
      childrenByKey.set(p, arr);
    }
  }
  const out = new Set<number>();
  const root = scene.entities.find((e) => e.id === rootId);
  if (!root) return out;
  const stack: MutableEntity[] = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (out.has(e.id)) continue;
    out.add(e.id);
    const g = entityGuid(e);
    for (const c of childrenByKey.get(e.id) ?? []) stack.push(c);       // legacy numeric ref
    if (g) for (const c of childrenByKey.get(g) ?? []) stack.push(c);    // guid ref (current)
  }
  return out;
}

/** Backfill a synthesized numeric id (its array index) for any entity that lacks
 *  one. A v12+ scene file (scene-loading.md, Phase 3) no longer
 *  carries `id` at all — the interactive Save All path stopped writing it once
 *  nothing on disk referenced it any more. This module still identifies entities
 *  by numeric id throughout (`EntityRef.id`, `nextId`, `collectSubtree`'s legacy
 *  parentId branch), so a caller parsing a scene file MUST call this before
 *  `applyOps` — mirrors `loadSceneFile.ts`'s `assignSyntheticEntityIds`, same
 *  reasoning, kept as a separate copy since this module is deliberately
 *  standalone/dependency-free (runs identically in Node and the browser). A file
 *  that DOES carry ids (v11 and earlier, or hand-authored) is untouched — this
 *  only fills gaps, never overwrites. Mutates `scene` in place, like `applyOps`.
 *
 *  Returns the set of entity objects it backfilled, so a caller that writes the
 *  scene back to disk can strip those synthetic ids first (`stripBackfilledEntityIds`)
 *  — otherwise a single setTrait through this path would silently reintroduce an
 *  `id` field on EVERY entity in an id-less v12+ file, the exact per-entity diff
 *  noise Phase 3 removed, just via a different write path than Save All. Safe to
 *  discard the return value if the caller never writes `scene` back out (e.g. a
 *  read-only validation pass).
 *
 *  Skips any array index already taken by an EXPLICIT id elsewhere in the file
 *  (a genuinely mixed file — some entries id'd, some not — is unusual but not
 *  impossible: hand-edited, or partially migrated) so a synthesized id can never
 *  collide with a real one, which would otherwise let `EntityRef.id` silently
 *  resolve to the WRONG entity — caught by independent code review, 2026-07-26. */
export function assignSyntheticEntityIds(scene: MutableScene): Set<MutableEntity> {
  const backfilled = new Set<MutableEntity>();
  const used = new Set<number>();
  for (const e of scene.entities) if (typeof e.id === 'number') used.add(e.id);
  let next = 0;
  for (const e of scene.entities) {
    if (e.id != null) continue;
    while (used.has(next)) next++;
    e.id = next;
    used.add(next);
    backfilled.add(e);
  }
  return backfilled;
}

/** Undo `assignSyntheticEntityIds`' backfill on exactly the entities it touched,
 *  right before writing `scene` back to disk. Entities `applyOps` REMOVED are
 *  simply absent from `scene.entities` already (no-op for those); entities
 *  `addEntity` ADDED were never in `backfilled` (they mint a real, meaningful id
 *  via `nextId()`, called after the backfill ran) and keep theirs. Safe even
 *  though nothing downstream re-reads these entities' `id` after this call —
 *  it exists purely to keep the WRITTEN file id-less, matching what a fresh
 *  `serializeScene` save would have produced. */
export function stripBackfilledEntityIds(scene: MutableScene, backfilled: Set<MutableEntity>): void {
  if (backfilled.size === 0) return;
  for (const e of scene.entities) if (backfilled.has(e)) delete (e as { id?: number }).id;
}

/** Next free numeric entity id (max existing + 1, min 1). */
function nextId(scene: MutableScene): number {
  let max = 0;
  for (const e of scene.entities) if (typeof e.id === 'number' && e.id > max) max = e.id;
  return max + 1;
}
