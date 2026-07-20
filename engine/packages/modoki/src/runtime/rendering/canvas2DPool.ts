/** canvas2DPool — manages PixiJS Application instances for Canvas2D entities.
 *
 *  Each slot gets its own Application with backgroundAlpha: 0 for proper
 *  transparency. The global PixiJS Assets cache shares decoded image data
 *  across all instances (separate GPU texture uploads per context).
 *
 *  Ownership — a slot has TWO independent claims and is reclaimable only when
 *  BOTH are dropped (F5/F6):
 *   - `boundBySim`  — Scene2D's claim: the Canvas2D entity is present in the world
 *     (set by allocate(), cleared by release()/releaseAll()).
 *   - `mounted`     — Canvas2DMount's claim: the slot's <canvas> is in the DOM
 *     (set by mount(), cleared by unmount()).
 *  Reclaiming only when both clear stops mount/unmount churn from leaking slots
 *  (F5) and stops the shrink/reuse paths from destroying the WebGL context behind
 *  a still-visible canvas (F6). `entityId === null` is the canonical "unclaimed"
 *  marker — it's nulled only by reclaimIfUnclaimed(), i.e. once both claims drop.
 *
 *  INSTANCING (SceneView-Pixi migration Phase 0a): the pool is a {@link Canvas2DPool}
 *  CLASS so each viewport (runtime/GameView, editor SceneView) owns an independent set of
 *  slots — a Pixi display object and a <canvas> can each live in only ONE place, so two
 *  viewports rendering the same Canvas2D entity through different cameras need separate
 *  slots. A module-level {@link defaultPool} backs the free-function exports so the runtime,
 *  `Game.tsx`, and `Canvas2DMount` behave exactly as before. NOTE: the `Assets` decoded-image
 *  cache is GLOBAL and shared across pools — its refcounting (Scene2D's `spriteTextureRefs`)
 *  must stay global too, or one viewport's release would unload a texture another still shows. */

import { Application, Container } from 'pixi.js';
import { getWebGPUSupported } from './gpuDetect';
import { getRenderSettings } from './renderSettings';

/** Resolve the PixiJS renderer backend the Canvas2D layer will actually use:
 *  honor an explicit `pixi.backend` render-setting ('webgpu'/'webgl'), else fall
 *  back to hardware detection ('auto'). This is the SINGLE source of truth for
 *  "which backend" — `Canvas2DPool.initPool` and `pixiShaderBuilder` (which must
 *  compile the matching WGSL vs GLSL program) both read it, so a forced-backend
 *  override can never make the compiled shader mismatch the live renderer. */
export async function resolvePixiBackend(): Promise<'webgpu' | 'webgl'> {
  const backend = getRenderSettings().pixi.backend;
  if (backend === 'webgpu' || backend === 'webgl') return backend;
  return (await getWebGPUSupported()) ? 'webgpu' : 'webgl';
}

// ── Soft GPU-context budget (SceneView-Pixi migration Phase 5) ──
// Each initialized slot Application = one live GPU context. Browsers cap live WebGL contexts
// (~8–16) and evict the oldest past that; WebGPU has its own limits. Real Canvas2D counts are 1–2
// per scene, and the editor lazy-mounts its 2D surface only in 2D mode — so a healthy session stays
// well under the cap. This is a global (cross-pool) COUNT with a one-shot warn if it climbs past a
// soft threshold, to catch a leak (slots not reclaimed) or an unexpectedly context-heavy scene
// before the browser silently drops a context. Not a hard cap — it never blocks allocation.
const SOFT_CONTEXT_LIMIT = 8;
let _liveContexts = 0;
let _contextWarned = false;
function noteContextCreated(): void {
  _liveContexts++;
  if (_liveContexts > SOFT_CONTEXT_LIMIT && !_contextWarned) {
    _contextWarned = true;
    console.warn(
      `[canvas2DPool] ${_liveContexts} live PixiJS GPU contexts (soft limit ${SOFT_CONTEXT_LIMIT}). ` +
      `Browsers evict the oldest WebGL context past their cap — check for un-reclaimed Canvas2D slots ` +
      `or an unusually context-heavy scene. (Warned once; not a hard limit.)`,
    );
  }
}
function noteContextDestroyed(): void {
  if (_liveContexts > 0) _liveContexts--;
  // Deliberately NOT re-armed: warn at most ONCE per session. Re-arming at the threshold would
  // re-spam the identical warning every acquire/release cycle for a session hovering at the limit
  // (e.g. scene swaps that acquire-new-then-release-old). A genuine leak climbs monotonically and is
  // caught by the single warn; the transient-spike case doesn't need a second.
}
/** Live PixiJS GPU-context count across all Canvas2D pools (test/diagnostics). */
export function liveCanvas2DContextCount(): number { return _liveContexts; }

