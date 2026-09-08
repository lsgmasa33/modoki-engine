/** revalidateSubtreeAfterRendererRebuild — the recovery pass a surviving scene graph needs after
 *  its renderer is destroyed and rebuilt (WebGL context loss / WebGPU device loss, #213/#794).
 *
 *  ── The actual cause of the blank frame ──────────────────────────────────────────────────────
 *  `Application.destroy()` nulls the stage and `init()` builds a fresh one — Pixi's render groups
 *  are NOT the culprit here; a `RenderGroup`'s constructor and `addChild` already set
 *  `structureDidChange`, so the instruction set for a rebuilt stage IS rebuilt. The real mechanism
 *  is per-pipe, and asymmetric between pipes:
 *    - `GraphicsPipe.addRenderable` (`scene/graphics/shared/GraphicsPipe.mjs`) only calls
 *      `this._rebuild(graphics)` `if (graphics.didViewUpdate)`. A surviving `Graphics` node that
 *      is NOT re-marked dirty across the rebuild never gets rebuilt, so
 *      `_getGpuDataForRenderable` mints a fresh, EMPTY `GraphicsGpuData` (`batches: []`) under the
 *      new renderer's uid — which contributes nothing to the batcher, so the graphics draws
 *      nothing. Silent: no error, no throw, just an empty batch.
 *    - `MeshPipe._getBatchableMesh` (`scene/mesh/shared/MeshPipe.mjs`) initialises its gpu data
 *      UNCONDITIONALLY (`mesh._gpuData[uid] ||= new MeshGpuData()`, then rebuilt via
 *      `_initBatchableMesh` if needed) — it does not gate on `didViewUpdate` the way the graphics
 *      pipe does, so a surviving `Mesh` comes back fine on its own. `SpritePipe.addRenderable` →
 *      `_getGpuSprite` → `_initGPUSprite` (`scene/sprite/shared/SpritePipe.mjs`) is a DIFFERENT
 *      file for a DIFFERENT node type, but is recovery-safe for the same reason: it too initialises
 *      unconditionally rather than gating on `didViewUpdate`, so a surviving `Sprite` also comes
 *      back fine on its own.
 *  That asymmetry is exactly what the device measurement below shows: graphics-pipe objects went
 *  blank, mesh-pipe objects did not. `onViewUpdate()` is a VIEW-level notification (see
 *  `ViewContainer.onViewUpdate`, `scene/view/ViewContainer.mjs` — it early-outs on
 *  `if (this.didViewUpdate) return;`) that sets `didViewUpdate = true`, which is what makes
 *  `GraphicsPipe.addRenderable` take the rebuild branch again on the next frame. That is what
 *  actually restores the frame — not a render-group-level dirty flag.
 *
 *  Measured on an iPhone 8 (A11 / iOS 16.7.16) via isolation testing, in order, each step run
 *  immediately after the pool's own renderer rebuild:
 *
 *  | what was done after the pool's own rebuild                  | result                    |
 *  |---------------------------------------------------------------|-------------------------|
 *  | `_gpuData` purge alone (the landed fix)                      | still blank               |
 *  | `context.dirty = true` on every Graphics, then render        | still blank               |
 *  | `onViewUpdate()` on every Graphics, then render               | frame fully restored     |
 *
 *  So the `_gpuData` purge — the landed fix this function used to be entirely about — does NOT
 *  cure the blank frame. `onViewUpdate()` does, and this function now calls it on every
 *  qualifying node, not only `Graphics` (the isolation test's actual sample was graphics-pipe
 *  objects — 48 of them blank, 18 mesh-pipe objects fine, matching the pipe asymmetry above —
 *  there is no reason to believe the mechanism is graphics-specific beyond that pipe asymmetry, so
 *  every `ViewContainer`-shaped node with a callable `onViewUpdate` is marked, not just the ones
 *  the device sample happened to contain).
 *
 *  ── The `_gpuData` staleness defect (real, but NOT the cure, and smaller than first measured) ──
 *  PixiJS 8 caches per-renderer GPU objects (buffers, textures, compiled geometry, graphics
 *  batches, …) directly ON the resource, keyed by the OWNING renderer's `uid`. Five classes
 *  (relevant here) declare this public field (see their `.d.ts` under `node_modules/pixi.js/lib`):
 *    - `TextureSource._gpuData: Record<number, GlTexture | GPUTextureGpuData>`
 *    - `Geometry._gpuData: Record<number, GlGeometryGpuData>`
 *    - `Buffer._gpuData: Record<number, GlBuffer | GpuBufferData>`
 *    - `ViewContainer._gpuData: Record<number, GPU_DATA>` (the base for sprites, graphics, etc.)
 *    - `GraphicsContext._gpuData: Record<number | string, GpuGraphicsContext>`
 *  (`Shader` declares no `_gpuData` field at all — there is no sixth holder.)
 *  A resource can be cached against MULTIPLE renderers at once — that's the whole point of the
 *  cache, since one scene graph can be drawn by more than one live renderer.
 *
 *  Fifteen of Pixi's own systems/pipes hold a `GCManagedHash`, whose `destroy()` → `removeAll()` →
 *  `remove()` (`utils/data/GCManagedHash.mjs`) sets `item._gpuData[renderer.uid] = null` — and
 *  `Application.destroy()` does call `renderer.destroy()`. So on a CLEAN teardown, most of a
 *  destroyed renderer's `_gpuData` entries are already `null` (falsy) rather than a live dangling
 *  reference — the measured 206 keys on an iPhone 8 session were mostly null-valued, not mostly
 *  live orphans. Genuinely UNMANAGED (no `GCManagedHash`, so their entries are left exactly as the
 *  dead renderer wrote them): `SpritePipe` and `MeshPipe`. And a context-loss `app.destroy()` that
 *  THROWS mid-teardown (caught at `canvas2DPool.ts`'s `rebuildSlotApp`) leaves the nulling PARTIAL,
 *  so some non-null orphans do survive even outside those two pipes. The leak this purge closes is
 *  real, just smaller than originally stated — worth fixing on its own merits (unbounded growth of
 *  a per-process cache under repeated context losses), but device isolation testing (table above)
 *  established it is NOT what causes or cures the blank frame after a rebuild — that is
 *  `onViewUpdate`, above.
 *
 *  ── Why this purges DEAD renderer uids, not a live-set exclusion ────────────────────────────────
 *  `Canvas2DPool` passes `deadRendererUids` — every renderer this PROCESS has destroyed, recorded
 *  by both `rebuildSlotApp` and `teardownSlot` (see its doc comment in `canvas2DPool.ts` for why it
 *  is process-wide and append-only rather than per-slot: a dead uid is safe to purge from anything,
 *  anywhere, forever, and draining it on one slot's walk would strand a uid still stale on a shared
 *  object reachable from another). Those renderers no longer exist, so any `_gpuData[deadUid]` entry left on a surviving node
 *  can never belong to a live renderer — deleting it needs no reasoning about what else is live. An
 *  earlier revision of this function instead took a caller-supplied "live renderer uids" set and
 *  deleted every key NOT in it; that was wrong in a way the single-pool tests could not see. Pixi
 *  renderer `uid`s come from a monotonic `uid('renderer')` counter (`AbstractRenderer.mjs`) that is
 *  NEVER reused — `resetUids()` is called nowhere in this repo — so a "live set built from one
 *  pool's own slots" is fine only as long as exactly one pool exists. It does not: `defaultPool`
 *  (`canvas2DPool.ts`) and `editorCanvas2DPool` (`editor/rendering/editorScene2D.ts`) are both
 *  live at once, and Pixi `TextureSource`s are process-global and shared between them — so a
 *  live-set purge built from pool A's slots alone would delete pool B's still-live renderer's
 *  entry off a shared texture, orphaning a GPU texture pool B's renderer still owns. Purging only
 *  uids that are provably dead makes that cross-pool leak structurally unreachable.
 *
 *  ⚠️ **This is a deliberate reach reduction from an earlier revision, and it is unmeasured.** The
 *  old live-set sweep purged opportunistically: ANY later rebuild, on ANY slot in the pool, swept
 *  every non-live uid it found — including renderers destroyed by `teardownSlot` (reached from
 *  `destroyPool`, the `renderAll` shrink pass, and `reclaimIfUnclaimed`), not just ones destroyed by
 *  a rebuild. For a while the replacement swept only uids recorded by a rebuild, which left those
 *  other teardown paths uncollected — each SceneView mount/unmount runs
 *  `editorCanvas2DPool.destroyPool()` and left one `_gpuData` key per process-global
 *  `TextureSource` shared with the game pool. **That reach limit is now CLOSED (#801):**
 *  `teardownSlot` records into the same process-wide `deadRendererUids` set as `rebuildSlotApp`, so
 *  a uid retired by any path is purged by the next revalidation walk. Both properties hold at once
 *  — the sweep is including-DEAD rather than excluding-LIVE, so it can never delete a live
 *  renderer's entry off a shared resource, and it no longer misses the teardown paths either. */

