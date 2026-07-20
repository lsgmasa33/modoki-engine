/** enact-handles agent op — the numeric handle geometry behind Enact's aimed input.
 *
 *  The INPUT twin of `layoutDump.ts` (which surfaced screen-space entity bounds).
 *  Canvas2D / SVG authoring editors register their draggable handles into
 *  `interactionHandles` (runtime); this merges + filters them so Claude can read
 *  WHERE a bone joint / keyframe / collider vertex is (viewport CSS px) and then
 *  drive it with `drag-handle`/`tap-handle` — no screenshot, no pixel guessing. */

import { collectHandles, type HandleFilter, type InteractionHandle } from '@modoki/engine/runtime';
import { occlusionAt } from './domResolve';

export type HandlesDumpParams = HandleFilter;

/** A handle plus whether it currently sits inside the visible editor window. A handle can
 *  be reported at a valid viewport-CSS-px position yet be OFF-screen — e.g. an editor panel
 *  taller than the window scrolls its lower section (a gradient strip, a curve) below the
 *  fold. `tap`/`drag` at an off-screen point hit nothing, so surface it: scroll the panel
 *  (modoki_scroll over it) until the handle's `onScreen` flips true, then aim. */
export type AnnotatedHandle = Omit<InteractionHandle, 'owner'> & {
  onScreen: boolean;
  /** False when the handle's provider named no owning element, so `occludedBy` is unknown
   *  rather than known-absent. Don't read a missing `occludedBy` as "clickable" without it. */
  occlusionChecked: boolean;
};

export interface HandlesDumpResult {
  count: number;
  /** Distinct editors currently offering handles — a quick "what can I aim at now?". */
  editors: string[];
  /** How many handles are OFF-screen (need scrolling into view before they're aimable). */
  offScreenCount: number;
  /** How many handles are COVERED by something (an open menu, a modal, a scrim). A trusted
   *  click hit-tests by coordinate, so these cannot be driven where they appear to be —
   *  dismiss the thing on top first. Each carries `occludedBy` naming what covers it. */
  occludedCount: number;
  /** How many handles could NOT be occlusion-checked, because their provider named no
   *  owning element. `occludedCount === 0` therefore does NOT mean "everything is
   *  clickable" unless this is also 0 — without it the count would be a chrome-only metric
   *  masquerading as a global one, and a keyframe under an open modal would read as fine. */
  occlusionUnchecked: number;
  /** How many handles are present but INERT (`meta.disabled`) — a greyed-out control. */
  disabledCount: number;
  /** The editor window's CSS size (origin top-left) — the space handle x/y live in. Lets a
   *  caller map a downscaled capture's image px ↔ these CSS px (css = imgPx · w/imgWidth). */
  viewport: { w: number; h: number };
  handles: AnnotatedHandle[];
}

/** A greyed-out control — present but inert. `meta.disabled` is the convention. */
const isDisabled = (h: InteractionHandle) => h.meta?.disabled === true;

const isElement = (v: unknown): v is Element =>
  typeof Element !== 'undefined' && v instanceof Element;

export function computeHandles(params: HandlesDumpParams = {}): HandlesDumpResult {
  const raw = collectHandles(params);
  const vw = typeof window !== 'undefined' ? window.innerWidth : Infinity;
  const vh = typeof window !== 'undefined' ? window.innerHeight : Infinity;

  const handles: AnnotatedHandle[] = raw.map((h) => {
    // Occlusion is computed HERE, for every handle that names an owning element — not in
    // the chrome provider. Being un-clickable because something covers you is a property
    // of anything addressed by coordinate, which is what a handle IS. `owner` is a live
    // DOM node, so it must never reach the JSON that crosses the agent bridge.
    const { owner, ...rest } = h;
    const occludedBy = isElement(owner) ? occlusionAt(owner, h.x, h.y) : undefined;
    return {
      ...rest,
      ...(occludedBy ? { occludedBy } : {}),
      onScreen: h.x >= 0 && h.y >= 0 && h.x <= vw && h.y <= vh,
      occlusionChecked: isElement(owner),
    };
  });

  const editors = Array.from(new Set(handles.map((h) => h.editor))).sort();
  const count = (pred: (h: AnnotatedHandle) => boolean) => handles.reduce((n, h) => n + (pred(h) ? 1 : 0), 0);
  return {
    count: handles.length,
    editors,
    offScreenCount: count((h) => !h.onScreen),
    occludedCount: count((h) => !!h.occludedBy),
    occlusionUnchecked: count((h) => !h.occlusionChecked),
    disabledCount: count(isDisabled),
    viewport: { w: vw, h: vh },
    handles,
  };
}
