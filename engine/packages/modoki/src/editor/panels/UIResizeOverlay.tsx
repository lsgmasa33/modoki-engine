/** UIResizeOverlay — resize handles for UI entities in SceneView UI mode.
 *  Renders as DOM overlay (not Canvas) since UI entities are already DOM elements. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { findEntity } from '../../runtime/ecs/entityUtils';
import { getAllTraits } from '../../runtime/ecs/traitRegistry';
import { markUIDirty, onEditorDirty, useUITreeStore } from '../../runtime/ui/uiTreeStore';
import { pushAction } from '../undo/undoManager';
import { entityRef } from '../undo/entityRef';
import { notifyFieldEdited } from '../animation/recording';
import { useEditorStore } from '../store/editorStore';
import { anchorRefPoint, anchorDragAxes, computeMoveOffsets, computeResize, frameToLogicalRect } from '../scene/uiResizeMath';
import { resolveLengthPx } from '../../runtime/ui/anchorLayout';
import { registerHandleProvider, type InteractionHandle } from '../../runtime/rendering/interactionHandles';

export type UIResizeHandle =
  | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br'
  | 'resize-t' | 'resize-r' | 'resize-b' | 'resize-l'
  | 'move-x' | 'move-y' | 'move-free';

const HANDLE_SIZE = 8;

// Trait-meta lookups are by-name linear scans of the registry, which is stable
// after editor init. Cache the resolved meta per name so the overlay's per-render
// / per-drag-frame reads don't re-scan `getAllTraits()` every time. Only cache on
// a HIT, so a lookup before the trait is registered doesn't poison the cache. (F4)
const _metaCache = new Map<string, ReturnType<typeof getAllTraits>[number]>();
function traitMeta(name: string) {
  const cached = _metaCache.get(name);
  if (cached) return cached;
  const meta = getAllTraits().find(m => m.name === name);
  if (meta) _metaCache.set(name, meta);
  return meta;
}

interface HandleDef {
  id: UIResizeHandle;
  /** Position as fraction of rect: [0,0]=top-left, [1,1]=bottom-right */
  fx: number;
  fy: number;
  cursor: string;
}

const HANDLES: HandleDef[] = [
  { id: 'resize-tl', fx: 0, fy: 0, cursor: 'nwse-resize' },
  { id: 'resize-t',  fx: 0.5, fy: 0, cursor: 'ns-resize' },
  { id: 'resize-tr', fx: 1, fy: 0, cursor: 'nesw-resize' },
  { id: 'resize-r',  fx: 1, fy: 0.5, cursor: 'ew-resize' },
  { id: 'resize-br', fx: 1, fy: 1, cursor: 'nwse-resize' },
  { id: 'resize-b',  fx: 0.5, fy: 1, cursor: 'ns-resize' },
  { id: 'resize-bl', fx: 0, fy: 1, cursor: 'nesw-resize' },
  { id: 'resize-l',  fx: 0, fy: 0.5, cursor: 'ew-resize' },
];

interface DragState {
  handle: UIResizeHandle;
  entityId: number;
  startPointer: { x: number; y: number };
  startValues: { width: number; height: number; widthUnit: string; heightUnit: string };
  /** Computed rect size at drag start (for auto-sized elements) */
  computedSize: { width: number; height: number };
  /** Parent element's computed size (for % mode delta conversion) */
  parentComputedSize: { width: number; height: number };
  /** Anchor offsets at drag start (for move handles) */
  startAnchor?: { top: number; topUnit: string; left: number; leftUnit: string; right: number; rightUnit: string; bottom: number; bottomUnit: string; anchor: string };
}

/** Read current UIElement width/height/units + margins from ECS */
function readUIElement(entityId: number): {
  width: number; height: number; widthUnit: string; heightUnit: string;
  marginTop: number; marginRight: number; marginBottom: number; marginLeft: number;
  marginTopUnit: string; marginRightUnit: string; marginBottomUnit: string; marginLeftUnit: string;
} | null {
  const uiElMeta = traitMeta('UIElement');
  if (!uiElMeta) return null;
  const entity = findEntity(entityId);
  if (!entity || !entity.has(uiElMeta.trait)) return null;
  const data = entity.get(uiElMeta.trait) as any;
  return {
    width: data.width, height: data.height,
    widthUnit: data.widthUnit || 'px', heightUnit: data.heightUnit || 'px',
    marginTop: data.marginTop || 0, marginRight: data.marginRight || 0,
    marginBottom: data.marginBottom || 0, marginLeft: data.marginLeft || 0,
    marginTopUnit: data.marginTopUnit || 'px', marginRightUnit: data.marginRightUnit || 'px',
    marginBottomUnit: data.marginBottomUnit || 'px', marginLeftUnit: data.marginLeftUnit || 'px',
  };
}