import type { Container } from 'pixi.js';

/** A narrow local shape for the "does this object carry a per-renderer GPU cache" duck type.
 *  Pixi does not export `_gpuData` on any of the five holder classes in a form convenient to
 *  import here, so this interface plus the single cast at each access point stand in for it. */
interface GpuDataHolder {
  _gpuData?: Record<string, unknown>;
}

/** The subset of a Pixi display object's own shape this walk needs to read. Every field is
 *  optional/untyped-here on purpose — not every node has a `context`/`geometry`/`texture`, and
 *  Pixi's real classes don't share one common base that exposes all of them. (No `shader` field —
 *  `Shader` declares no `_gpuData` at all, so there is nothing to purge there; see the file
 *  header.) */
interface WalkableNode extends GpuDataHolder {
  children?: unknown;
  context?: unknown;
  geometry?: { buffers?: unknown } & GpuDataHolder;
  texture?: { source?: unknown };
  /** Present on `ViewContainer` subclasses (Graphics, Sprite, Mesh, …) — NOT on a plain
   *  `Container`. Forces the render group holding this view to be rebuilt against the CURRENT
   *  renderer rather than replaying a stale instruction set. See the file header. */
  onViewUpdate?: unknown;
}

/** Delete `holder._gpuData[deadUidKey]` if present. Returns 1 if a key was deleted, 0 otherwise.
 *  Never throws — a holder whose `_gpuData` access itself throws (a getter, a proxy, a
 *  partially-torn-down object) must not abort the walk; the caller runs on a GPU-loss recovery
 *  path where an exception here would abort the whole rebuild. No-op when `deadUidKey` is
 *  `undefined` (the caller had no dead renderer to identify). */
