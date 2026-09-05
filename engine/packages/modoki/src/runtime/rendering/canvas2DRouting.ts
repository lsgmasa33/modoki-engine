/** canvas2DRouting — resolve which Canvas2D a Renderable2D entity belongs to.
 *
 *  A Renderable2D renders into its NEAREST Canvas2D ancestor (walking up the
 *  EntityAttributes.parentId chain). Both the runtime PixiJS layer (Scene2D)
 *  and the editor's SceneView overlay route the same way so the editor preview
 *  matches what ships. Scene2D keeps a per-frame cache layer on top of this for
 *  the hot render path; the editor calls it directly.
 *
 *  Pure + allocation-light (one Set guard against malformed cyclic parents). */

/** Walk up `entityId`'s parent chain to the nearest entity in `canvasIds`.
 *  Returns that Canvas2D entity id, or null if the entity has no Canvas2D
 *  ancestor. An entity that is itself a Canvas2D resolves to itself.
 *
 *  Optional `visited` is an out-param the caller may pass to collect, in walk
 *  order, every NON-canvas entity stepped through (i.e. the resolved canvas
 *  itself is excluded — it returns early). Scene2D uses this to cache the whole
 *  walked path → resolved canvas in one shot, so siblings sharing intermediate
 *  ancestors short-circuit. The walk is cycle-guarded, so `visited` lists each
 *  cyclic member at most once even on a malformed parent chain. */
export function findCanvasAncestor(
  entityId: number,
  parentOf: Map<number, number>,
  canvasIds: Set<number>,
  visited?: number[],
): number | null {
  let current = entityId;
  const seen = new Set<number>(); // guard against cyclic/self-referential parents
  while (current > 0 && !seen.has(current)) {
    if (canvasIds.has(current)) return current;
    seen.add(current);
    visited?.push(current);
    current = parentOf.get(current) || 0;
  }
  return null;
}

/** One entity that will not be drawn: it has a Renderable2D but no Canvas2D ancestor. */
export interface Unrenderable2D { id: number; name: string }

/** Which entities in `rootId`'s subtree carry a Renderable2D yet route to no Canvas2D — i.e.
 *  will render NOTHING, silently (Scene2D skips them; see its `noteOrphan2D`).
 *
 *  Pure over a flat entity list so a caller that has just spawned a subtree can answer the
 *  question immediately, before any frame has been drawn — which is what lets the prefab
 *  instantiate tool say so in its own response instead of returning a cheerful ok:true for an
 *  invisible entity (QA-ASSET-0014). Traits are matched by NAME, the same shape `getAllEntities`
 *  reports. An empty array means every 2D entity in the subtree has a canvas. */
/** The traits Scene2D routes through a Canvas2D — one per pass (Renderable2D sprites/graphics,
 *  SkinnedSprite2D deformable meshes, Text2D). Kept here rather than derived from
 *  `EntityAttributes.layer`, because that field says '2d' for entities Scene2D never queries and
 *  is stale-able (it is stored, not always recomputed): the question here is precisely "would
 *  Scene2D skip this entity", so it is answered against Scene2D's own queries. */
const CANVAS_REQUIRING_TRAITS = ['Renderable2D', 'SkinnedSprite2D', 'Text2D'] as const;

/** A companion that promotes a 2D rig OUT of the flat canvas and into the Three.js scene, where
 *  it needs no Canvas2D ancestor at all — Scene2D's skinned pass skips these deliberately. */
const PROMOTES_TO_3D = ['Billboard3D', 'FlatSprite3D'] as const;

export function findUnrenderable2D(
  entities: readonly { id: number; name: string; parentId: number; traits: readonly string[] }[],
  rootId: number,
): Unrenderable2D[] {
  const parentOf = new Map<number, number>();
  const canvasIds = new Set<number>();
  for (const e of entities) {
    parentOf.set(e.id, e.parentId);
    if (e.traits.includes('Canvas2D')) canvasIds.add(e.id);
  }
  // Subtree membership by walking each candidate UP to rootId — cheaper than materialising the
  // subtree, and it reuses the same cycle-guarded shape as the routing walk above.
  const inSubtree = (id: number): boolean => {
    let cur = id;
    const seen = new Set<number>();
    while (cur > 0 && !seen.has(cur)) {
      if (cur === rootId) return true;
      seen.add(cur);
      cur = parentOf.get(cur) || 0;
    }
    return false;
  };
  const out: Unrenderable2D[] = [];
  for (const e of entities) {
    if (!CANVAS_REQUIRING_TRAITS.some((t) => e.traits.includes(t))) continue;
    if (PROMOTES_TO_3D.some((t) => e.traits.includes(t))) continue;
    if (!inSubtree(e.id)) continue;
    if (findCanvasAncestor(e.id, parentOf, canvasIds) === null) out.push({ id: e.id, name: e.name });
  }
  return out;
}