export interface Canvas2DSlot {
  canvas: HTMLCanvasElement;
  container: Container;
  app: Application;
  entityId: number | null;
  /** Resolves when the Application is fully initialized and ready to render. */
  ready: Promise<void>;
  initialized: boolean;
  /** Scene2D claim — the Canvas2D entity is present in the world. */
  boundBySim: boolean;
  /** Canvas2DMount claim — the slot's <canvas> is mounted in the DOM. */
  mounted: boolean;
  /** Consecutive frames this slot's renderer threw — distinguishes a one-frame
   *  teardown blip (swallowed silently) from a genuinely stuck renderer. */
  renderFailFrames?: number;
}

const MAX_SLOTS = 6;
/** Frames a slot must throw consecutively before we treat it as stuck (not a blip). */
const STUCK_RENDER_FRAMES = 30;

/** Detach all children from a container WITHOUT destroying them. The display
 *  objects are owned by Scene2D — it destroys them and releases their texture
 *  refcounts in disposeSlot. The pool only detaches so a freed slot can be reused
 *  clean. Destroying here too would double-free: in the per-frame path Scene2D
 *  calls release() BEFORE its own dispose loop, so a destroy here would leave the
 *  dispose loop re-destroying an already-dead object and decrementing its texture
 *  refcount twice (F4). Stateless — shared by every pool instance. */
function detachChildren(container: Container): void {
  while (container.children.length > 0) {
    container.children[0].removeFromParent();
  }
}

export class Canvas2DPool {
  private preference: 'webgpu' | 'webgl' = 'webgl';
  private preferenceResolved = false;
  private initPromise: Promise<void> | null = null;
  /** One-shot guard so a PERSISTENT render failure warns at most once per session. */
  private _stuckRenderWarned = false;
  private readonly slots: Canvas2DSlot[] = [];
  private readonly entityMap = new Map<number, Canvas2DSlot>();

  private async initSlotApp(slot: Canvas2DSlot): Promise<void> {
    if (slot.initialized) return;
    if (!this.preferenceResolved) await this.initPool();

    const pixi = getRenderSettings().pixi;
    await slot.app.init({
      preference: this.preference,
      canvas: slot.canvas,
      antialias: pixi.antialias,
      // resolution 0 = auto (Pixi's default: devicePixelRatio). A positive value pins it.
      ...(pixi.resolution > 0 ? { resolution: pixi.resolution, autoDensity: true } : {}),
      backgroundAlpha: 0,
      // LOAD-BEARING for F1's idle/skip render — do NOT drop. Scene2D skips
      // renderer.render on idle/unchanged canvases (renderAll(dirtyIds)); a non-preserved
      // back buffer would blank such a canvas the next time the browser recomposites its
      // layer (scroll, ancestor transform/opacity, tab refocus, DPR/resize) with no fresh
      // WebGL draw. Preserving the buffer keeps the last frame visible across recomposites.
      // (See engine-review F8 — kept by design, superseded by F1.)
      preserveDrawingBuffer: true,
      width: slot.canvas.width || 1,
      height: slot.canvas.height || 1,
    });
    // The slot can be freed DURING this async init (allocate → release before it resolves), after which
    // the shrink/destroy paths splice it out WITHOUT destroying its app (they gate on `initialized`,
    // still false here). Detect that and tear the freshly-created context down now — otherwise it's an
    // orphaned GPU context (never destroyed) and would mis-count the live-context total.
    if (!this.slots.includes(slot)) { slot.app.destroy(true); return; }
    slot.app.ticker.stop();
    slot.app.stage.addChild(slot.container);
    slot.initialized = true;
    noteContextCreated();
  }

  private createSlot(): Canvas2DSlot {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const container = new Container();
    // Stack children by hierarchy paint order (zIndex). Set ONCE here, not every
    // frame — Pixi only re-sorts when a child's zIndex changes or a child is
    // added, so a static stack pays nothing (F9). Scene2D assigns zIndex on change.
    container.sortableChildren = true;
    const app = new Application();
    const slot: Canvas2DSlot = { canvas, container, app, entityId: null, ready: Promise.resolve(), initialized: false, boundBySim: false, mounted: false };
    // Start async init immediately — `ready` tracks completion
    slot.ready = this.initSlotApp(slot);
    return slot;
  }

