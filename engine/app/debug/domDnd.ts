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

/** How long to wait for an ASYNC drop handler before deciding nothing was committed.
 *  `handlePrefabDrop` does `await fetch(prefabPath)` from the dev server / asar, so the
 *  mutation lands well after `dispatchEvent` returns. Generous on purpose: a false
 *  "nothing happened" on a slow-but-successful drop would be worse than the bug this
 *  detects, so this errs toward waiting. */
const COMMIT_SETTLE_MS = 400;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  /** Did the editor actually record an edit? `accepted` only says the target was willing to
   *  take this payload TYPE; the drop HANDLER can still reject the specific payload and do
   *  nothing. Undefined when no probe was supplied (non-editor host). */
  committed?: boolean;
  /** Present only on a no-op (ok:false): why the drop didn't land. */
  error?: string;
  /** Delivered + accepted, but no edit was recorded — see `committed`. */
  warning?: string;
}

export interface DomDndOptions {
  /** Monotonic count of non-selection edits (the editor's `getEditVersion`). Injected rather
   *  than imported so this module keeps no editor dependency. Without it `committed` is
   *  undefined and the acceptance-only verdict stands. */
  editVersion?: () => number;
}

/** Synthesize a full HTML5 drag-and-drop from → to.
 *
 *  ACCEPTED IS NOT COMMITTED (measured 2026-07-22). A Hierarchy entity row preventDefaults
 *  `dragover` for ANY asset payload, then routes `drop` to a handler that returns immediately
 *  unless the asset is a PREFAB. Dropping a texture on an entity row therefore satisfied both
 *  of the old `ok` conditions — the source wrote a transfer, the target accepted the type —
 *  while the world was provably untouched: entityCount unchanged, the target entity
 *  byte-identical, `unsavedChanges:false`, and `canUndo:false`, i.e. not one undo entry was
 *  pushed. The agent was told `ok:true, accepted:true`.
 *
 *  So acceptance is now the FLOOR, not the verdict: when an edit-version probe is supplied we
 *  also check whether the editor recorded an edit, and say so when it did not. */
export async function performDomDnd(params: DomDndParams, opts?: DomDndOptions): Promise<DomDndResult> {
  const src = resolveDomPoint(params.from, 'from');
  const dst = resolveDomPoint(params.to, 'to');
  const dt = new DataTransfer();
  const before = opts?.editVersion?.();

  fireDnd(src.el, 'dragstart', src.x, src.y, dt);
  fireDnd(dst.el, 'dragenter', dst.x, dst.y, dt);
  // A drop target signals acceptance by preventDefault-ing dragover; if it never
  // does, a real drop wouldn't fire either — report that instead of silently "ok".
  const over = fireDnd(dst.el, 'dragover', dst.x, dst.y, dt);
  const accepted = over.defaultPrevented;
  fireDnd(dst.el, 'drop', dst.x, dst.y, dt);
  fireDnd(src.el, 'dragend', dst.x, dst.y, dt);

  const types = Array.from(dt.types);
  // Let an async drop handler (handlePrefabDrop awaits a fetch) run before asking whether
  // anything changed. Only worth waiting when a commit was actually plausible.
  let committed: boolean | undefined;
  if (before !== undefined && types.length > 0 && accepted) {
    await sleep(COMMIT_SETTLE_MS);
    committed = (opts!.editVersion!() ?? before) !== before;
  }
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
    ...(committed !== undefined ? { committed } : {}),
    ...(types.length === 0
      ? { error: 'drag-and-drop no-op: the source element wrote nothing to the DataTransfer — it is likely not a drag source (wrong `from` selector).' }
      : !accepted
        ? { error: 'drag-and-drop no-op: the target did not accept the drop (it never preventDefault-ed dragover — wrong `to` target, or it rejects this payload type).' }
        // A WARNING, not an error, and `ok` deliberately stays true. The DnD sequence really was
        // delivered and really was accepted; what we cannot prove is that the handler acted.
        // Some legitimate drops are not undoable edits (a file move writes to disk), so
        // downgrading these to ok:false would invent failures across drop targets nobody has
        // enumerated — trading a false success for a false failure. Say exactly what is known.
        : committed === false
          ? { warning: 'the target accepted the payload TYPE but no editor edit was recorded, so the drop probably did nothing — the classic case is a non-prefab asset dropped on a Hierarchy entity row, which accepts any asset on dragover and then ignores everything but a prefab. Verify with get_scene_state/history before building on this. (A drop that legitimately makes no undoable edit, e.g. a file move, also lands here.)' }
          : {}),
  };
}
