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
import { NOTHING_AT_POINT, type DomPointResolution } from './domPointContract';

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
  /** WHICH side the commit landed on, present only when `committed` is true. Reported because
   *  "it worked" and "it worked, and save_all is what persists it" are different follow-ups, and
   *  the old single-counter signal could not tell them apart (#1142).
   *
   *  ⚠️ **Read these as what the counters MEASURE, not as a claim about scene entities.** The
   *  discriminator is `getEditVersion()` — "does this count as unsaved SCENE work against the
   *  save baseline" — and an Assets **file move** lands on the `scene` side while touching no
   *  entity, because its undo action (`panels/assetUndo.ts` `makeFilesDropUndo`) is a plain one
   *  and that file sets `_isFileDirect` on nothing:
   *  - `scene` — the edit bumped the scene-vs-disk baseline. Usually a real scene edit; also a
   *    file move, which is not one.
   *    (entity→Assets **prefab-create** is NOT an example: `tagEntityTreeAsInstance` writes a
   *    `PrefabInstance` trait to every node in the subtree, so `scene` is simply correct there.)
   *  - `asset-document` — a skin/particle/atlas/material document, parked in the dirty-asset
   *    registry and flushed by save_all. */
  committedTo?: 'scene' | 'asset-document';
  /** Present only on a no-op (ok:false): why the drop didn't land. */
  error?: string;
  /** The drop landed, but something about it should stop a verdict resting on it. Two causes,
   *  joined with ` ALSO: ` when both apply: an endpoint was COVERED, so no human could have
   *  performed this gesture (#260); or it was delivered + accepted but no edit was recorded —
   *  see `committed`. */
  warning?: string;
}

/** Every counter that can witness a drop having done something, sampled together.
 *
 *  ⚠️ **THREE counters, because the editor genuinely has three answers** (#1142). The original
 *  probe read only `getEditVersion`, and that counter is not "did anything happen" — it is
 *  "does the live world now differ from disk", so `undoManager.pushAction` bumps it behind
 *  `if (!action._isSelection && !action._isFileDirect)`. Every asset-panel edit sets
 *  `_isFileDirect: true`, so EVERY skin/particle/material drop was filtered out of it and read
 *  back as "the drop probably did nothing" — on drops that demonstrably landed and were
 *  undoable. `docs/enact.md` had the criterion right all along ("not one undo entry pushed…
 *  every real editor mutation pushes one"); it was the wiring that measured something else. */
export type EditWitness = {
  /** Undo-STACK mutations (`getUndoVersion`) — bumps on every push, `_isFileDirect` included.
   *  This is the one that catches a skin-bone reparent. */
  stack: number;
  /** Parked asset-document writes (`getDirtyAssetsVersion`). Needed on top of `stack` because an
   *  atlas member drop calls `persistAssetEdit` and pushes NO undo action at all, so it is
   *  invisible to both of the other two. */
  assets: number;
  /** Scene-world edits only (`getEditVersion`). No longer the commit signal — kept as the
   *  DISCRIMINATOR that says which world moved, so the reply can name it. */
  world: number;
};