function purgeHolder(holder: unknown, deadUidKey: string | undefined): number {
  if (deadUidKey === undefined) return 0;
  try {
    // `_gpuData` is not on Pixi's public exported types in a shape we can import here — one
    // localised, commented cast per access point, per the file's own convention.
    const gpuData = (holder as GpuDataHolder | null | undefined)?._gpuData;
    if (!gpuData || !(deadUidKey in gpuData)) return 0;
    delete gpuData[deadUidKey];
    return 1;
  } catch {
    // A holder whose _gpuData access throws is skipped, not fatal — see the doc comment above.
    return 0;
  }
}

/** Call `node.onViewUpdate()` if it has one — forcing its render group to rebuild against the
 *  current renderer instead of replaying an instruction set recorded against a destroyed one
 *  (see the file header). Returns 1 if called, 0 if the node has no callable `onViewUpdate`.
 *  Never throws — a view mid-teardown or otherwise in a bad state must not abort the walk, same
 *  reasoning as `purgeHolder`. */
function markViewUpdated(node: WalkableNode): number {
  try {
    if (typeof node.onViewUpdate === 'function') {
      (node.onViewUpdate as () => void)();
      return 1;
    }
  } catch {
    // A node whose onViewUpdate throws is skipped, not fatal — see the doc comment above.
  }
  return 0;
}

