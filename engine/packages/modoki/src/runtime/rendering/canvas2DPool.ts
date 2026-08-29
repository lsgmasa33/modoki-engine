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
 *   - `mounted`     — Canvas2DMount's claim: that component owns this slot's <canvas>
 *     (set by mount(), cleared by unmount()).
 *
 *  ⚠️ **The CLAIMS are the ownership truth — `canvas.parentElement` is not.** The claim is taken
 *  synchronously by `mount()`, but `Canvas2DMount` appends the canvas only once `slot.ready`
 *  resolves, i.e. after an async `Application.init()`. Inside that gap a slot is fully claimed and
 *  its canvas has no parent, so any teardown that asks the DOM "is anyone using this?" gets the
 *  wrong answer. Reading the DOM as a proxy for the claim is the #213 defect — see `destroyPool`.
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
import { getRenderSettings, getEffectivePixiSettings } from './renderSettings';
import { registerPointerPassthrough } from '../core/pointerBlockers';
import { createRendererRecovery, type RendererRecovery } from './rendererRecovery';
import { areDebugHandlesEnabled } from '../core/debugHandles';

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
  /** Canvas2DMount claim — that component owns this slot and its <canvas>.
   *
   *  ⚠️ NOT "the canvas is in the DOM". The claim is taken by `mount()` synchronously; the append
   *  happens later, when `slot.ready` resolves. Treat THIS, never `canvas.parentElement`, as the
   *  answer to "is anyone still using this slot?" (#213). */
  mounted: boolean;
  /** Consecutive frames this slot's renderer threw — distinguishes a one-frame
   *  teardown blip (swallowed silently) from a genuinely stuck renderer. */
  renderFailFrames?: number;
  /** Disposer for this canvas's pointer-PASSTHROUGH registration (`core/pointerBlockers.ts`).
   *  Held per slot so it is dropped when the slot is destroyed rather than leaking a registration
   *  for a dead canvas. */
  unpassthrough?: () => void;
  /** Disposer for this canvas's `webglcontextlost`/`restored` listeners. They close over the SLOT,
   *  not the canvas, so a listener left on a replaced or destroyed canvas keeps mutating a live
   *  slot — and Pixi forces a context loss on every `app.destroy()`, so that fires for real. */
  detachCanvasListeners?: () => void;
  /** This slot's WebGL context has been lost and not restored — every draw into it is a no-op.
   *
   *  ⚠️ Until #213 the 2D path had NO notion of this, and that is the whole reason a lost context
   *  presented as a mystery: the surface keeps its size, its opacity and its place in the DOM, the
   *  ECS stays perfectly correct, `renderAll` keeps issuing draws — and the screen is blank, with
   *  no error anywhere. Measured on an iPhone 8 (A11 / iOS 16) launched from Xcode, where the
   *  debug dylib + Previews probing add enough pressure for WebKit to drop the context: canvas
   *  750x1334, opacity 1, all 64 board entities present and sized, and `gl.isContextLost()` true
   *  with a 0x0 drawing buffer. The 3D path has watched for this since #121
   *  (`core/activeRenderer.ts` + `rendering/rendererRecovery.ts`); the 2D path never did, so a
   *  2D-only game had no protection at all. */
  contextLost?: boolean;
  /** This slot has been spliced out of the pool for good — no rebuild may target it.
   *
   *  ⚠️ An EXPLICIT flag, not `!pool.slots.includes(slot)`. That inference reads "not in the pool"
   *  as "disposed", and it is also true for a slot that has not been PUSHED yet — which made
   *  recovery unreachable for exactly the case #213 is about: the context is lost during
   *  `createSlot`, before `takeFreeSlot` pushes, so the rebuild request was silently dropped and
   *  no message was ever printed. */
  destroyed?: boolean;
  /** Rebuild scheduler for this slot's renderer — the SAME policy module the 3D viewports use
   *  (`rendering/rendererRecovery.ts`), so the two cannot disagree about when a rebuild runs. */
  recovery?: RendererRecovery;
}

/** How long a rebuild's `Application.init()` may take before it counts as failed.
 *  Generous — a real bring-up on a slow phone is well under this — but FINITE, because init on a
 *  dead GPU can never settle at all (#213). */
