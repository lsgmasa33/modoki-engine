/** Canvas2DMount — mounts a pooled PixiJS canvas element into a UINode div.
 *  Waits for the slot's Application to initialize, then mounts the canvas
 *  and attaches a ResizeObserver to keep pixel size in sync with DOM size. */

import { useRef, useEffect } from 'react';
import { defaultPool, type Canvas2DPool } from './canvas2DPool';
import { markScene2DDirty } from './Scene2D';
import { retrySizeUntilMeasured, computeBackingSize } from './canvas2DSizing';
import { getRenderSettings, getEffectivePixiSettings } from './renderSettings';
import { onForceResize } from './resizeBus';

interface Canvas2DMountProps {
  entityId: number;
  /** The pool this canvas comes from. Default = the runtime `defaultPool` (GameView / shipped
   *  game). The editor SceneView passes its OWN Canvas2DPool so its 2D surface doesn't collide
   *  with GameView's slots (they render the same entity through different cameras). */
  pool?: Canvas2DPool;
  /** Wake the render gate on resize. Default = the runtime `markScene2DDirty` (dirties the default
   *  renderer). The editor passes its own renderer's `markDirty` so a resize dirties ITS surface. */
  markDirty?: () => void;
  /** Extra backing-resolution multiplier (editor viewport zoom). The editor magnifies the 2D surface
   *  with a CSS transform; `getBoundingClientRect` already reflects that, so backing = rect × dpr is
   *  crisp on its own. This is a safety CAP knob: we clamp the effective supersample so an extreme
   *  zoom can't blow past the GPU max-texture size. Default 1 (runtime GameView — no zoom). */
  viewZoom?: number;
  /** Honor `rendering.web.sizeMode` (the `max` buffer clamp), matching Scene3D. OPT-IN and
   *  default false because this component backs BOTH the shipped-game/GameView surface (which
   *  must honour it) AND the editor SceneView viewport (which must not — it sizes itself / uses
   *  device presets). Defaulting off means a new call site can never accidentally shrink the
   *  editor viewport by inheriting a game's `max` config. */
  applyWebSizeMode?: boolean;
}

