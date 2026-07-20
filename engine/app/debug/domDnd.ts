/** HTML5 drag-and-drop synthesis for the agent (Enact Phase 1).
 *
 *  Electron's trusted `sendInputEvent` mouse drag (rendererOps.ts `drag`) drives
 *  POINTER gestures — PixiJS/Three.js hit-testing, gizmo drags — but it does NOT
 *  emit the HTML5 DnD event sequence (`dragstart`→`dragenter`→`dragover`→`drop`→
 *  `dragend`). The editor's most useful drops (Hierarchy reparent, Assets file-move,
 *  Skin sprite-onto-part / part-reorder / bone-reparent) are HTML5 DnD, so they were
 *  unreachable. This synthesizes that sequence in the renderer DOM.
 *
 *  Key trick: dispatch a REAL `dragstart` on the source and let the app's own
 *  handler populate the shared `DataTransfer` (via `e.dataTransfer.setData(...)`);
 *  carry that SAME transfer through to `drop` so the drop handler reads back exactly
 *  what the app wrote. We never fabricate the payload — the app does, as with a human
 *  drag. Runs renderer-side (DOM only), so it works in dev AND the packaged DMG. */

import { resolveDomPoint, type DomPointSpec } from './domResolve';

/** Where a drag endpoint is — either a CSS selector or viewport CSS coordinates.
 *  A selector targets the element's center; coordinates use `elementFromPoint`. */
export type DndEndpoint = DomPointSpec;

export interface DomDndParams {
  from: DndEndpoint;
  to: DndEndpoint;
}

/** Fire one DnD event carrying the shared transfer at the given point. Returns the
 *  event so callers can inspect `defaultPrevented` (a target that accepts the drop
 *  calls `preventDefault` on dragover). */
function fireDnd(el: Element, type: string, x: number, y: number, dt: DataTransfer): DragEvent {
  const ev = new DragEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    clientX: x, clientY: y, dataTransfer: dt,
  });
  el.dispatchEvent(ev);
  return ev;
}

export interface DomDndResult {
  /** True ONLY when the drop actually landed: the source wrote a non-empty transfer AND
   *  the target accepted it. False ⇒ a no-op (see `error`), surfaced as a tool failure. */
  ok: boolean;
  from: { selector?: string; x: number; y: number };
  to: { selector?: string; x: number; y: number };
  /** MIME types the source's dragstart handler wrote into the transfer. Empty ⇒ the
   *  source isn't a DnD source (likely the wrong element — a real gap, surfaced). */
  types: string[];
  /** True if the target accepted the drop (called preventDefault on dragover) — a
   *  target that ignores dragover would reject a real drop too. */
  accepted: boolean;
  /** Present only on a no-op (ok:false): why the drop didn't land. */
  error?: string;
}

/** Synthesize a full HTML5 drag-and-drop from → to. */
export function performDomDnd(params: DomDndParams): DomDndResult {
  const src = resolveDomPoint(params.from, 'from');
  const dst = resolveDomPoint(params.to, 'to');
  const dt = new DataTransfer();

  fireDnd(src.el, 'dragstart', src.x, src.y, dt);
  fireDnd(dst.el, 'dragenter', dst.x, dst.y, dt);
  // A drop target signals acceptance by preventDefault-ing dragover; if it never
  // does, a real drop wouldn't fire either — report that instead of silently "ok".
  const over = fireDnd(dst.el, 'dragover', dst.x, dst.y, dt);
  const accepted = over.defaultPrevented;
  fireDnd(dst.el, 'drop', dst.x, dst.y, dt);
  fireDnd(src.el, 'dragend', dst.x, dst.y, dt);

  const types = Array.from(dt.types);
  // `ok` must reflect what ACTUALLY happened, not just "we fired the sequence". An empty
  // transfer means the source's dragstart wrote nothing (wrong source element ⇒ the drop
  // handler reads back nothing ⇒ genuine no-op); accepted:false means the target never
  // preventDefault-ed dragover, so a real drop wouldn't have committed either. Reporting
  // ok:true in either case is the exact false-success the rest of this surface was hardened
  // against — an agent doing a reparent/file-move/prefab-drop would build on a change that
  // never landed. The honest `types`/`accepted` ride along for diagnostics.
  return {
    ok: types.length > 0 && accepted,
    from: { ...(params.from.selector ? { selector: params.from.selector } : {}), x: src.x, y: src.y },
    to: { ...(params.to.selector ? { selector: params.to.selector } : {}), x: dst.x, y: dst.y },
    types,
    accepted,
    ...(types.length === 0
      ? { error: 'drag-and-drop no-op: the source element wrote nothing to the DataTransfer — it is likely not a drag source (wrong `from` selector).' }
      : !accepted
        ? { error: 'drag-and-drop no-op: the target did not accept the drop (it never preventDefault-ed dragover — wrong `to` target, or it rejects this payload type).' }
        : {}),
  };
}