export interface DomDndOptions {
  /** Samples all three counters at once. Injected rather than imported so this module keeps no
   *  editor dependency. Without it `committed` is undefined and the acceptance-only verdict
   *  stands. */
  witness?: () => EditWitness;
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
 *  So acceptance is now the FLOOR, not the verdict: when a witness probe is supplied we also check
 *  whether the editor recorded an edit, and say so when it did not.
 *
 *  ⚠️ **What counts as "recorded" is the UNDO STACK plus the parked-asset registry, not the
 *  scene-dirty counter** (#1142) — see `EditWitness`. Reading the scene-dirty counter alone made
 *  every asset-editor drop, all of which are `_isFileDirect`, report as a no-op. */
export async function performDomDnd(params: DomDndParams, opts?: DomDndOptions): Promise<DomDndResult> {
  const src = resolveDomPoint(params.from, 'from');
  const dst = resolveDomPoint(params.to, 'to');
  // Hit-test BOTH endpoints before a single event fires. Not a gate — see the header note on
  // why this warns instead of refusing — and it has to happen here because the gesture itself
  // moves the DOM (a drop indicator, a panel that re-lays-out), so provenance read afterwards
  // would describe a page that no longer resembles the one aimed at.
  // ⚠️ **`'drag'`, explicitly, and this is the call site the required parameter exists for**
  // (#1016). A DnD is press-move-release across two points, so #977's click-time tap-zone redirect
  // never applies — and letting it apply would let a drop whose target is covered by a neighbour's
  // expander report SUCCESS while the gesture actually began on the zone's host. That is §0's
  // rank-1 false success, and it is what `75ba25601` traded a stale refusal for.
  const fromAim = aimProvenance(src.el, src.x, src.y, !!params.from.selector, 'drag');
  const toAim = aimProvenance(dst.el, dst.x, dst.y, !!params.to.selector, 'drag');
  const dt = new DataTransfer();
  const before = opts?.witness?.();

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
  let committedTo: DomDndResult['committedTo'];
  if (before !== undefined && types.length > 0 && accepted) {
    await sleep(COMMIT_SETTLE_MS);
    const after = opts!.witness!();
    // EITHER world counts as a commit. The stack catches anything that pushed an undo entry
    // (scene edits and `_isFileDirect` asset edits alike); the registry catches a park that
    // pushed nothing.
    committed = after.stack !== before.stack || after.assets !== before.assets;
    // ⚠️ FOUR known imprecisions, stated rather than left to be rediscovered. All are "something
    // moved that was not this drop", and all need an event inside the 400 ms window:
    //  1. `getDirtyAssetsVersion` bumps on park AND on flush/discard — a racing `save_all` reads
    //     as a commit.
    //  2. `getUndoVersion` bumps for a `_isSelection` push, which #1137 establishes are real undo
    //     entries. Latent rather than shipped: no drop target's ONLY effect is a selection today
    //     (the Assets and Hierarchy dragstart handlers do not select).
    //  3. `getUndoVersion` also bumps from `clearHistory`/`truncateUndoTo`/`swapHistory`, so a
    //     scene hot-reload or context switch mid-window reads as a commit.
    //  4. …and from `undo()`/`redo()` themselves, which call `notifyUndoChanged()`
    //     unconditionally — so a HUMAN pressing Cmd+Z mid-window reads as a commit. Likelier in
    //     practice than (3); the list said "three" and stopped, which invited trusting the set.
    // The alternative — diffing the stack's top entry and the registry's contents — buys a
    // stronger signal than "did this drop do anything" needs.
    if (committed) committedTo = after.world !== before.world ? 'scene' : 'asset-document';
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
  //
  // COVERED and NOT-ON-SCREEN are different diagnoses with different remedies, and the field
  // this reads can be either. `aimProvenance` reports `occluded` whenever the topmost element is
  // not the target — including when `elementFromPoint` returns NOTHING, which means the point is
  // off-window or clipped away rather than covered. Interpolating `hitTarget` blindly there
  // produced the literal text "covered by null": false (nothing covers it) and unactionable
  // (there is no menu to dismiss). `occlusionAt` already normalises this with NOTHING_AT_POINT;
  // this is the second reader of the same field and it has to agree with the first.
  const describeAim = (aim: typeof fromAim, which: string): string | null => {
    if (!aim.occluded) return null;
    // Most specific first: `clipped` means the target is scrolled out of its OWN panel, which
    // reads as "covered" but is fixed by scrolling, not by dismissing anything.
    if (aim.clipped) return `the ${which} is scrolled out of its own panel's visible area`;
    const cover = aim.hitTarget && aim.hitTarget !== NOTHING_AT_POINT ? aim.hitTarget : null;
    return cover
      ? `the ${which} is covered by ${cover}`
      : `the ${which} is off-window or clipped away — nothing is at its point at all`;
  };
  const covered = [describeAim(fromAim, 'source (from)'), describeAim(toAim, 'target (to)')]
    .filter((m): m is string => m !== null);
  const warnings: string[] = [];
  // Gated on the drop having actually LANDED, which is what `warning` claims by contract ("the
  // drop landed, but ..."). Occlusion cannot cause a no-op here — dispatchEvent bypasses
  // hit-testing — so on a failed drop the cover is irrelevant, and pairing it with the `error`
  // that says nothing happened produced a self-contradicting result: an error stating the drop
  // was a no-op beside a warning asserting a human could not have performed it.
  if (covered.length > 0 && types.length > 0 && accepted) {
    warnings.push(
      `THIS DROP IS NOT ONE A HUMAN COULD PERFORM: ${covered.join(' and ')}. The events were dispatched straight at the element, which bypasses the browser's hit-testing, so the handler ran anyway — a real drag would have been delivered to the covering element and the intended handler would never have fired. Do not rest a QA verdict on this gesture: move the cover out of the way (close the menu/modal, scroll the row into view) and repeat it.`,
    );
  }
  // NOTE: this used to cite "a non-prefab asset dropped on a Hierarchy entity row" as the
  // classic case. It no longer is — #306 made the Hierarchy refuse a non-prefab asset on
  // dragover, so that gesture now comes back `accepted:false` with the honest error below
  // instead of arriving here. The heuristic stays for the cases nothing has closed.
  if (types.length > 0 && accepted && committed === false) {
    warnings.push(
      'the target accepted the payload TYPE but NEITHER the undo stack NOR the parked-asset registry moved, so the drop probably did nothing. Verify with get_scene_state/history before building on this. TWO legitimate drops also land here: one whose handler is still running after 400ms (a prefab fetch with nested-prefab preloading, or a Skin sprite drop reading back an alpha mask), and one that records in neither place (a Project Settings path field, which adopts the file server-side and holds the value in dialog state).',
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
    ...(committedTo ? { committedTo } : {}),
    ...(types.length === 0
      ? { error: 'drag-and-drop no-op: the source element wrote nothing to the DataTransfer — it is likely not a drag source (wrong `from` selector).' }
      : !accepted
        ? { error: 'drag-and-drop no-op: the target did not accept the drop (it never preventDefault-ed dragover — wrong `to` target, or it rejects this payload type).' }
        : {}),
    // Everything in `warnings` is a WARNING rather than an error, and `ok` deliberately stays
    // true for all of them. The no-edit case: the DnD sequence really was delivered and really
    // was accepted; what we cannot prove is that the handler acted, and some legitimate drops
    // are not undoable edits (the warning text names the two that actually reach it — a file
    // MOVE is not one of them: it pushes a plain undo action, so the STACK moves and it is
    // reported committed), so downgrading them to ok:false would
    // invent failures across drop targets nobody has enumerated — trading a false success for a
    // false failure. The covered case: the drop genuinely landed, it just landed somewhere a
    // human could not have put it. Say exactly what is known, in both cases.
    ...(warnings.length > 0 ? { warning: warnings.join(' ALSO: ') } : {}),
  };
}