/** Write UIElement width/height to ECS */
function writeUIElement(entityId: number, values: { width?: number; height?: number; widthUnit?: string; heightUnit?: string }) {
  const uiElMeta = traitMeta('UIElement');
  if (!uiElMeta) return;
  const entity = findEntity(entityId);
  if (!entity || !entity.has(uiElMeta.trait)) return;
  const current = entity.get(uiElMeta.trait) as any;
  entity.set(uiElMeta.trait, { ...current, ...values });
  markUIDirty();
}

/** Read UIAnchor data from ECS */
function readUIAnchor(entityId: number): {
  anchor: string; pivotX: number; pivotY: number;
  top: number; topUnit: string; left: number; leftUnit: string;
  right: number; rightUnit: string; bottom: number; bottomUnit: string;
} | null {
  const anchorMeta = traitMeta('UIAnchor');
  if (!anchorMeta) return null;
  const entity = findEntity(entityId);
  if (!entity || !entity.has(anchorMeta.trait)) return null;
  const data = entity.get(anchorMeta.trait) as any;
  return {
    anchor: data.anchor || 'stretch', pivotX: data.pivotX || 0, pivotY: data.pivotY || 0,
    top: data.top || 0, topUnit: data.topUnit || 'px', left: data.left || 0, leftUnit: data.leftUnit || 'px',
    right: data.right || 0, rightUnit: data.rightUnit || 'px', bottom: data.bottom || 0, bottomUnit: data.bottomUnit || 'px',
  };
}

/** Write UIAnchor offset fields to ECS */
function writeUIAnchor(entityId: number, values: { top?: number; left?: number; right?: number; bottom?: number }) {
  const anchorMeta = traitMeta('UIAnchor');
  if (!anchorMeta) return;
  const entity = findEntity(entityId);
  if (!entity || !entity.has(anchorMeta.trait)) return;
  const current = entity.get(anchorMeta.trait) as any;
  entity.set(anchorMeta.trait, { ...current, ...values });
  markUIDirty();
}

/** Read parent entity ID from EntityAttributes */
function readParentId(entityId: number): number {
  const attrMeta = traitMeta('EntityAttributes');
  if (!attrMeta) return 0;
  const entity = findEntity(entityId);
  if (!entity || !entity.has(attrMeta.trait)) return 0;
  return (entity.get(attrMeta.trait) as any).parentId || 0;
}

// anchorRefPoint / anchorDragAxes + the resize/move arithmetic live in the pure,
// DOM-free `editor/scene/uiResizeMath.ts` (imported above) so they can be unit-tested.

interface MarginBox { top: number; right: number; bottom: number; left: number }

interface OverlayState {
  rect: { top: number; left: number; width: number; height: number };
  parentRect: { top: number; left: number; width: number; height: number } | null;
  anchorData: { anchor: string; pivotX: number; pivotY: number } | null;
  margin: MarginBox;
  /** width/height === 0 means "auto" (content-sized) — the corresponding resize
   *  handles are disabled. Computed in update() from the SAME UIElement read used
   *  for margins, so the render body doesn't re-read ECS. (F4) */
  autoWidth: boolean;
  autoHeight: boolean;
}