  /** Initialize the pool — resolves GPU preference.
   *  Safe to call multiple times (returns cached promise). */
  initPool(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.preference = await resolvePixiBackend();
      this.preferenceResolved = true;
    })();
    return this.initPromise;
  }

  /** Get the first initialized Application (for renderer detection), or null. */
  getApp(): Application | null {
    for (const slot of this.slots) {
      if (slot.initialized) return slot.app;
    }
    return null;
  }

  /** Find a free (unclaimed) slot or create one; bind it to `entityId` and index it.
   *  Returns null at capacity. A slot counts as free only when `entityId === null`,
   *  which — since entityId is nulled only once BOTH claims drop — means no sim
   *  binding AND no mounted canvas, so this never reuses a slot whose canvas is
   *  still on screen (F6). */
  private takeFreeSlot(entityId: number): Canvas2DSlot | null {
    let slot = this.slots.find(s => s.entityId === null);
    if (!slot) {
      if (this.slots.length >= MAX_SLOTS) {
        console.warn(`[canvas2DPool] Max slots (${MAX_SLOTS}) reached, cannot allocate for entity ${entityId}`);
        return null;
      }
      slot = this.createSlot();
      this.slots.push(slot);
    }
    slot.entityId = entityId;
    this.entityMap.set(entityId, slot);
    return slot;
  }

  /** Reclaim a slot to the free pool once it has NO claims (neither sim-bound nor
   *  mounted). Detaches any leftover children (Scene2D owns destruction) and unbinds
   *  the entity so the slot can be reused. No-op while either claim is still held. */
  private reclaimIfUnclaimed(slot: Canvas2DSlot): void {
    if (slot.boundBySim || slot.mounted) return;
    detachChildren(slot.container);
    slot.container.position.set(0, 0);
    slot.container.scale.set(1, 1);
    slot.container.rotation = 0;
    if (slot.entityId !== null) this.entityMap.delete(slot.entityId);
    slot.entityId = null;
  }

  /** Claim a slot for a Canvas2D ENTITY (Scene2D, per-frame). Get-or-create, mark
   *  the sim claim. Returns the slot, or null at capacity. The slot's Application
   *  may still be initializing — check slot.initialized / await slot.ready before
   *  rendering. */
  allocate(entityId: number): Canvas2DSlot | null {
    const slot = this.entityMap.get(entityId) ?? this.takeFreeSlot(entityId);
    if (!slot) return null;
    slot.boundBySim = true;
    return slot;
  }

  /** Claim a slot for MOUNTING its canvas into the DOM (Canvas2DMount). Get-or-create
   *  + mark the mount claim, so the slot is never shrunk or reused while on screen
   *  (F5/F6). Returns the slot, or null at capacity. Pair every successful call with
   *  unmount(). */
  mount(entityId: number): Canvas2DSlot | null {
    const slot = this.entityMap.get(entityId) ?? this.takeFreeSlot(entityId);
    if (!slot) return null;
    slot.mounted = true;
    return slot;
  }

  /** Drop the mount claim — the canvas left the DOM. Reclaims the slot if Scene2D
   *  isn't holding it either. This is what stops mount/unmount churn from leaking
   *  slots until the pool is exhausted (F5). */
  unmount(entityId: number): void {
    const slot = this.entityMap.get(entityId);
    if (!slot) return;
    slot.mounted = false;
    this.reclaimIfUnclaimed(slot);
  }

  /** Drop the Scene2D (sim) claim — the entity left the world. The slot survives if
   *  its canvas is still mounted (F6); otherwise it's reclaimed for reuse. */
  release(entityId: number): void {
    const slot = this.entityMap.get(entityId);
    if (!slot) return;
    slot.boundBySim = false;
    this.reclaimIfUnclaimed(slot);
  }

  /** Get the slot for an entity, or null if not allocated. */
  getSlot(entityId: number): Canvas2DSlot | null {
    return this.entityMap.get(entityId) ?? null;
  }

  /** Resize the canvas for an entity (pixel size, not CSS size). */
  resize(entityId: number, w: number, h: number): void {
    const slot = this.entityMap.get(entityId);
    if (!slot) return;
    if (slot.canvas.width !== w || slot.canvas.height !== h) {
      if (slot.initialized) {
        slot.app.renderer.resize(w, h);
      } else {
        slot.canvas.width = w;
        slot.canvas.height = h;
      }
    }
  }

  /** Render allocated & initialized slots. Called once per frame. When `dirtyIds`
   *  is given, only slots whose entity is in that set are GPU-rendered — Scene2D
   *  passes the set of Canvas2D entities whose content actually changed this frame,
   *  so a static 2D layer pays no render pass (F1). With `preserveDrawingBuffer`,
   *  the skipped canvas keeps its last frame on screen. Omit `dirtyIds` to render
   *  every slot (back-compat). Always shrinks idle slots regardless of dirtiness. */
  renderAll(dirtyIds?: Set<number>): void {
    for (const slot of this.slots) {
      if (slot.entityId === null || !slot.initialized) continue;
      if (slot.canvas.width <= 1 || slot.canvas.height <= 1) continue;
      if (dirtyIds && !dirtyIds.has(slot.entityId)) continue;
      // A slot's Application can be mid-teardown during a world swap (a scene reload —
      // e.g. Apply-to-Prefab undo's loadScene — or a Canvas2DMount unmount), or lose its
      // WebGL context when its <canvas> leaves the DOM. The renderer object still exists
      // but its internal batcher is transiently null, so `render()` throws deep in PixiJS
      // (`_DefaultBatcher.break`). Isolate it: skip a gone renderer and swallow a
      // teardown-race throw, so one stale canvas can't throw out of the `render2d` frame
      // callback (which the frameDriver would surface as a hard error).
      const renderer = slot.app?.renderer;
      if (!renderer) continue;
      try {
        renderer.render(slot.app.stage);
        slot.renderFailFrames = 0;
      } catch (err) {
        // A canvas mid-teardown during a world swap (scene reload / Canvas2DMount unmount)
        // loses its WebGL context, so render() throws for a frame or two until the slot is
        // reclaimed. Swallow that transient SILENTLY. Only a renderer that fails for many
        // CONSECUTIVE frames is genuinely stuck — surface that, once, in dev.
        slot.renderFailFrames = (slot.renderFailFrames ?? 0) + 1;
        if (import.meta.env?.DEV && slot.renderFailFrames === STUCK_RENDER_FRAMES && !this._stuckRenderWarned) {
          this._stuckRenderWarned = true;
          console.warn(`[canvas2DPool] canvas (entity ${slot.entityId}) has failed to render for ${STUCK_RENDER_FRAMES} consecutive frames — possible stuck renderer:`, err);
        }
      }
    }
    // Shrink pool: destroy idle (unclaimed) slots, keeping at least 1 spare. A slot
    // is a shrink candidate only when `entityId === null` (no sim NOR mount claim);
    // additionally never destroy one whose <canvas> is still in the DOM — its WebGL
    // context is live behind a visible canvas (F6). The DOM check is belt-and-braces:
    // an unclaimed slot should already have had its canvas removed, but the DOM is the
    // ultimate source of truth.
    const allocated = this.entityMap.size;
    const spare = this.slots.length - allocated;
    if (spare > 1) {
      for (let i = this.slots.length - 1; i >= 0 && this.slots.length - allocated > 1; i--) {
        const s = this.slots[i];
        if (s.entityId === null && s.canvas.parentElement === null) {
          s.container.destroy();
          if (s.initialized) { s.app.destroy(true); noteContextDestroyed(); }
          this.slots.splice(i, 1);
        }
      }
    }
  }

  /** Drop the sim claim on every slot (world swap). A still-mounted canvas survives
   *  until its Canvas2DMount unmounts (F6); everything else is reclaimed. Children are
   *  detached, not destroyed — Scene2D owns destruction (F4) and has already disposed
   *  them in its onWorldSwap handler before this runs. */
  releaseAll(): void {
    for (const slot of this.slots) {
      if (slot.boundBySim) {
        slot.boundBySim = false;
        this.reclaimIfUnclaimed(slot);
      }
    }
  }

  /** Get all currently allocated entity IDs. */
  getAllocatedEntityIds(): Set<number> {
    return new Set(this.entityMap.keys());
  }

  /** Destroy the pool and all Applications. */
  destroyPool(): void {
    this.releaseAll();
    for (const slot of this.slots) {
      slot.container.destroy();
      if (slot.initialized) { slot.app.destroy(true); noteContextDestroyed(); }
    }
    this.slots.length = 0;
    this.entityMap.clear();
    this.initPromise = null;
    this.preferenceResolved = false;
  }
}

