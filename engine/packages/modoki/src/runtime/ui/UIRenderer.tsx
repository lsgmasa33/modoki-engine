/** UIRenderer — renders ECS UI entities as DOM elements overlaid on the game viewport.
 *  Sets CSS custom properties (--ui-vw, --ui-vh, etc.) so viewport-relative units
 *  resolve relative to this container, not the browser window. */

import { useRef, useCallback, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useUIEntities } from './useUIEntities';
import { UINode } from './UINode';
import { markUIDirty } from './uiTreeStore';
import { onPlayStateChange } from '../systems/playState';
import { useFocusStore, consumePendingActivation } from './focusManager';
import { getCurrentWorld } from '../ecs/world';

interface UIRendererProps {
  /** Store state object for binding resolution (typically from useGameStore) */
  storeState?: Record<string, unknown>;
  /** Editor mode: click selects entity instead of triggering action */
  onSelectEntity?: (entityId: number) => void;
  /** Editor: render each Canvas2D node's 2D canvas inline in the tree (so 2D and
   *  UI stack by hierarchy). Returns null to hide the 2D layer. Omit in runtime. */
  renderCanvas2D?: (entityId: number) => ReactNode;
  /** Editor: render UI structure without visuals (2D-only layer toggle). */
  uiVisualsHidden?: boolean;
}

export function UIRenderer({ storeState = {}, onSelectEntity, renderCanvas2D, uiVisualsHidden }: UIRendererProps) {
  const tree = useUIEntities();
  const [vpVars, setVpVars] = useState<Record<string, string>>({});
  const roRef = useRef<ResizeObserver | null>(null);

  // Rebuild the UI tree on Play/Stop so a TextAnimation on a UIElement toggles its
  // CSS animation with play state (UINode applies it only while isSimRunning).
  useEffect(() => onPlayStateChange(() => markUIDirty()), []);

  // Drain a queued focus activation (a controller/keyboard "confirm"). uiFocusSystem
  // sets pendingActivateGuid inside the pipeline tick but CANNOT fire the bindings
  // there (applyBindings' `call` path throws in dev from a tick — bindings.ts F10);
  // this effect is a React/event context, so it runs the SAME applyBindings a tap
  // runs. Skipped in the editor's click-to-select mode (authoring, not gameplay).
  // consumePendingActivation is idempotent, so two mounted UIRenderers activate once.
  const pendingActivateGuid = useFocusStore((s) => s.pendingActivateGuid);
  useEffect(() => {
    if (!pendingActivateGuid || onSelectEntity) return;
    let world;
    try { world = getCurrentWorld(); } catch { return; }
    consumePendingActivation(world);
  }, [pendingActivateGuid, onSelectEntity]);

  // Measure the container and publish viewport custom properties (--ui-vw/vh/
  // vmin/vmax) so viewport-relative UI units resolve against THIS preview, not
  // the browser window. Done via a callback ref (not useEffect) because the
  // container is conditionally rendered: when `tree` is empty this component
  // returns null, so a `useEffect([])` would run with no element and never
  // re-run once the UI entities load and the div finally mounts — leaving the
  // vars unset and cssVal() falling back to the real-window `1vmin` (which is
  // only coincidentally correct on-device, and wildly wrong in editor previews
  // where the window != the simulated device). The callback ref fires exactly
  // when the div mounts/unmounts, so the observer is always wired to a live node.
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        const vw = w / 100;
        const vh = h / 100;
        setVpVars({
          '--ui-vw': `${vw}px`,
          '--ui-vh': `${vh}px`,
          '--ui-vmin': `${Math.min(vw, vh)}px`,
          '--ui-vmax': `${Math.max(vw, vh)}px`,
        });
      }
    };
    update(); // first paint: sync so vmin units resolve immediately
    // Observer updates are deferred to the next frame: measuring + setState
    // synchronously inside the RO callback can re-lay-out within the same RO
    // cycle, producing "ResizeObserver loop completed with undelivered
    // notifications". rAF moves the read past layout settle. (Same guard as
    // UIResizeOverlay.)
    let pending = false;
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; update(); });
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  if (tree.length === 0) return null;

  return (
    <div
      ref={measureRef}
      style={{
        position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', overflow: 'hidden',
        ...vpVars as any,
      }}
    >
      {tree.map(node => (
        <UINode key={node.entityId} node={node} storeState={storeState} onSelectEntity={onSelectEntity} renderCanvas2D={renderCanvas2D} uiVisualsHidden={uiVisualsHidden} />
      ))}
    </div>
  );
}