export function UIResizeOverlay({ entityId }: { entityId: number }) {
  const [state, setState] = useState<OverlayState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const gameViewSize = useEditorStore(s => s.gameViewSize);

  // ── Enact: expose the 8 resize handles as interaction handles (viewport CSS px). The
  // overlay divs live in the frame's INTERNAL logical space (scaled on screen), but a
  // handle at fraction (fx,fy) of the entity's logical rect maps on screen to the SAME
  // fraction of the entity's on-screen rect — fractions are scale-invariant. So we read
  // the entity element's live getBoundingClientRect (already viewport px, borders folded
  // in) and place handles at er.left+er.width·fx / er.top+er.height·fy. This component is
  // only mounted for the selected UI entity in UI mode, so registration is self-gated;
  // return [] when the frame/element isn't in the DOM. entityId in deps → re-register on
  // selection change.
  useEffect(() => {
    const unreg = registerHandleProvider((): InteractionHandle[] => {
      const frame = document.querySelector('[data-ui-preview-frame]') as HTMLElement | null;
      if (!frame) return [];
      const el = frame.querySelector(`[data-entity-id="${entityId}"]`) as HTMLElement | null;
      if (!el) return [];
      const er = el.getBoundingClientRect();
      if (!er.width || !er.height) return [];
      const uiEl = readUIElement(entityId);
      const autoWidth = uiEl ? uiEl.width === 0 : false;
      const autoHeight = uiEl ? uiEl.height === 0 : false;
      return HANDLES.map((h) => {
        // A handle on an auto-sized axis is drawn disabled (drag is a no-op there).
        const onXAxis = h.fx !== 0.5, onYAxis = h.fy !== 0.5;
        const disabled = (onXAxis && autoWidth) || (onYAxis && autoHeight);
        return {
          id: `ui:${h.id}`,
          kind: 'resize-handle',
          editor: 'ui-resize',
          x: er.left + er.width * h.fx,
          y: er.top + er.height * h.fy,
          label: h.id,
          meta: { entityId, handle: h.id, fx: h.fx, fy: h.fy, disabled },
        };
      });
    });
    return unreg;
  }, [entityId]);
  // Subscribe to the UI tree so the gizmo re-measures AFTER React commits the
  // updated UIRenderer DOM. onEditorDirty fires synchronously during the ECS
  // write — before React's render, so getBoundingClientRect would otherwise
  // read stale rects when a UI field value changes.
  const tree = useUITreeStore(s => s.tree);

  // Update element + parent position on ECS writes, resize, and panel resize
  useEffect(() => {
    const update = () => {
      const frame = document.querySelector('[data-ui-preview-frame]') as HTMLElement | null;
      if (!frame) { setState(null); return; }
      const el = frame.querySelector(`[data-entity-id="${entityId}"]`) as HTMLElement | null;
      if (!el) { setState(null); return; }
      const fr = frame.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      // Convert the measured on-screen rect to the frame's INTERNAL logical coords —
      // the space this overlay renders in. The scale is the frame's REAL on-screen
      // scale (fr.width / current device width), NOT the editor viewZoom (which does
      // not scale the UI preview). See frameToLogicalRect for the two regressions
      // this guards (device-preset letterbox + stale device width on switch).
      const z = fr.width > 0 && gameViewSize.width > 0 ? fr.width / gameViewSize.width : 1;
      const rect = frameToLogicalRect(er, fr, gameViewSize.width);

      // Parent rect
      let parentRect: OverlayState['parentRect'] = null;
      const parentId = readParentId(entityId);
      if (parentId) {
        const parentEl = frame.querySelector(`[data-entity-id="${parentId}"]`) as HTMLElement | null;
        if (parentEl) {
          parentRect = frameToLogicalRect(parentEl.getBoundingClientRect(), fr, gameViewSize.width);
        }
      }

      // Read margins from ECS (not getComputedStyle — anchored elements fold
      // margin into position offsets, so CSS margin is 0).
      // Convert game pixels → overlay CSS pixels.
      const uiEl = readUIElement(entityId);
      const frRect = fr;
      const gameToOverlayX = (frRect.width / z) / gameViewSize.width;
      const gameToOverlayY = (frRect.height / z) / gameViewSize.height;
      // Resolve each margin to LOGICAL game px (px/%/vw/vh/vmin/vmax, device-logical
      // viewport) then scale to overlay px. % is against the device axis (matches the
      // prior behavior); viewport units use gameViewSize.
      const vpW = gameViewSize.width, vpH = gameViewSize.height;
      const margin: MarginBox = uiEl ? {
        top: resolveLengthPx(uiEl.marginTop, uiEl.marginTopUnit, vpH, vpW, vpH) * gameToOverlayY,
        right: resolveLengthPx(uiEl.marginRight, uiEl.marginRightUnit, vpW, vpW, vpH) * gameToOverlayX,
        bottom: resolveLengthPx(uiEl.marginBottom, uiEl.marginBottomUnit, vpH, vpW, vpH) * gameToOverlayY,
        left: resolveLengthPx(uiEl.marginLeft, uiEl.marginLeftUnit, vpW, vpW, vpH) * gameToOverlayX,
      } : { top: 0, right: 0, bottom: 0, left: 0 };

      const anchorData = readUIAnchor(entityId);
      setState({
        rect, parentRect, anchorData, margin,
        autoWidth: uiEl ? uiEl.width === 0 : false,
        autoHeight: uiEl ? uiEl.height === 0 : false,
      });
    };
    update();

    // 1. ECS writes — defer to rAF so React has a chance to commit the new
    //    UIRenderer DOM before we read getBoundingClientRect. onEditorDirty
    //    itself fires synchronously during the write; reading rects there
    //    would observe stale layout.
    let pending = false;
    const scheduleUpdate = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; update(); });
    };
    const unsubDirty = onEditorDirty(scheduleUpdate);

    // 2. SceneView panel resize / device-preset change. Defer via scheduleUpdate
    //    (rAF): measuring + setState synchronously inside the observer callback
    //    re-lays-out within the same RO cycle → "ResizeObserver loop completed with
    //    undelivered notifications". rAF moves the read to the next frame, after
    //    layout settles, breaking the loop.
    const frame = document.querySelector('[data-ui-preview-frame]') as HTMLElement | null;
    const ro = frame ? new ResizeObserver(scheduleUpdate) : null;
    if (ro && frame) ro.observe(frame);

    // 3. Window resize
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      unsubDirty();
      ro?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
    };
    // `tree` dep: re-run update() after React commits a new UIRenderer pass
    // so the gizmo re-measures with the fresh DOM rects.
    // `gameViewSize` dep: update() closes over it (for the z = frame/device scale
    // and the margin math). Changing the device preset updates gameViewSize and
    // resizes the frame, but without this dep the stale closure (and the
    // ResizeObserver firing the OLD update) would compute z against the previous
    // device → the overlay broke on every device switch AFTER the first select.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, tree, gameViewSize]);

  /** Convert screen-pixel delta to logical game pixels */
  const toLogicalDelta = useCallback((screenDx: number, screenDy: number) => {
    const frame = document.querySelector('[data-ui-preview-frame]') as HTMLElement | null;
    if (!frame) return { dx: screenDx, dy: screenDy };
    const frameRect = frame.getBoundingClientRect();
    const scaleX = gameViewSize.width / frameRect.width;
    const scaleY = gameViewSize.height / frameRect.height;
    return { dx: screenDx * scaleX, dy: screenDy * scaleY };
  }, [gameViewSize]);

  // The active drag's window-level listeners (see handlePointerDown). Kept in a ref so
  // an unmount mid-drag can detach them.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, handle: UIResizeHandle) => {
    e.stopPropagation();
    e.preventDefault();
    const values = readUIElement(entityId);
    if (!values) return;

    // Get computed size for auto-sized elements
    const frame = document.querySelector('[data-ui-preview-frame]') as HTMLElement | null;
    const el = frame?.querySelector(`[data-entity-id="${entityId}"]`) as HTMLElement | null;
    let computedSize = { width: values.width, height: values.height };
    let parentComputedSize = { width: gameViewSize.width, height: gameViewSize.height };
    if (el && frame) {
      const fr = frame.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const scaleX = gameViewSize.width / fr.width;
      const scaleY = gameViewSize.height / fr.height;
      computedSize = {
        width: Math.round(er.width * scaleX),
        height: Math.round(er.height * scaleY),
      };
      // Find parent entity element for % mode
      const parentEl = el.parentElement?.closest('[data-entity-id]') as HTMLElement | null;
      if (parentEl) {
        const pr = parentEl.getBoundingClientRect();
        parentComputedSize = {
          width: Math.round(pr.width * scaleX),
          height: Math.round(pr.height * scaleY),
        };
      }
    }

    const anchorValues = readUIAnchor(entityId);
    dragRef.current = {
      handle,
      entityId,
      startPointer: { x: e.clientX, y: e.clientY },
      startValues: { ...values },
      computedSize,
      parentComputedSize,
      startAnchor: anchorValues ? {
        anchor: anchorValues.anchor,
        top: anchorValues.top, topUnit: anchorValues.topUnit,
        left: anchorValues.left, leftUnit: anchorValues.leftUnit,
        right: anchorValues.right, rightUnit: anchorValues.rightUnit,
        bottom: anchorValues.bottom, bottomUnit: anchorValues.bottomUnit,
      } : undefined,
    };
    // Drive the drag from WINDOW listeners, not the handle div's own pointer events:
    // each resize step re-measures the overlay, which can transiently unmount the
    // handle div (state→null in update()) and drop its pointer capture — so the div
    // stopped receiving `pointerup`, and the undo entry (pushed in finishDrag) was
    // never recorded under a trusted/synthetic drag. Window listeners always fire.
    const onWinMove = (ev: PointerEvent) => applyDrag(ev.clientX, ev.clientY);
    const onWinUp = () => { dragCleanupRef.current?.(); finishDrag(); };
    const cleanup = () => {
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, gameViewSize]);

  // Detach any live drag listeners if the overlay unmounts mid-gesture.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // Apply an in-progress drag at the given viewport-CSS-px pointer position. Reads the
  // frozen start state from dragRef so it's re-render-safe; called from window pointermove.
  const applyDrag = useCallback((clientX: number, clientY: number) => {
    const dr = dragRef.current;
    if (!dr) return;
    const { handle, startPointer, startValues, computedSize, parentComputedSize, startAnchor, entityId: eid } = dr;
    const { dx, dy } = toLogicalDelta(clientX - startPointer.x, clientY - startPointer.y);

    // viewport (vw/vh/vmin/vmax) units convert against the LOGICAL device size.
    const viewport = { width: gameViewSize.width, height: gameViewSize.height };

    // ── Move handles (reposition via UIAnchor offsets) ──
    if (handle.startsWith('move-') && startAnchor) {
      writeUIAnchor(eid, computeMoveOffsets(handle, startAnchor, dx, dy, parentComputedSize, viewport));
      return;
    }

    // ── Resize handles ──
    writeUIElement(eid, computeResize(handle, startValues, computedSize, parentComputedSize, dx, dy, viewport));
  }, [toLogicalDelta, gameViewSize]);

  // Finalize the drag: push the undo entry + bridge to the animation record hook. Called
  // from the window pointerup (so it runs even if the handle div unmounted mid-drag).
  const finishDrag = useCallback(() => {
    const dr = dragRef.current;
    if (!dr) return;
    const { handle, startValues, startAnchor, entityId } = dr;

    if (handle.startsWith('move-') && startAnchor) {
      // Undo for move — save all four offset fields
      const currentAnchor = readUIAnchor(entityId);
      if (currentAnchor) {
        const before = { top: startAnchor.top, left: startAnchor.left, right: startAnchor.right, bottom: startAnchor.bottom };
        const after = { top: currentAnchor.top, left: currentAnchor.left, right: currentAnchor.right, bottom: currentAnchor.bottom };
        const entity = findEntity(entityId);
        const name = entity?.name || `Entity ${entityId}`;
        const ref = entityRef(entityId);
        pushAction({
          label: `Move UI "${name}"`,
          undo: () => { const id = ref.resolve(); if (id != null) writeUIAnchor(id, before); },
          redo: () => { const id = ref.resolve(); if (id != null) writeUIAnchor(id, after); },
        });
        // Record mode: the drag writes UIAnchor via direct entity.set, which
        // bypasses writeTraitField → the animation record hook never sees it.
        // Notify it for the offset fields that actually moved (no-op when not
        // recording) so dragging keys the clip at the playhead.
        for (const k of Object.keys(after) as (keyof typeof after)[]) {
          if (!Object.is(before[k], after[k])) notifyFieldEdited(entityId, 'UIAnchor', k, after[k]);
        }
      }
    } else {
      // Undo for resize
      const current = readUIElement(entityId);
      if (current) {
        const before = { ...startValues };
        const after = { ...current };
        const entity = findEntity(entityId);
        const name = entity?.name || `Entity ${entityId}`;
        const ref = entityRef(entityId);
        pushAction({
          label: `Resize UI "${name}"`,
          undo: () => { const id = ref.resolve(); if (id != null) writeUIElement(id, before); },
          redo: () => { const id = ref.resolve(); if (id != null) writeUIElement(id, after); },
        });
        // Record mode: bridge the resize to the animation record hook for the
        // dimensions that changed (see the move branch above).
        for (const k of ['width', 'height'] as const) {
          if (!Object.is(before[k], after[k])) notifyFieldEdited(entityId, 'UIElement', k, after[k]);
        }
      }
    }
    dragRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return null;
  const { rect, parentRect, anchorData, margin, autoWidth: isAutoWidth, autoHeight: isAutoHeight } = state;
  const hasMargin = margin.top || margin.right || margin.bottom || margin.left;

  // Pivot position on the element (fraction → pixel offset within rect)
  const pivotX = anchorData?.pivotX ?? 0;
  const pivotY = anchorData?.pivotY ?? 0;
  const pivotPxLeft = rect.left + rect.width * pivotX;
  const pivotPxTop = rect.top + rect.height * pivotY;

  // Parent anchor reference point
  const anchorRef = anchorData ? anchorRefPoint(anchorData.anchor) : null;

  // Drag arrows for repositioning anchored elements
  const dragAxes = anchorData ? anchorDragAxes(anchorData.anchor) : { h: false, v: false };
  const showDragArrows = dragAxes.h || dragAxes.v;
  const ARROW_LEN = 40;
  const ARROW_W = 18;
  const arrowCx = rect.left + rect.width * pivotX;
  const arrowCy = rect.top + rect.height * pivotY;

  return (
    <>
      {/* Parent highlight (orange outline) */}
      {parentRect && <div style={{
        position: 'absolute',
        top: parentRect.top, left: parentRect.left,
        width: parentRect.width, height: parentRect.height,
        border: '1.5px solid #f39c12',
        pointerEvents: 'none',
        zIndex: 4,
        borderRadius: 2,
      }} />}
      {/* Parent anchor reference point (orange diamond) */}
      {parentRect && anchorRef && <div style={{
        position: 'absolute',
        left: parentRect.left + parentRect.width * anchorRef.fx - 5,
        top: parentRect.top + parentRect.height * anchorRef.fy - 5,
        width: 10, height: 10,
        backgroundColor: '#f39c12',
        transform: 'rotate(45deg)',
        pointerEvents: 'none',
        zIndex: 7,
      }} />}
      {/* Selection outline */}
      <div data-testid="ui-resize-selection" style={{
        position: 'absolute',
        top: rect.top, left: rect.left, width: rect.width, height: rect.height,
        border: '2px solid #3498db',
        pointerEvents: 'none',
        zIndex: 5,
        borderRadius: 2,
        boxShadow: '0 0 0 1px rgba(52,152,219,0.3)',
      }} />
      {/* Margin visualization (green) */}
      {hasMargin && <>
        {/* Top margin */}
        {margin.top > 0 && <div style={{
          position: 'absolute',
          left: rect.left, top: rect.top - margin.top,
          width: rect.width, height: margin.top,
          backgroundColor: 'rgba(46,204,113,0.25)',
          pointerEvents: 'none', zIndex: 4,
        }} />}
        {/* Bottom margin */}
        {margin.bottom > 0 && <div style={{
          position: 'absolute',
          left: rect.left, top: rect.top + rect.height,
          width: rect.width, height: margin.bottom,
          backgroundColor: 'rgba(46,204,113,0.25)',
          pointerEvents: 'none', zIndex: 4,
        }} />}
        {/* Left margin */}
        {margin.left > 0 && <div style={{
          position: 'absolute',
          left: rect.left - margin.left, top: rect.top - margin.top,
          width: margin.left, height: rect.height + margin.top + margin.bottom,
          backgroundColor: 'rgba(46,204,113,0.25)',
          pointerEvents: 'none', zIndex: 4,
        }} />}
        {/* Right margin */}
        {margin.right > 0 && <div style={{
          position: 'absolute',
          left: rect.left + rect.width, top: rect.top - margin.top,
          width: margin.right, height: rect.height + margin.top + margin.bottom,
          backgroundColor: 'rgba(46,204,113,0.25)',
          pointerEvents: 'none', zIndex: 4,
        }} />}
      </>}
      {/* Pivot indicator (circle) */}
      {anchorData && <div style={{
        position: 'absolute',
        left: pivotPxLeft - 4,
        top: pivotPxTop - 4,
        width: 8, height: 8,
        borderRadius: '50%',
        backgroundColor: '#e74c3c',
        border: '1.5px solid #fff',
        pointerEvents: 'none',
        zIndex: 7,
      }} />}
      {/* Drag arrows for repositioning (only for non-stretch axes) */}
      {showDragArrows && <>
        {/* Horizontal arrow (left/right) */}
        {dragAxes.h && <svg
          onPointerDown={e => handlePointerDown(e as any, 'move-x')}
          style={{
            position: 'absolute',
            left: arrowCx - ARROW_LEN, top: arrowCy - ARROW_W / 2,
            width: ARROW_LEN * 2, height: ARROW_W,
            pointerEvents: 'auto', cursor: 'ew-resize', zIndex: 8,
          }}
          viewBox={`0 0 ${ARROW_LEN * 2} ${ARROW_W}`}
        >
          {/* Left arrowhead */}
          <polygon points={`6,${ARROW_W / 2} 14,2 14,${ARROW_W - 2}`} fill="#e74c3c" />
          {/* Shaft */}
          <rect x={14} y={ARROW_W / 2 - 2} width={ARROW_LEN * 2 - 28} height={4} fill="#e74c3c" rx={2} />
          {/* Right arrowhead */}
          <polygon points={`${ARROW_LEN * 2 - 6},${ARROW_W / 2} ${ARROW_LEN * 2 - 14},2 ${ARROW_LEN * 2 - 14},${ARROW_W - 2}`} fill="#e74c3c" />
        </svg>}
        {/* Vertical arrow (up/down) */}
        {dragAxes.v && <svg
          onPointerDown={e => handlePointerDown(e as any, 'move-y')}
          style={{
            position: 'absolute',
            left: arrowCx - ARROW_W / 2, top: arrowCy - ARROW_LEN,
            width: ARROW_W, height: ARROW_LEN * 2,
            pointerEvents: 'auto', cursor: 'ns-resize', zIndex: 8,
          }}
          viewBox={`0 0 ${ARROW_W} ${ARROW_LEN * 2}`}
        >
          {/* Up arrowhead */}
          <polygon points={`${ARROW_W / 2},6 2,14 ${ARROW_W - 2},14`} fill="#2ecc71" />
          {/* Shaft */}
          <rect x={ARROW_W / 2 - 2} y={14} width={4} height={ARROW_LEN * 2 - 28} fill="#2ecc71" rx={2} />
          {/* Down arrowhead */}
          <polygon points={`${ARROW_W / 2},${ARROW_LEN * 2 - 6} 2,${ARROW_LEN * 2 - 14} ${ARROW_W - 2},${ARROW_LEN * 2 - 14}`} fill="#2ecc71" />
        </svg>}
      </>}
      {/* Resize handles */}
      {HANDLES.map(h => {
        const isAutoAxis = (
          (h.id.includes('l') || h.id.includes('r')) && isAutoWidth
        ) || (
          (h.id.includes('t') || h.id.includes('b')) && isAutoHeight
        );
        return (
          <div
            key={h.id}
            onPointerDown={e => handlePointerDown(e, h.id)}
            style={{
              position: 'absolute',
              left: rect.left + rect.width * h.fx - HANDLE_SIZE / 2,
              top: rect.top + rect.height * h.fy - HANDLE_SIZE / 2,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              backgroundColor: isAutoAxis ? 'rgba(52,152,219,0.3)' : '#3498db',
              border: isAutoAxis ? '1.5px dashed #3498db' : '1.5px solid #fff',
              borderRadius: 1,
              cursor: h.cursor,
              pointerEvents: 'auto',
              zIndex: 6,
              boxSizing: 'border-box',
            }}
          />
        );
      })}
    </>
  );
}