// ── Default instance + free-function API ──
// A single default pool backs the runtime / GameView / Canvas2DMount so nothing outside
// this module changes. The editor SceneView will construct its OWN Canvas2DPool so its 2D
// surfaces don't collide with GameView's slots (Phase 0c).
export const defaultPool = new Canvas2DPool();

export function initPool(): Promise<void> { return defaultPool.initPool(); }
export function getApp(): Application | null { return defaultPool.getApp(); }
export function allocate(entityId: number): Canvas2DSlot | null { return defaultPool.allocate(entityId); }
export function mount(entityId: number): Canvas2DSlot | null { return defaultPool.mount(entityId); }
export function unmount(entityId: number): void { defaultPool.unmount(entityId); }
export function release(entityId: number): void { defaultPool.release(entityId); }
export function getSlot(entityId: number): Canvas2DSlot | null { return defaultPool.getSlot(entityId); }
export function resize(entityId: number, w: number, h: number): void { defaultPool.resize(entityId, w, h); }
export function renderAll(dirtyIds?: Set<number>): void { defaultPool.renderAll(dirtyIds); }
export function releaseAll(): void { defaultPool.releaseAll(); }
export function getAllocatedEntityIds(): Set<number> { return defaultPool.getAllocatedEntityIds(); }
export function destroyPool(): void { defaultPool.destroyPool(); }
