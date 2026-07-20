/** Canvas2DMount — mounts a pooled PixiJS canvas element into a UINode div.
 *  Waits for the slot's Application to initialize, then mounts the canvas
 *  and attaches a ResizeObserver to keep pixel size in sync with DOM size. */

import { useRef, useEffect } from 'react';
import { defaultPool, type Canvas2DPool } from './canvas2DPool';
import { markScene2DDirty } from './Scene2D';
import { retrySizeUntilMeasured } from './canvas2DSizing';

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
}

export function Canvas2DMount({ entityId, pool = defaultPool, markDirty = markScene2DDirty, viewZoom = 1 }: Canvas2DMountProps) {
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
      const dpr = window.devicePixelRatio || 1;
      // rect is post-CSS-transform, so it already includes the editor zoom → backing = rect × dpr is
      // 1:1 with device pixels (crisp at any zoom). At an EXTREME editor zoom the backing could exceed
      // the GPU max-texture size (a Pixi Application fails to allocate above it), so cap the LONGER axis
      // and scale BOTH by the same factor — a UNIFORM downscale that preserves aspect (a per-axis clamp
      // would stretch the CSS-stretched canvas). 8192 is safe on desktop GPUs and above any realistic
      // runtime/GameView backing (dpr × screen), so the runtime is unaffected — only extreme zoom bites.
      const MAX_BACKING = 8192;
      let w = Math.round(rect.width * dpr);
      let h = Math.round(rect.height * dpr);
      const longest = Math.max(w, h);
      if (longest > MAX_BACKING) {
        const k = MAX_BACKING / longest;
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      return { w, h };
    }

    function applySize(w: number, h: number) {
      pool.resize(entityId, w, h);
      markDirty(); // a resize moves the scaler → wake the render gate (F1)
    }

    function updateSize() {
      const { w, h } = measure();
      if (w > 0 && h > 0) applySize(w, h);
    }
    // Expose to the viewZoom effect below: a CSS-transform zoom changes the ON-SCREEN size but NOT the
    // layout box, so the ResizeObserver never fires for it — we must re-measure explicitly on zoom.
    updateSizeRef.current = updateSize;

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
      if (slot.canvas.parentElement === el) {
        el.removeChild(slot.canvas);
      }
      updateSizeRef.current = null;
      pool.unmount(entityId); // drop the mount claim → slot reclaimed if sim isn't holding it
    };
  }, [entityId, pool, markDirty]);

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