const REBUILD_INIT_TIMEOUT_MS = 8000;

/** Reject if `p` has not settled within `ms`. The rejection is what lets `rendererRecovery` retry
 *  with backoff; without it a hung bring-up stalls recovery forever, in silence. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
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
  /** One-shot guard for the #213 "teardown during Canvas2DMount's async gap" report. */
  private _keptMidMountWarned = false;
  /** Set when a slot's renderer was rebuilt after GPU context loss; consumed by the renderer,
   *  which owes the new (empty) frame a FULL redraw. See `consumeRebuildFlag`. */
  private _rebuiltSinceLastRender = false;
  private readonly slots: Canvas2DSlot[] = [];
  private readonly entityMap = new Map<number, Canvas2DSlot>();


  /** Wire a slot's canvas: pointer passthrough + GPU-context-loss handling. Called for the
   *  original canvas and again for any REPLACEMENT one, so a rebuilt slot is not left deaf to a
   *  second loss (which is exactly how a recovered surface would quietly die again). */
  private attachCanvasListeners(slot: Canvas2DSlot, canvas: HTMLCanvasElement): void {
    slot.unpassthrough?.();
    slot.unpassthrough = registerPointerPassthrough(canvas);
    // NOTE: deliberately no `slot.detachCanvasListeners?.()` mirror of the line above. Every caller
    // detaches BEFORE it destroys the old app (see `rebuildSlotApp` and the two destroy paths) —
    // it has to, because Pixi fires a context loss during that destroy, which is earlier than this
    // point. A second detach here would be unreachable, and worse: it would mask the real one, so
    // removing either would leave the tests green. One mechanism, one test that fails without it.
    const onLost = (e: Event) => {
      // ⚠️ OUR OWN teardown fires this. Pixi's `GlContextSystem.destroy()` ends with
      // `extensions.loseContext?.loseContext()` — an EXPLICIT forced context loss on every
      // `app.destroy()` — and it removes only Pixi's own listeners, not ours. Without this guard a
      // perfectly correct teardown emits two loud errors swearing the surface will stay blank and
      // citing #213, which is exactly the misleading diagnostic that made #213 cost what it did.
      if (slot.destroyed) return;
      // preventDefault is what makes the browser willing to restore the context at all; three's
      // WebGL backend does this for the 3D canvas, and nothing was doing it for ours.
      e.preventDefault();
      slot.contextLost = true;
      console.error(
        `[canvas2DPool] WebGL CONTEXT LOST on the 2D canvas for entity ${slot.entityId} — every ` +
        `draw into it is now a no-op and the surface will stay BLANK (size, opacity and DOM ` +
        `position all stay correct, which is why this looks like "nothing renders"). Rebuilding. ` +
        `See #213.`,
      );
      // Requested on LOSS as well as on restore, deliberately. Waiting only for
      // `webglcontextrestored` is the tidier reading of the spec and it is a BET that the browser
      // fires it — measured on an iPhone 8, it does not: the context died at boot and was never
      // restored, so a restore-only trigger would wait forever.
      slot.recovery?.request();
    };
    const onRestored = () => {
      if (slot.destroyed) return;
      slot.contextLost = false;
      slot.recovery?.request();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    // A disposer, because these listeners close over `slot` — NOT over the canvas they sit on. A
    // replaced canvas whose listeners were never removed goes on mutating the LIVE slot: the
    // forced loss from destroying the old app would set `contextLost = true` on the freshly
    // rebuilt slot and request a redundant second rebuild. See `rebuildSlotApp`.
    slot.detachCanvasListeners = () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
  }

  /** Bring a NEW Pixi Application up on a slot whose GPU context died (#213).
   *
   *  Rebuilding is the only route back: the old renderer's device is gone, and every GPU resource
   *  it held died with it. Pixi's scene graph is renderer-agnostic, so `slot.container` and its
   *  children SURVIVE — they are re-attached to the new stage and their textures re-upload on the
   *  next draw. That is why this does not tear the display objects down.
   *
   *  ⚠️ The canvas ELEMENT is deliberately kept. It is mounted in the DOM by `Canvas2DMount`,
   *  which holds this exact node; swapping it would need the mount to re-attach, and the element
   *  is not what died — the context is. `destroy(false)` is load-bearing for the same reason: the
   *  `destroy(true)` used elsewhere in this file also destroys the canvas, which here would leave
   *  a mounted, permanently dead node.
   *
   *  Scheduling (delay, single-flight, coalescing, bounded backoff) is NOT here — it belongs to
   *  `rendererRecovery.ts`, which the 3D viewports already use. */
  private async rebuildSlotApp(slot: Canvas2DSlot): Promise<void> {
    // Detach the surviving scene graph BEFORE destroying, so the old app cannot take it down.
    slot.container.removeFromParent();
    // …and detach the OLD canvas's context listeners before destroying its app, because Pixi's
    // teardown deliberately fires a context loss (`GlContextSystem.destroy` → `loseContext()`).
    // These listeners close over the SLOT, so leaving them attached would let the old element
    // flip `contextLost` back to true on the slot we are about to rebuild and queue a second,
    // redundant rebuild through `recovery.request()`'s `again` flag.
    slot.detachCanvasListeners?.();
    slot.detachCanvasListeners = undefined;
    if (slot.initialized) {
      try { slot.app.destroy(false); } catch { /* a dead renderer often throws on teardown — the
        point is to stop referencing it, and a throw here must not abort the rebuild */ }
      noteContextDestroyed();
    }

    // ⚠️ A FRESH canvas element, not the old one. Re-initialising on the same canvas was the
    // obvious first attempt and it does not work: once a context is lost and the browser never
    // fires `webglcontextrestored`, that element keeps handing back a DEAD context forever.
    // Measured on an iPhone 8 — after the rebuild request, the page still had exactly one canvas,
    // `isContextLost()` true and a 0x0 drawing buffer. A new element is the only reliable way to
    // get a live context back.
    //
    // Swapped IN PLACE so `Canvas2DMount` needs no involvement: it appended the old node, and
    // `replaceWith` keeps the new one at the same position with the same inline styles (the
    // `width:100%/height:100%/display:block` the mount set). The mount's own `slot.canvas`
    // reference is re-read from the slot on its next size pass.
    const oldCanvas = slot.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = oldCanvas.width || 1;
    canvas.height = oldCanvas.height || 1;
    canvas.style.cssText = oldCanvas.style.cssText;
    oldCanvas.replaceWith?.(canvas);
    slot.canvas = canvas;
    this.attachCanvasListeners(slot, canvas);   // the new element must hear a SECOND loss

    slot.initialized = false;
    slot.app = new Application();
    // ⚠️ Bounded, because `Application.init()` on a dead GPU can HANG rather than reject — and a
    // hang is worse than a failure here: `rendererRecovery` waits on this promise, so nothing
    // retries, nothing reports, and the surface stays blank in silence. That is exactly what the
    // first version of this did (measured: the loss was logged, and neither a success nor a
    // failure ever followed). A timeout converts it into a retryable rejection.
    await withTimeout(this.initSlotApp(slot), REBUILD_INIT_TIMEOUT_MS, 'Pixi Application.init');
    // `initSlotApp` can complete having THROWN THE APP AWAY — the slot was disposed mid-rebuild, or
    // a later rebuild superseded this one. Reporting success there would log "renderer rebuilt"
    // for a renderer that does not exist, which is the same class of lie as the silent decline
    // this commit's `onSkipped` exists to remove.
    if (!slot.initialized) return;
    slot.contextLost = false;
    // The new renderer starts with an EMPTY frame, and Scene2D only redraws what it believes
    // changed — so without a full redraw the surface stays blank behind a perfectly healthy
    // context, which is the original bug wearing a different hat. Raised as a FLAG the renderer
    // consumes rather than by calling `markScene2DDirty()` here: the pool must not import
    // Scene2D. Scene2D already depends on the pool, and reaching back would make the two mutually
    // recursive for no gain.
    this._rebuiltSinceLastRender = true;
    console.warn(`[canvas2DPool] 2D renderer rebuilt after context loss (entity ${slot.entityId}).`);
  }

  private async initSlotApp(slot: Canvas2DSlot): Promise<void> {
    if (slot.initialized) return;
    if (!this.preferenceResolved) await this.initPool();

    // TIER-ADJUSTED (#202) — `antialias` is one of the two 2D fields a tier may clamp. ⚠️ Like its
    // 3D twin it is a CONSTRUCTOR option (baked in by `Application.init` below), so a tier
    // resolved or changed after this slot exists cannot walk it back; it catches up on the next
    // slot creation. `resolution` is not passed at all (see the block comment below), and
    // `backend` is deliberately not tier-clampable.
    const pixi = getEffectivePixiSettings();
    // Deliberately do NOT pass `resolution`/`autoDensity` here — Pixi stays at its default
    // resolution of 1, so `renderer.resize(w, h)` (called from Canvas2DMount via
    // canvas2DSizing.computeBackingSize) means literally "w×h backing pixels", and the
    // ENGINE owns the whole backing-size computation in one place instead of splitting it
    // between here and Canvas2DMount. Three reasons:
    //  - it makes `pixi.resolution` mean ONE thing (a DPR override folded into
    //    computeBackingSize) instead of ALSO multiplying with the DPR already applied in
    //    Canvas2DMount.measure() — that double-count was latent (resolution>0 today only
    //    happens to be inert because no project sets it, per #38's audit).
    //  - Pixi's `autoDensity: true` also wrote inline canvas style width/height, fighting
    //    Canvas2DMount's `style.width = '100%'` / `style.height = '100%'`.
    //  - keeping Pixi at resolution 1 preserves today's stage coordinate space (device px),
    //    which `canvas2DScaler` maps design→canvas pixels against.
    // ⚠️ CAPTURE the instance — do not re-read `slot.app` after the await. `rebuildSlotApp`
    // REASSIGNS `slot.app`, which broke the assumption this function was written under (one
    // Application per slot, assigned once in `createSlot`). Concretely: a rebuild whose `init()`
    // exceeds `REBUILD_INIT_TIMEOUT_MS` rejects but does NOT cancel — the retry then assigns a new
    // Application, and when the abandoned `init()` finally settles (a slow-but-alive driver, which
    // is exactly what the timeout exists to bound) this code resumes and configures the RETRY's
    // app a second time, double-counting `noteContextCreated()` while the timed-out one is never
    // destroyed at all: a live GPU context leaked, and the budget wrong in both directions.
    const app = slot.app;
    await app.init({
      preference: this.preference,
      canvas: slot.canvas,
      antialias: pixi.antialias,
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
    //
    // ⚠️ Gate on the EXPLICIT `destroyed` flag, never on `!this.slots.includes(slot)` — the very
    // inference `Canvas2DSlot.destroyed` exists to replace. "Not in the pool" is also true of a slot
    // that has not been PUSHED yet, and (until the fix in `destroyPool`) of a slot still claimed by a
    // live Canvas2DMount: this line is what actually killed the context in #213, destroying a
    // brand-new renderer out from under a mount that was about to show its canvas. Every path that
    // splices a slot for good sets `destroyed` first, so this is strictly more precise.
    // `slot.app !== app` means a rebuild superseded us while we were awaiting (see the capture
    // above): this Application is an orphan the moment it finishes, so destroy it here — nothing
    // else holds a reference and nothing else ever will.
    if (slot.destroyed || slot.app !== app) { app.destroy(true); return; }
    app.ticker.stop();
    app.stage.addChild(slot.container);
    slot.initialized = true;
    noteContextCreated();
  }

  private createSlot(): Canvas2DSlot {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    // This canvas is the GAME's own render surface, so a press on it is never a press on chrome —
    // even though the standard scene shape puts `Canvas2D` on a `UIElement`, which makes it a
    // DESCENDANT of the UIRenderer's block root. Without this, every 2D game's pointer input is
    // dead (see `core/pointerBlockers.ts`'s PASSTHROUGH SURFACES note). Registered on the CANVAS
    // ELEMENT itself, never a wrapper: a UI element can never be a canvas's DOM descendant, so UI
    // over the canvas still blocks correctly.
    const container = new Container();
    // Stack children by hierarchy paint order (zIndex). Set ONCE here, not every
    // frame — Pixi only re-sorts when a child's zIndex changes or a child is
    // added, so a static stack pays nothing (F9). Scene2D assigns zIndex on change.
    container.sortableChildren = true;
    const app = new Application();
    const slot: Canvas2DSlot = { canvas, container, app, entityId: null, ready: Promise.resolve(), initialized: false, boundBySim: false, mounted: false };
    slot.unpassthrough = registerPointerPassthrough(canvas);

    // ── GPU context loss (#213) ────────────────────────────────────────────────────────────────
    // A lost WebGL context is INVISIBLE from every other angle: the canvas keeps its size and its
    // place in the DOM, the ECS stays correct, and `renderAll` keeps issuing draws that do
    // nothing. The screen just goes blank. The 3D path has watched for this since #121; this is
    // the 2D twin of `attachWebGlContextLostListener` in `core/activeRenderer.ts`.
    //
    // Attached at CREATION, before `initSlotApp`, deliberately: the loss we actually hit happened
    // at boot on an iPhone 8 launched from Xcode, and a listener added after `init()` resolves
    // would miss exactly that case — which is the one that leaves a game blank for the whole
    // process lifetime (`rendererRecovery.ts` records the same shape on a Huawei Y6).
    //
    // RECOVERY reuses `rendererRecovery.ts` — the SAME policy the 3D viewports run, rather than a
    // second one that can disagree with it. It already encodes the four rules that matter here:
    // never rebuild inside the loss event, one rebuild at a time, coalesce losses that arrive
    // during a rebuild, and retry a failed rebuild with bounded backoff (a driver that just reset
    // often needs a moment).
    slot.recovery = createRendererRecovery({
      rebuild: () => this.rebuildSlotApp(slot),
      // A slot destroyed for good must not be rebuilt into — that would leak a GPU context nobody
      // will ever destroy. See `Canvas2DSlot.destroyed` for why this is not `slots.includes`.
      isDisposed: () => slot.destroyed === true,
      // A dropped request is reported too — see RendererRecoveryDeps.onSkipped. 'timer-pending'
      // and 'in-flight' are normal coalescing; 'disposed' on a live slot is a BUG and the one
      // that would otherwise look like nothing happened at all.
      onSkipped: (reason) => {
        if (reason === 'disposed') {
          console.error(
            `[canvas2DPool] rebuild request DROPPED as 'disposed' for entity ${slot.entityId} — ` +
            `destroyed=${slot.destroyed} inPool=${this.slots.includes(slot)}. The surface will ` +
            `stay blank. See #213.`,
          );
        }
      },
      onError: (_e, info) => console.error(
        `[canvas2DPool] 2D renderer rebuild after context loss FAILED (attempt ${info.attempt}` +
        `${info.willRetry ? ', retrying' : ', giving up'}): ${info.description}`,
      ),
    });

    this.attachCanvasListeners(slot, canvas);

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

  /** Did a slot's renderer get rebuilt since the last call? Read-and-clear.
   *
   *  Scene2D calls this each frame and forces a full redraw when it returns true — a rebuilt
   *  renderer has an empty frame, and Scene2D's per-entity change detection would otherwise
   *  conclude nothing needs drawing and leave the surface blank (#213). Read-and-clear so the
   *  forced redraw happens exactly once per rebuild. */
  consumeRebuildFlag(): boolean {
    const v = this._rebuiltSinceLastRender;
    this._rebuiltSinceLastRender = false;
    return v;
  }

  /** Resize the canvas for an entity (pixel size, not CSS size).
   *
   *  ⚠️ **An unmapped entity used to `return` SILENTLY, and that is how a canvas ships stuck at its
   *  `createSlot()` 1x1** (#213): every caller believes it applied a size, so
   *  `retrySizeUntilMeasured` stops retrying and never fires its 0x0 warning, the `ResizeObserver`
   *  no-ops the same way on every later reflow, and the surface renders a 1px buffer stretched over
   *  a full-size box — no error, no warning, a healthy DOM chain and a live WebGL2 context. It took
   *  a live device session to find, because every static check says the code is correct.
   *
   *  **Prefer `resizeSlot` when you already hold the slot** — `Canvas2DMount` does, and re-resolving
   *  it by id is precisely what lets a reclaimed `entityMap` entry silently break a canvas that is
   *  still mounted in the DOM (`reclaimIfUnclaimed` deletes the mapping the moment a slot is neither
   *  sim-bound nor mounted, and the async `app.init()` above documents that window). This overload
   *  stays for callers that genuinely only have an id. */
  resize(entityId: number, w: number, h: number): void {
    const slot = this.entityMap.get(entityId);
    if (!slot) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[canvas2DPool] resize(${entityId}) — no slot mapped to that entity, so this resize did ` +
          `NOTHING. A canvas mounted for this entity will stay at 1x1. See #213.`,
        );
      }
      return;
    }
    this.resizeSlot(slot, w, h);
  }

  /** Resize a slot you already hold — no `entityMap` lookup, so it cannot be defeated by the
   *  slot's entity being reclaimed while its canvas is still on screen. See `resize` above. */
  resizeSlot(slot: Canvas2DSlot, w: number, h: number): void {
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
          // `destroyed` FIRST, and the listeners off, before `app.destroy` — Pixi forces a context
          // loss on teardown, and the handler must know this loss is ours. Setting the flag
          // afterwards would make correctness depend on the browser dispatching the event
          // asynchronously. See `attachCanvasListeners`.
          s.destroyed = true;
          s.detachCanvasListeners?.();
          s.detachCanvasListeners = undefined;
          s.unpassthrough?.();
          s.container.destroy();
          if (s.initialized) { s.app.destroy(true); noteContextDestroyed(); }
          s.recovery?.dispose();
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

  /** Destroy the pool and all Applications.
   *
   *  ⚠️ **A slot a `Canvas2DMount` still CLAIMS is kept** — the same F6 invariant the shrink path
   *  above applies, and for the same reason: destroying its Application destroys the WebGL context
   *  behind a canvas the user is (or is about to be) looking at.
   *
   *  This is the root cause of #213, and the FIRST fix for it tested the wrong thing. It asked the
   *  DOM — `canvas.parentElement !== null` — which is not the ownership signal but a LATER
   *  materialisation of it. `Canvas2DMount` takes the claim synchronously in its effect and appends
   *  the canvas only after `slot.ready` (an async `Application.init()`) resolves. A teardown landing
   *  inside that gap sees a claimed slot with a parentless canvas and destroys it anyway:
   *
   *   1. `mount(10)` → slot created, `mounted = true`, init pending, canvas NOT yet appended.
   *   2. `destroyPool()` → `releaseAll()` leaves `entityId` set (reclaim bails on `mounted`), the
   *      DOM check says "nobody's using it", so the slot is flagged `destroyed` and spliced out.
   *      Its Application is NOT torn down here — `initialized` is still false.
   *   3. `init()` resolves → `initSlotApp`'s orphan check finds the slot gone and destroys the
   *      brand-new, live context. `initialized` never becomes true.
   *   4. `slot.ready` resolves → `Canvas2DMount` appends the now-DEAD canvas into the DOM.
   *   5. `webglcontextlost` fires on a visible canvas; recovery declines ('disposed'); `renderAll`
   *      never even iterates the slot, because it is no longer in the pool.
   *
   *  Result: correct DOM, correct 750×1334 backing size, correct ECS, and not one pixel ever
   *  drawn. Measured exactly so on an iPhone 8 (A11 / iOS 16). It is a RACE — `init()` winning
   *  gives a perfectly healthy boot — which is why fast hardware never showed it and why a single
   *  good boot was never evidence of a fix (measured on device: ~4 of 6 boots failed).
   *
   *  A kept slot is not leaked: it holds no sim claim after `releaseAll()`, so `reclaimIfUnclaimed`
   *  collects it the moment its `Canvas2DMount` unmounts, and the shrink path takes it from there. */
  destroyPool(): void {
    this.releaseAll();
    const kept: Canvas2DSlot[] = [];
    let keptMidMount = 0;
    for (const slot of this.slots) {
      // The CLAIM first, the DOM only as belt-and-braces. Either alone is a slot in use.
      if (slot.mounted || slot.canvas.parentElement !== null) {
        if (slot.mounted && slot.canvas.parentElement === null) keptMidMount++;
        kept.push(slot);
        continue;
      }
      // `destroyed` FIRST, and the listeners off, before `app.destroy` — see the shrink path above.
      slot.destroyed = true;
      slot.detachCanvasListeners?.();
      slot.detachCanvasListeners = undefined;
      slot.unpassthrough?.();
      slot.container.destroy();
      if (slot.initialized) { slot.app.destroy(true); noteContextDestroyed(); }
      slot.recovery?.dispose();
    }
    this.slots.length = 0;
    this.slots.push(...kept);
    this.entityMap.clear();
    // Re-map anything still claimed, so the next `allocate()` for that entity finds ITS slot
    // rather than taking a fresh one and leaving the mounted canvas orphaned and blank.
    for (const slot of kept) if (slot.entityId !== null) this.entityMap.set(slot.entityId, slot);
    this.initPromise = null;
    this.preferenceResolved = false;
    // The #213 race, caught and survived. Reported (once) because it is the ONLY way to tell from
    // a device log that the teardown really did land in Canvas2DMount's async gap — a board that
    // renders proves nothing on its own, since the race is lost only some of the time. NOT
    // dev-gated: the device this was found on is reachable by console log and nothing else.
    if (keptMidMount > 0 && !this._keptMidMountWarned) {
      this._keptMidMountWarned = true;
      console.warn(
        `[canvas2DPool] destroyPool() ran while ${keptMidMount} slot(s) were still claimed by a ` +
        `Canvas2DMount whose canvas had not been appended yet — the #213 race. Kept them instead ` +
        `of destroying their GPU contexts; the surface is unaffected. (Warned once.)`,
      );
    }
  }
}

// ── Default instance + free-function API ──
// A single default pool backs the runtime / GameView / Canvas2DMount so nothing outside
// this module changes. The editor SceneView will construct its OWN Canvas2DPool so its 2D
// surfaces don't collide with GameView's slots (Phase 0c).
export const defaultPool = new Canvas2DPool();

export function initPool(): Promise<void> {
  // Mirrors Scene3D.tsx's `window.__3d` — same gate, same reason: without a live
  // handle on the 2D/PixiJS surface, an agent inspecting a Canvas2D entity's texture bindings,
  // filters or container tree had to reach into this module's internals (`canvas2DPool.getApp()`)
  // directly, which only a source read could discover. `pool` (not a single `app`) because this
  // pool holds one Application PER Canvas2D entity slot — `getApp()` on it is the "first
  // initialized" convenience the workaround already used; `getSlot(entityId).app` reaches a
  // specific one.
  //
  // ⚠️ GameView ONLY, same as `window.__3d` — the SAME caveat CLAUDE.md already documents for
  // it ("window.__3d is the runtime GameView, NOT the editor SceneView"). `defaultPool` backs
  // ONLY the runtime/`Game.tsx` GameView; the editor SceneView's 2D surface is a SEPARATE
  // `Canvas2DPool` instance (`editor/rendering/editorScene2D.ts`) that never assigns this handle
  // — a 2D render bug on the SceneView (the render-on-demand surface where these bugs live, per
  // CLAUDE.md's own rendering-debug rules) will read as `window.__2d.getApp() === null` here,
  // which means "wrong surface", not "not rendering".
  //
  // `typeof window` guard: unlike Scene3D.tsx's assignment (inside a component that only ever
  // mounts client-side), `initPool` is a free function reachable from `runtime/index.ts` by
  // anything, including a Node-side caller with no DOM — an unguarded `window` there throws
  // ReferenceError instead of returning the promise this function promises to return.
  if (typeof window !== 'undefined' && (import.meta.env.DEV || areDebugHandlesEnabled())) {
    (window as any).__2d = { pool: defaultPool, getApp: () => defaultPool.getApp() };
  }
  return defaultPool.initPool();
}
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