export function Canvas2DMount({ entityId, pool = defaultPool, markDirty = markScene2DDirty, viewZoom = 1, applyWebSizeMode = false }: Canvas2DMountProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const updateSizeRef = useRef<(() => void) | null>(null);
  // Re-measure the backing when the editor viewport zoom changes (the ResizeObserver can't see a
  // CSS-transform scale). No-op in the runtime GameView, where viewZoom stays 1.
  useEffect(() => { updateSizeRef.current?.(); }, [viewZoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Take the MOUNT claim (not a bare allocate): the pool keeps this slot alive
    // while the canvas is in the DOM, and unmount() below reclaims it. Without the
    // paired claim, mount/unmount churn leaked slots until the pool exhausted (F5).
    const slot = pool.mount(entityId);
    if (!slot) return; // pool at capacity

    let cancelled = false;

    function measure() {
      const rect = el!.getBoundingClientRect();
      // computeBackingSize handles: rect × dpr (capped at pixi.pixelRatioCap on the auto
      // path — every 2D surface, editor viewport included; a pinned pixi.resolution is
      // never capped), the `max` sizeMode buffer clamp (only when applyWebSizeMode —
      // excludes the editor viewport), and the GPU max-texture longer-axis cap. See
      // canvas2DSizing.ts for the full mechanics.
      //
      // ⚠️ `pixelRatioCap` comes from getEffectivePixiSettings() — the TIER-ADJUSTED value (#202)
      // — while `resolution` comes from the raw settings, because a pinned resolution is
      // deliberately not tiered (capping an explicit pin would make the pin a lie). This function
      // re-reads on every run and is registered on the resize bus below, which is what makes a
      // live tier change reach the backing buffer with no diffing anywhere.
      const pixi = getEffectivePixiSettings();
      return computeBackingSize({
        rectWidth: rect.width,
        rectHeight: rect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        resolution: getRenderSettings().pixi.resolution,
        pixelRatioCap: pixi.pixelRatioCap,
        web: applyWebSizeMode ? getRenderSettings().web : null,
      });
    }

    function applySize(w: number, h: number) {
      // Resize the slot we HOLD, never a fresh lookup by entityId (#213). This component owns
      // `slot` — it is the canvas we appended to the DOM — and `pool.resize(entityId, …)` silently
      // did nothing whenever that entity had been reclaimed out of `entityMap` while its canvas was
      // still mounted. The result was a canvas pinned at 1x1 forever with no error and no warning:
      // the retry below counts the call as applied and stops, and every later ResizeObserver fire
      // no-ops identically. Measured live on an iPhone 8, where the slower async `app.init()` makes
      // the reclaim window easy to hit; the same build was fine on an iPad and on desktop.
      if (slot) pool.resizeSlot(slot, w, h);
      markDirty(); // a resize moves the scaler → wake the render gate (F1)

      // ⚠️ VERIFY THE RESIZE LANDED. Applying a size and having the canvas ignore it is a REAL
      // shipped failure (#213: a 1x1 buffer stretched over a full-size box on an iPhone 8, while
      // the same build was fine on iPad and desktop), and it is invisible from every other angle —
      // the retry counts the call as applied and stops, so its own 0x0 warning never fires, no
      // error is thrown, the DOM chain measures correctly and the WebGL2 context is live. The only
      // observable is the one thing nobody checked: the canvas did not change size.
      // Cheap (two property reads on a path that runs on mount + real resizes, not per frame).
      if (slot && slot.canvas.width <= 1 && w > 1) {
        console.error(
          `[Canvas2DMount] entity ${entityId}: applied ${w}x${h} but the canvas is still ` +
          `${slot.canvas.width}x${slot.canvas.height} — this surface will render a 1px buffer ` +
          `stretched over its box. initialized=${slot.initialized} mounted=${slot.mounted} ` +
          `boundBySim=${slot.boundBySim} slotEntity=${slot.entityId} (see #213).`,
        );
      }
    }

    function updateSize() {
      const { w, h } = measure();
      if (w > 0 && h > 0) applySize(w, h);
    }
    // Expose to the viewZoom effect below: a CSS-transform zoom changes the ON-SCREEN size but NOT the
    // layout box, so the ResizeObserver never fires for it — we must re-measure explicitly on zoom.
    updateSizeRef.current = updateSize;
    // Let the debug menu's Device tab force a re-measure (e.g. after flipping pixelRatioCap
    // live) without waiting on a DOM resize. See resizeBus.ts.
    const unregisterForceResize = onForceResize(updateSize);

    function mount() {
      if (cancelled || !el) return;

      el.appendChild(slot!.canvas);
      slot!.canvas.style.width = '100%';
      slot!.canvas.style.height = '100%';
      slot!.canvas.style.display = 'block';

      // Initial sizing with a bounded per-frame retry: a 0×0 box at mount (mid-layout /
      // enter transition) would otherwise leave the slot at 1×1 and renderAll would skip
      // it until the ResizeObserver happened to fire. The retry sizes it as soon as the
      // box is real, and warns if it stays 0×0 (hidden/detached ancestor) — F10.
      cancelRetry = retrySizeUntilMeasured({
        measure,
        applySize,
        scheduleFrame: (cb) => requestAnimationFrame(cb),
        cancelFrame: (h) => cancelAnimationFrame(h),
        warn: (frames) => console.warn(
          `[Canvas2DMount] entity ${entityId}: canvas still 0×0 after ${frames} frames — ` +
          `a display:none/detached ancestor? It won't render until it has a non-zero box.`,
        ),
      });
      // Ongoing changes (rotation, layout reflow) are handled by the observer.
      ro = new ResizeObserver(updateSize);
      ro.observe(el);
    }

    let ro: ResizeObserver | null = null;
    let cancelRetry: (() => void) | null = null;

    if (slot.initialized) {
      mount();
    } else {
      // Wait for Application init, then mount
      slot.ready.then(() => {
        if (!cancelled) mount();
      });
    }

    return () => {
      cancelled = true;
      if (cancelRetry) cancelRetry(); // stop any pending size retry (F10)
      if (ro) ro.disconnect();
      unregisterForceResize();
      if (slot.canvas.parentElement === el) {
        el.removeChild(slot.canvas);
      }
      updateSizeRef.current = null;
      pool.unmount(entityId); // drop the mount claim → slot reclaimed if sim isn't holding it
    };
  }, [entityId, pool, markDirty, applyWebSizeMode]);

  return (
    <div
      ref={containerRef}
      // data-canvas2d-mount: lets the editor's pickUnderlyingUIEntity temporarily neutralize this
      // pointerEvents:'auto' surface (alongside the Pixi pick overlay) so an empty 2D-miss click
      // falls through to the real UI/Three.js underneath instead of hitting the Canvas2D wrapper.
      data-canvas2d-mount
      style={{ width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'auto' }}
    />
  );
}