/** Walk `root` and every descendant, purging each visited node's `_gpuData[uid]` entry for every
 *  uid in `deadRendererUids` (if any) AND marking every qualifying node view-dirty via
 *  `onViewUpdate()` (see the file header
 *  for what each does and why both are needed). `_gpuData` purge checks five holder positions per
 *  node: the node itself (`ViewContainer`/`GraphicsContext`-shaped), `node.context`
 *  (`GraphicsContext`, for `Graphics` nodes), `node.geometry` (`Geometry`), `node.texture?.source`
 *  (`TextureSource`), and each element of `node.geometry?.buffers` (`Buffer[]`). `onViewUpdate()`
 *  is called once per node, on the node itself, when present.
 *
 *  Iterative (an explicit stack, not recursion) with a visited-set, so a malformed or
 *  accidentally-cyclic graph can never loop forever or blow the call stack. Null/undefined
 *  children are ignored. Never throws — see `purgeHolder` and `markViewUpdated`.
 *
 *  Order within a node: `_gpuData` purge first, then `onViewUpdate()` — matches the order the
 *  isolation test ran them in, though neither actually depends on the other.
 *
 *  @param root               Subtree root to walk. No-op if null/undefined.
 *  @param deadRendererUids   The uids of every renderer destroyed for this slot that has not yet
 *                            been swept, or `undefined`/empty if there is none to identify (e.g.
 *                            no renderer ever ran on this slot yet) — in which case nothing is
 *                            purged, but the `onViewUpdate` pass still runs. Accepting the whole
 *                            set (not just the renderer from the CURRENT rebuild attempt) matters
 *                            because a dead uid outlives the attempt that killed it — a timed-out
 *                            `init()` never reaches a purge, and a renderer torn down via
 *                            `teardownSlot` never had one — see `deadRendererUids`'s doc comment in
 *                            `canvas2DPool.ts`. Every uid in the set is still provably safe to
 *                            purge unconditionally: each one names a renderer that has already
 *                            been replaced.
 *  @returns `gpuDataPurged` — total `_gpuData` entries deleted across the whole subtree.
 *           `viewsMarked` — total nodes whose `onViewUpdate()` was called. */
export function revalidateSubtreeAfterRendererRebuild(
  root: Container | null | undefined,
  deadRendererUids: Iterable<number> | undefined,
): { gpuDataPurged: number; viewsMarked: number } {
  if (!root) return { gpuDataPurged: 0, viewsMarked: 0 };

  const deadUidKeys = deadRendererUids !== undefined
    ? Array.from(deadRendererUids, (uid) => String(uid))
    : [];

  let deletedCount = 0;
  let markedCount = 0;
  const visited = new Set<unknown>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node == null || visited.has(node)) continue;
    visited.add(node);

    const walkable = node as WalkableNode;

    for (const deadUidKey of deadUidKeys) {
      deletedCount += purgeHolder(walkable, deadUidKey);
      try { deletedCount += purgeHolder(walkable.context, deadUidKey); } catch { /* skip */ }
      try { deletedCount += purgeHolder(walkable.geometry, deadUidKey); } catch { /* skip */ }
      try { deletedCount += purgeHolder(walkable.texture?.source, deadUidKey); } catch { /* skip */ }

      try {
        const buffers = walkable.geometry?.buffers;
        if (Array.isArray(buffers)) {
          for (const buffer of buffers) deletedCount += purgeHolder(buffer, deadUidKey);
        }
      } catch { /* skip — a malformed buffers array must not abort the walk */ }
    }

    markedCount += markViewUpdated(walkable);

    try {
      const children = walkable.children;
      if (Array.isArray(children)) {
        for (const child of children) if (child != null) stack.push(child);
      }
    } catch { /* skip — a malformed children collection must not abort the walk */ }
  }

  return { gpuDataPurged: deletedCount, viewsMarked: markedCount };
}
