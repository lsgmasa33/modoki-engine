/** UIRenderer — renders ECS UI entities as DOM elements overlaid on the game viewport.
 *  Sets CSS custom properties (--ui-vw, --ui-vh, etc.) so viewport-relative units
 *  resolve relative to this container, not the browser window. */

import { useRef, useCallback, useState, useEffect } from 'react';
import { measureSafeAreaInsets } from './safeArea';
import type { ReactNode } from 'react';
import { useUIEntities } from './useUIEntities';
import { UINode } from './UINode';
import { markUIDirty, useUITreeStore } from './uiTreeStore';
import { onPlayStateChange } from '../core/playState';
import { useFocusStore, consumePendingActivation } from './focusManager';
import { getCurrentWorld } from '../core/ecs/world';
import { registerPointerBlocker } from '../core/pointerBlockers';
import { installPressOriginTracking } from './pressOrigin';
import { UI_ROOT_ATTR } from '../traits/TouchControl';

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
  // Scene-wide default DOM font (#803) — resolved once in the projection (uiTreeStore), not
  // here, so it's the same value every UI root inherits by CSS cascade, applied below to the
  // one container all roots share. '' when unset, so the container carries no fontFamily at
  // all and App.css's body rule (or any ambient default) still wins.
  const rootFontFamily = useUITreeStore(s => s.rootFontFamily);
  const [vpVars, setVpVars] = useState<Record<string, string>>({});
  const roRef = useRef<ResizeObserver | null>(null);
  /** The queued `update()` frame, so the callback ref's cleanup can CANCEL it rather than let it
   *  run against a container it has already torn down — see the note at the observer below. */
  const frameRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

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
  // Claims this root as a pointer-block root (`core/pointerBlockers.ts`) so a tap on
  // a UI element never also reaches the game underneath — see `pointerSource.ts`'s
  // "POINTER-BLOCK ROOTS" section. Runtime mode ONLY (`!onSelectEntity`): the editor
  // mounts this SAME UI tree a second time inside SceneView's authoring preview
  // (`onSelectEntity` set), and a click there manipulates gizmos/selection, not the
  // running game — it must never claim the pointer out from under the actual
  // GameView instance. `onSelectEntity`'s presence is a structural property of which
  // viewport mounted this component, not a per-render toggle, so closing over it
  // inside this ref (recreated only when it changes) is safe.
  const unblockRef = useRef<(() => void) | null>(null);
  // #664 — tracks which element a press/release pair started/ended on (see pressOrigin.ts), so
  // UINode's click handler can refuse a click the browser resolved to an ancestor a swipe merely
  // passed through. Same runtime-only gating as unblockRef, and disposed alongside it.
  const pressOriginRef = useRef<(() => void) | null>(null);

  const measureRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    unblockRef.current?.();
    unblockRef.current = null;
    pressOriginRef.current?.();
    pressOriginRef.current = null;
    if (!el) return;
    if (!onSelectEntity) unblockRef.current = registerPointerBlocker(el);
    if (!onSelectEntity) pressOriginRef.current = installPressOriginTracking(el.ownerDocument);
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
      // Safe-area insets for GAME CODE (`runtime/ui/safeArea.ts`) — REGISTERED from here, so the
      // measurement happens inside THIS container's cascade and reads the editor preview's
      // simulated inset and the device's real `env()` through one path.
      //
      // ⚠️ This call is the registration, NOT the whole freshness story, and the comment that
      // used to sit here said it was — "every event that can change an inset already resizes this
      // container". That is false, and it is the single belief that cost four issues (#273 → #579
      // → #592 → #600): under `setDecorFitsSystemWindows(false)` an Android window keeps its size
      // when the system bars hide, so the insets move and this observer never fires. Measured on a
      // Galaxy A23: bottom 0→48 with zero `resize` events. `safeArea.ts` now owns its own observer
      // on probes SIZED by the inset, which is what actually catches that case (#612).
      //
      // Outside the w/h > 0 guard on purpose: a container can be measurable for insets before it
      // has a non-zero box, and a stale inset is worse than an early-but-correct one.
      measureSafeAreaInsets(el);
    };
    update(); // first paint: sync so vmin units resolve immediately
    // Observer updates are deferred to the next frame: measuring + setState
    // synchronously inside the RO callback can re-lay-out within the same RO
    // cycle, producing "ResizeObserver loop completed with undelivered
    // notifications". rAF moves the read past layout settle. (Same guard as
    // UIResizeOverlay.)
    let pending = false;
    // ⚠️ The queued frame is CANCELLED by this ref's cleanup (`frameRef`, above), not merely left
    // to run against a disconnected observer. It re-enters `update()`, which registers this
    // container with `safeArea.ts`; an unmount in the same frame as the mount (a scene swap's
    // empty-tree beat, an editor panel closing mid-resize) would otherwise register a node that is
    // already detached, and in the editor's two-viewport case that late registration steals the
    // LIVE viewport's probes. `safeArea.ts` refuses a detached node defensively too — this stops
    // one being sent at all.
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      frameRef.current = requestAnimationFrame(() => {
        pending = false;
        frameRef.current = null;
        update();
      });
    });
    ro.observe(el);
    roRef.current = ro;
    // onSelectEntity is intentionally omitted below: it's fixed for this component
    // instance's whole lifetime (see the comment above this callback), so closing
    // over its mount-time value is deliberate, not a staleness bug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (tree.length === 0) return null;

  return (
    <div
      ref={measureRef}
      // Which UI tree this is. The editor mounts a SECOND copy inside SceneView's authoring
      // preview, where a press means "select this entity" — `input/touchControlSource.ts`
      // refuses any control that is not inside a `runtime` root, so an on-screen d-pad in the
      // Scene panel cannot drive the game. Keyed on the same `!onSelectEntity` structural
      // property as the pointer-block registration above, for the same reason.
      {...{ [UI_ROOT_ATTR]: onSelectEntity ? 'editor' : 'runtime' }}
      style={{
        position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', overflow: 'hidden',
        // Every UI root mounted below is a SIBLING inside this one div (there is no single
        // "top" element UI roots nest under), so this is the ONE place a scene-wide font
        // reaches all of them — by ordinary CSS inheritance. A per-element
        // UIElement.fontFamily still wins over this for that element by cascade (#803).
        // Omitted entirely (not `fontFamily: ''`) when unset, so an empty string can't
        // override an ambient default (e.g. App.css's body rule) with nothing.
        ...(rootFontFamily ? { fontFamily: rootFontFamily } : {}),
        ...vpVars as any,
      }}
    >
      {/* The scene-wide default IS what a root inherits — there is no ancestor above it but this
          container. Deliberately NOT `node.fontFamily || rootFontFamily` like the recursion sites
          (#803): there the expression runs on the PARENT and is handed to the child, so it means
          "the font my child inherits"; here it would run on the node receiving it and hand a root
          its OWN font as its inherited one. Identical today — the only consumer reads the prop in
          an `else` after `if (node.fontFamily)` — and wrong the moment a second consumer reads it
          above that branch. */}
      {tree.map(node => (
        <UINode key={node.entityId} node={node} storeState={storeState} onSelectEntity={onSelectEntity} renderCanvas2D={renderCanvas2D} uiVisualsHidden={uiVisualsHidden} inheritedFontFamily={rootFontFamily} />
      ))}
    </div>
  );
}
