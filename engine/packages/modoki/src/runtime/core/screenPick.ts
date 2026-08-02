/** Pick providers — "which entity would a real click at this point select?"
 *
 *  The sibling of `screenBounds.ts`, and deliberately its exact shape: a surface registers a
 *  function, the registry is keyed by `BoundsSurface`, a throwing provider is skipped, and
 *  registration returns its own unregister. Read that file first; this one only differs where
 *  the QUESTION differs.
 *
 *  WHY THIS EXISTS. A 2D/3D entity aim (`entityResolve.ts`) could only ask "does the click reach
 *  the canvas at all" — `occlusionScope: 'canvas'`. A mesh sitting directly in front of the
 *  target reported `occluded: false`. This registry is how that question gets answered properly.
 *
 *  THE ONE RULE THAT MATTERS: **a provider PREDICTS its surface's own hit-test, it does not
 *  judge it.** Whatever the surface would really select IS the ground truth, so a provider must
 *  be wired to the same code path the surface's pointer handler runs — not to a second,
 *  independently-written raycast that happens to agree today. A confident-but-wrong
 *  `occluded: false` is strictly worse than the honest `'canvas'` fallback, because it converts
 *  an acknowledged blind spot into a false guarantee.
 *
 *  Corollary, and the reason this is a REGISTRY rather than an engine-shipped default: a surface
 *  with no hit-test of its own gets NO provider. The engine does not invent one. Selection policy
 *  is game code — a physics scene query, a custom raycast, colliders-not-render-geometry, or
 *  nothing at all — and the engine has no business deciding what a game considers clickable
 *  (owner decision, 2026-07-29; see `docs/enact.md`). Today that means
 *  the editor's SceneView registers one and the runtime GameView surfaces do not, so a game-3d /
 *  game-2d aim keeps reporting `occlusionScope: 'canvas'` until a game opts in. That is the
 *  honest answer, not a gap to paper over.
 *
 *  Layer: **L0**, beside `screenBounds.ts`, for the same reason — it is consumed both by L3
 *  renderers/editor panels (which register) and by `engine/app/debug/**` outside the runtime
 *  package entirely (which reads), so it has to sit below everything that touches it. */

import type { BoundsSurface } from './screenBounds';

/** Predicts one surface's hit-test at a point.
 *
 *  `x`/`y` are **viewport CSS pixels** (the same space `collectScreenBounds` reports rects in and
 *  the same space input is dispatched in), so a provider converts to its own canvas space itself
 *  — it is the only thing that knows its canvas rect, DPR, and letterboxing.
 *
 *  Returns the runtime entity id a click there would select, or `null` for "nothing" (empty
 *  space, or a point outside this surface's canvas). A provider that cannot answer right now
 *  should return `null` rather than guess. */
export type PickProvider = (x: number, y: number) => number | null;

/** `surface` is REQUIRED here, unlike `registerBoundsProvider`'s optional one. An aim always
 *  names the surface it means (2D/3D aims are refused without it), so a provider that cannot be
 *  matched to a surface could never be consulted — accepting an unlabelled one would only let it
 *  register and then silently never run. */
interface Registration { surface: BoundsSurface; priority: number }
const providers = new Map<PickProvider, Registration>();

/** A surface registers its picker (returns an unregister fn). Call the SAME function the
 *  surface's own pointer handler calls — see the rule in the file header.
 *
 *  `priority` (default 0) breaks ties when MORE THAN ONE provider is registered under the same
 *  surface and both answer for the same point (e.g. SceneView's 2D canvas overlay sitting on top
 *  of its 3D viewport, both under `'scene-view'`) — higher priority is consulted first, and wins
 *  if it answers non-null. Equal priority falls back to registration order. */
export function registerPickProvider(fn: PickProvider, surface: BoundsSurface, priority = 0): () => void {
  providers.set(fn, { surface, priority });
  return () => { providers.delete(fn); };
}

/** Which surfaces can currently answer a pick, in registration order. Cheap — reads the registry,
 *  not the scene. This is what lets a caller report `occlusionScope: 'canvas'` HONESTLY (no
 *  picker here) instead of conflating it with `'entity'` + nothing-hit. */
export function pickableSurfaces(): BoundsSurface[] {
  const out: BoundsSurface[] = [];
  for (const r of providers.values()) if (!out.includes(r.surface)) out.push(r.surface);
  return out;
}

/** Does this surface have a picker mounted? */
export function hasPickProvider(surface: BoundsSurface): boolean {
  for (const r of providers.values()) if (r.surface === surface) return true;
  return false;
}

/** Ask `surface` what a click at (x, y) would select.
 *
 *  Returns the entity id, or `null` for "nothing there". `undefined` is a THIRD, different
 *  answer: no picker is mounted for this surface, so the question was not asked at all. Callers
 *  must keep those apart — collapsing "nothing was hit" into "nobody answered" is exactly the
 *  false-guarantee this registry exists to prevent.
 *
 *  A provider that throws is treated as unable to answer (`undefined`), not as a miss: one bad
 *  surface must not turn into a confident wrong verdict about occlusion.
 *
 *  ORDERING (#80): several pickers can be registered under the same surface (SceneView's 2D
 *  canvas overlay and its 3D viewport both register under `'scene-view'`, since they overlap on
 *  screen). They are consulted in DESCENDING `priority` order — first non-null wins — with
 *  registration order as the tiebreak among equal priorities. This replaces the old "registration
 *  order = z-order" assumption (React effect mount order is not guaranteed to match on-screen
 *  z-order): a provider that visually sits on top now says so explicitly via its `priority`
 *  argument to `registerPickProvider`, instead of relying on mount timing. */
export function pickAt(surface: BoundsSurface, x: number, y: number): number | null | undefined {
  let answered = false;
  let hit: number | null = null;
  const candidates = [...providers.entries()]
    .filter(([, r]) => r.surface === surface)
    .sort((a, b) => b[1].priority - a[1].priority); // descending priority; stable sort preserves registration order for ties
  for (const [fn] of candidates) {
    try {
      const r = fn(x, y);
      answered = true;
      if (r !== null && r !== undefined) { hit = r; break; }
    } catch { /* a failing picker cannot answer; leave `answered` as-is */ }
  }
  return answered ? hit : undefined;
}

/** Test seam — drop every registration. Never call this from app code; surfaces unregister
 *  through the closure `registerPickProvider` returns. */
export function __resetPickProvidersForTest(): void {
  providers.clear();
}
