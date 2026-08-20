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

import { resolveDomPoint, aimProvenance, type DomPointSpec } from './domResolve';
import type { DomPointResolution } from './domPointContract';

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

/** Where an endpoint landed, plus the same `matched`/`hitTarget`/`occluded` provenance
 *  `/api/input/drag` already returns. `modoki_dnd` used to report only the coordinates, which
 *  is how a covered drop became indistinguishable from one a human could perform (#260). */
export type DndEndpointReport = { selector?: string; x: number; y: number }
  & Pick<DomPointResolution, 'matched' | 'hitTarget' | 'occluded' | 'clipped'>;

export interface DomDndResult {
  /** True ONLY when the drop actually landed: the source wrote a non-empty transfer AND
   *  the target accepted it. False ⇒ a no-op (see `error`), surfaced as a tool failure. */
  ok: boolean;
  from: DndEndpointReport;
  to: DndEndpointReport;
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
  /** The drop landed, but something about it should stop a verdict resting on it. Two causes,
   *  joined with ` ALSO: ` when both apply: an endpoint was COVERED, so no human could have
   *  performed this gesture (#260); or it was delivered + accepted but no edit was recorded —
   *  see `committed`. */
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
  // Hit-test BOTH endpoints before a single event fires. Not a gate — see the header note on
  // why this warns instead of refusing — and it has to happen here because the gesture itself
  // moves the DOM (a drop indicator, a panel that re-lays-out), so provenance read afterwards
  // would describe a page that no longer resembles the one aimed at.
  const fromAim = aimProvenance(src.el, src.x, src.y, !!params.from.selector);
  const toAim = aimProvenance(dst.el, dst.x, dst.y, !!params.to.selector);
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
  // A COVERED endpoint is a warning, never a refusal, and the asymmetry with every other aimed
  // input op is deliberate (#260). `docs/mcp-tool-conventions.md` §3 refuses a covered aim because
  // the input would land on the covering element — that rationale does not hold here.
  // `dispatchEvent` bypasses hit-testing, so a covered target genuinely receives the drop and
  // refusing would reject a call that works. It cannot be a gate for a second reason: the
  // endpoints are resolved BEFORE the gesture starts, so a cover that only appears mid-drag (the
  // Hierarchy drop indicator, the Assets drop overlay) is invisible from here and a refusal would
  // be a false positive on legitimate flows.
  //
  // What IS the defect is the silence. A human's drag is hit-tested by the browser, so a drop
  // aimed at a row behind a modal is delivered to the MODAL and the row's handler never fires.
  // This op delivers it to the row, the handler commits, and the result reads ok:true —
  // indistinguishable from a gesture a user could actually perform. So a QA case could pass on a
  // drop that is broken for every human. Both endpoints are affected: a covered SOURCE gets
  // `dragstart` dispatched onto something a human could not even grab.
  const covered = [
    ...(fromAim.occluded ? [`the source (from) is covered by ${fromAim.hitTarget}`] : []),
    ...(toAim.occluded ? [`the target (to) is covered by ${toAim.hitTarget}`] : []),
  ];
  const warnings: string[] = [];
  if (covered.length > 0) {
    warnings.push(
      `THIS DROP IS NOT ONE A HUMAN COULD PERFORM: ${covered.join(' and ')}. The events were dispatched straight at the element, which bypasses the browser's hit-testing, so the handler ran anyway — a real drag would have been delivered to the covering element and the intended handler would never have fired. Do not rest a QA verdict on this gesture: move the cover out of the way (close the menu/modal, scroll the row into view) and repeat it.`,
    );
  }
  if (types.length > 0 && accepted && committed === false) {
    warnings.push(
      'the target accepted the payload TYPE but no editor edit was recorded, so the drop probably did nothing — the classic case is a non-prefab asset dropped on a Hierarchy entity row, which accepts any asset on dragover and then ignores everything but a prefab. Verify with get_scene_state/history before building on this. (A drop that legitimately makes no undoable edit, e.g. a file move, also lands here.)',
    );
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
    from: { ...(params.from.selector ? { selector: params.from.selector } : {}), x: src.x, y: src.y, ...fromAim },
    to: { ...(params.to.selector ? { selector: params.to.selector } : {}), x: dst.x, y: dst.y, ...toAim },
    types,
    accepted,
    ...(committed !== undefined ? { committed } : {}),
    ...(types.length === 0
      ? { error: 'drag-and-drop no-op: the source element wrote nothing to the DataTransfer — it is likely not a drag source (wrong `from` selector).' }
      : !accepted
        ? { error: 'drag-and-drop no-op: the target did not accept the drop (it never preventDefault-ed dragover — wrong `to` target, or it rejects this payload type).' }
        : {}),
    // Everything in `warnings` is a WARNING rather than an error, and `ok` deliberately stays
    // true for all of them. The no-edit case: the DnD sequence really was delivered and really
    // was accepted; what we cannot prove is that the handler acted, and some legitimate drops
    // are not undoable edits (a file move writes to disk), so downgrading them to ok:false would
    // invent failures across drop targets nobody has enumerated — trading a false success for a
    // false failure. The covered case: the drop genuinely landed, it just landed somewhere a
    // human could not have put it. Say exactly what is known, in both cases.
    ...(warnings.length > 0 ? { warning: warnings.join(' ALSO: ') } : {}),
  };
}