/** The warn-once bookkeeping behind Scene2D's "this 2D entity has no Canvas2D ancestor" report.
 *
 *  Extracted from `Scene2D.tsx` so the decision is testable without mounting PixiJS in jsdom —
 *  same split as the routing walk above, and the same reason: the component owns the draw loop,
 *  this module owns what the draw loop DECIDES.
 *
 *  Three properties it exists to hold, all of which regressed silently in the class version (or a
 *  rewrite of it):
 *
 *  1. **It FORGETS an entity that recovers.** The warned set is keyed by guid (so it survives a
 *     hot-reload's id reassignment), and nothing dropped a key when the entity found a canvas —
 *     so parenting an orphan under the host and then back out again produced NO second warning.
 *     A warn-once registry over a condition that genuinely recovers has to forget, or the second
 *     break is the silent one. Same gap `resolveRefWarnOnce` had (QA-ASSET-0005).
 *  2. **The guid lookup stays OFF the hot path.** `key()` is a callback, not a value, and it is
 *     invoked only on the frame an entity crosses the warn threshold or recovers — never for the
 *     healthy entities that make up the whole scene, which is every entity, every frame.
 *  3. **It FORGETS an entity that dies.** `frames` is keyed by the numeric entity id, which koota
 *     recycles — an entity deleted while still orphaned left its count in `frames` forever, so the
 *     next entity to inherit that id started from a stale count and could never again hit `note()`'s
 *     exact-equality trigger. `prune()` closes this the same way `clear()` closes (1): a caller
 *     that calls it once per frame/sweep with the frame's live ids keeps `frames` bounded by
 *     currently-orphaned entities, not by every entity ever orphaned. */
/** The key an entity warns under when it has no guid. koota recycles entity ids, so this form —
 *  and ONLY this form — can outlive its entity and silence an unrelated one that inherits the id
 *  (#700). Exported so `Scene2D.orphan2DKey` mints it and {@link Orphan2DTracker.prune} can
 *  recognise it: one format, one place, so the two cannot drift apart. */
export function orphan2DFallbackKey(entityId: number): string { return `id:${entityId}`; }

/** The entity id inside a fallback key, or null when `key` is a guid — which is unique for the
 *  life of the project and therefore never recycles, so it is not prunable by id. */
function orphan2DFallbackId(key: string): number | null {
  if (!key.startsWith('id:')) return null;
  const n = Number(key.slice(3));
  return Number.isInteger(n) ? n : null;
}

export class Orphan2DTracker {
  private readonly frames = new Map<number, number>();
  private readonly warned = new Set<string>();

  /** Count a frame in which `entityId` routed to no canvas. Returns the warn key exactly ONCE
   *  per orphaning — on the frame the count reaches `afterFrames` and the key is not already
   *  warned — else null. */
  note(entityId: number, key: () => string, afterFrames: number): string | null {
    const frames = (this.frames.get(entityId) ?? 0) + 1;
    this.frames.set(entityId, frames);
    if (frames !== afterFrames) return null;      // exactly once, not every frame after
    const k = key();
    if (this.warned.has(k)) return null;
    this.warned.add(k);
    return k;
  }

  /** `entityId` found a canvas — drop its count and its warned key so a later re-orphaning
   *  warns again. No-op (and no `key()` call) for an entity that was never counted. */
  clear(entityId: number, key: () => string): void {
    if (this.frames.size === 0) return;
    if (!this.frames.delete(entityId)) return;
    if (this.warned.size === 0) return;
    this.warned.delete(key());
  }

  /** Forget everything (teardown / tests). */
  reset(): void { this.frames.clear(); this.warned.clear(); }

  /** Drop `frames` tracking for any id NOT in `aliveIds` — the fix for the id-recycling gap:
   *  `note()`/`clear()` only run on frames Scene2D actually visits an entity, so one that DIES
   *  while still orphaned leaves its count in `frames` forever. koota then recycles that same
   *  numeric id for an unrelated entity, which inherits a count >= `afterFrames` and can never
   *  again hit `note()`'s exact-equality trigger — the warn-once-must-forget failure this class
   *  exists to prevent, reintroduced one level down (it forgot on recovery, not on death).
   *
   *  Call once per frame/sweep with the frame's live entity ids — the same prune-by-active-set
   *  shape this codebase already uses for the same recycling hazard (e.g. `videoTextureSync.ts`'s
   *  `seen` set).
   *
   *  `warned` is pruned here too (#700), for the SAME collision one level down: `orphan2DKey`
   *  falls back to {@link orphan2DFallbackKey} whenever `EntityAttributes.guid` is empty or
   *  unreadable, so a guid-less orphan's `id:` key could outlive it and permanently silence the
   *  unrelated entity that recycles the same numeric id. Only the `id:` form is dropped — a guid
   *  is unique for the life of the project, so it cannot alias a different entity; guid keys are
   *  released wholesale by {@link reset} at teardown and on world swap, which is also what bounds
   *  `warned` across scenes (ids collide by the NORM across a swap, not by accident).
   *
   *  ⚠️ KNOWN REMAINING GAP, stated so nobody reads the above as complete: a GUID-keyed orphan
   *  that DIES is not forgotten within its own world. Delete a guid-bearing orphaned entity and
   *  undo it (same guid, same world, so `reset()` never runs) and it stays suppressed, because
   *  `prune` is given ids and cannot tell which guids are still live. Not an id COLLISION — it
   *  suppresses only the same entity — so it is the mild end of this shape, but it is the same
   *  forget-on-death failure. Tracked in #738 with the rest of the family. */
  prune(aliveIds: ReadonlySet<number>): void {
    if (this.frames.size === 0 && this.warned.size === 0) return;
    for (const id of this.frames.keys()) if (!aliveIds.has(id)) this.frames.delete(id);
    // Deleting the current element while iterating a Set is well-defined — visited entries are
    // unaffected and the iterator continues from the next one.
    for (const key of this.warned) {
      const id = orphan2DFallbackId(key);
      if (id !== null && !aliveIds.has(id)) this.warned.delete(key);
    }
  }
}
