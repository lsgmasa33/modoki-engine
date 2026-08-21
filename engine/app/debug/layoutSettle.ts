/** Is the editor's LAYOUT still moving right now? (#261)
 *
 *  WHY THIS EXISTS. A trusted-input aim can be refused — `OCCLUDED`, "nothing at that point",
 *  "zero-size" — for a reason that is TRUE at the instant it is asked and gone a frame later:
 *  the dock has just changed and the target has not reached its final position. The refusal is
 *  accurate and the diagnosis it offers ("dismiss what covers it") is useless, because nothing
 *  covers it and nothing needs dismissing. #261 is that trade.
 *
 *  This answers the question directly instead of inferring it from a timestamp. Two reasons that
 *  matters:
 *
 *  1. A timestamp needs the EDITOR to publish "the dock changed at T", and the only seam between
 *     the package's editor and this layer is `window.__editorStore`, which is **DEV-ONLY**
 *     (`editorStore.ts`). Enact runs in the packaged DMG too, so a hint plumbed that way would
 *     silently do nothing in the product — a capability that works in dev and not in the thing
 *     that ships.
 *  2. "The dock changed 40 ms ago" is a PROXY for "the layout has not settled". Measuring the
 *     movement is the fact itself, and it stays correct if the dock ever animates or settles
 *     slower.
 *
 *  MEASURED (2026-08-22, three ways) before this was written: a React commit settles in 0 frames,
 *  a FlexLayout tab reveal in 1, a tab add/remove in 0-1 — and in every case the unsettled state
 *  reported a ZERO RECT (a clean "cannot resolve"), never a false cover. So one frame is the right
 *  window, and this is a HINT on a refusal rather than a retry: the call still refuses, the input
 *  is still not dispatched, and the caller re-aims. Measurements + why the retry was declined:
 *  `docs/enact.md` § "A refusal that may be TRANSIENT says so".
 *
 *  Deliberately samples `[data-ui-id]` rather than one target element: the question is whether the
 *  DOCK is mid-move, which is a property of the layout and not of the thing you happened to aim
 *  at — and it is the same sample the #261 measurements used. Cheap (~15 nodes in a live editor).
 */

/** One frame of layout, keyed so a node appearing or disappearing is itself a change. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  for (const el of document.querySelectorAll('[data-ui-id]')) {
    const id = el.getAttribute('data-ui-id');
    if (!id) continue;
    const r = el.getBoundingClientRect();
    out.set(id, `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`);
  }
  return out;
}

export type LayoutSettleReport = {
  /** True when at least one laid-out element moved or resized across the frame. */
  settling: boolean;
  /** How many changed, and out of how many — so `settling:true` can be read for scale. */
  moved: number;
  sampled: number;
};

/** Sample the layout, wait ONE frame, sample again. Never throws. */
export async function layoutSettleReport(): Promise<LayoutSettleReport> {
  try {
    const before = snapshot();
    await new Promise<void>((resolve) => {
      // A detached/hidden window may never fire rAF. Time out rather than hanging the refusal
      // path — a missing hint is a small loss, a wedged input route is not.
      const timer = setTimeout(resolve, 100);
      requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
    });
    const after = snapshot();
    let moved = 0;
    for (const [id, rect] of after) if (before.get(id) !== rect) moved += 1;
    for (const id of before.keys()) if (!after.has(id)) moved += 1;
    return { settling: moved > 0, moved, sampled: Math.max(before.size, after.size) };
  } catch {
    return { settling: false, moved: 0, sampled: 0 };
  }
}
