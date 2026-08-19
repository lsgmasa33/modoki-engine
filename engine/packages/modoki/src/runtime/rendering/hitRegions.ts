/** Hit-region provider registry (#139) — the geometry a `hitTest` computes and then throws away.
 *
 *  ── WHY THIS IS A FIRST-CLASS SURFACE AND NOT A DEBUG DRAW CALL ──────────────────────────────
 *  **A hit region is authored nowhere.** It is computed inside a game's `hitTest` from config, so
 *  no inspector, no scene view and no screenshot can show it. It is the one part of the
 *  interaction the human cannot see, on the surface where it matters most (touch).
 *
 *  The sibling of `pointerRecorder` (#134), which records what the finger DID. That answers "the
 *  press at (192.3, 572.9) hit nothing"; this answers "…because it fell 4.8 px below the Rook
 *  badge's rim, in the dead ring between the badge and the row beneath it". The number and the
 *  picture said the same thing in the Court session that produced both — but the picture said it
 *  at a glance, and would have said it BEFORE anyone thought to measure. It also killed a wrong
 *  theory outright: the `(i)` badge's real hit circle is visibly SMALLER than the ring drawn on
 *  screen, which no amount of staring at the screenshot would have revealed.
 *
 *  ── THE TWO THINGS ONLY THE SHAPES GIVE YOU ─────────────────────────────────────────────────
 *  1. The two failure classes become visually distinct — a press OUTSIDE every shape (targeting)
 *     versus a press INSIDE the right shape that still did nothing (latching / frame-rate).
 *  2. **The GAPS between regions**, which is where that bug lived. Reading `hitTest` line by line
 *     does not reveal that a 4.8 px dead ring exists; only drawing the shapes does.
 *
 *  ── DRAWN ≠ HIT, AND THAT DIFFERENCE IS THE POINT ───────────────────────────────────────────
 *  A provider must report the geometry its `hitTest` ACTUALLY uses, never the geometry the game
 *  draws. Court's tray badge is hit-tested larger than it is drawn (`trayGrabRadiusScale`) and its
 *  `(i)` badge smaller — reporting the drawn shape would produce a confident, pretty, wrong
 *  picture, which is worse than no picture. Where a region knows both, `drawnShape` carries the
 *  visual one so the overlay can show the discrepancy instead of hiding it.
 *
 *  Mirrors `interactionHandles.ts`'s registration pattern exactly: providers register on mount,
 *  unregister on unmount, a provider that throws is skipped. Coordinates are **viewport CSS px**,
 *  the same space `InteractionHandle`, `InputPressRecord` and `screenBounds` all use — so a region
 *  and a recorded press can be drawn on one overlay with no transform between them. */

/** A region's geometry. Circles are not expressible as rects and the difference is exactly what
 *  was misread in the Court session, so the shape is a discriminated union rather than a
 *  lowest-common-denominator box.
 *
 *  ⚠️ **`x`/`y` is the CENTRE on every variant, including `rect`** — the rect is (centre, size),
 *  NOT (top-left, size). That is deliberate (it matches `circle`, and every provider hit-tests as
 *  `|x - s.x| <= s.w / 2`; see `hitShapeContains`), and it is the opposite of every other rect an
 *  agent meets in this repo — `get_layout_bounds`'s `screen: {x,y,w,h}`, `InputPressRecord`, DOM
 *  `getBoundingClientRect` — all of which are top-left. So the reflex `cx = x + w / 2` computes a
 *  point half a cell DOWN-RIGHT of the real centre, which on a grid lands exactly on the boundary
 *  and tips into the neighbouring cell. That cost a session an hour of mis-aimed drags against
 *  Court's board (2026-08-19) before the convention was read out of this file, so it is written
 *  down here rather than left to be re-derived: to aim at a region, use `x`/`y` UNCHANGED. */
export type HitShape =
  | { type: 'circle'; x: number; y: number; r: number }
  /** `x`/`y` is the rect's CENTRE, not its top-left corner — see the warning above. */
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  /** Points in viewport CSS px, implicitly closed. */
  | { type: 'poly'; points: Array<{ x: number; y: number }> };

export interface HitRegion {
  /** Stable id UNIQUE across all providers — namespace it by game+kind+index, e.g.
   *  `court:tray:0`, `court:cell:e4`. */
  id: string;
  /** What kind of thing this is — `'tray'` | `'cell'` | `'chip-dots'` | … Usually the same string
   *  the game's own `HitTarget.kind` uses, so a region lines up with an
   *  `input_watch` record's `resolved.kind` without a translation table. */
  kind: string;
  /** Which provider produced it — a game id (`'court'`) or subsystem name. */
  provider: string;
  /** The region the hit-test ACTUALLY uses. */
  shape: HitShape;
  /** The shape the game DRAWS, when it differs from `shape`. Present only when the game knows both
   *  and they disagree — which is the interesting case and the one worth seeing. */
  drawnShape?: HitShape;
  /** Human-readable label (`'Rook badge'`, `'cell e4'`). */
  label?: string;
  /** True when this region is a drag source/target rather than a tap target. */
  draggable?: boolean;
  /** Provider-specific passthrough (piece type, cell index, region id). */
  meta?: Record<string, unknown>;
  /** Hit-test PRECEDENCE, low first — the order the game's own `hitTest` checks them in.
   *  Load-bearing for overlapping regions: Court's `(i)` badge deliberately overlaps the tray
   *  badge it sits on and is checked FIRST, so the visible overlap is not a bug and an overlay
   *  that drew them in arbitrary order would imply it was. Regions without one sort last. */
  order?: number;
}

/** Optional narrowing for a region query. */
export interface HitRegionFilter {
  provider?: string;
  kind?: string;
  ids?: string[];
}

/** A region computer. Returns the surface's current regions — empty when it has none to offer
 *  (no level loaded, a modal swallowing input, the game not in a state that hit-tests). */
export type HitRegionProvider = () => HitRegion[];

const providers = new Map<string, HitRegionProvider>();

/** Register a provider under a name (returns an unregister fn). Keyed by name rather than by
 *  function identity so a Fast-Refresh re-registration REPLACES the stale closure instead of
 *  accumulating one dead provider per edit — the `[]`-deps hazard called out in
 *  `docs/editor-hmr.md`, which here would silently double every region. */
export function registerHitRegionProvider(name: string, fn: HitRegionProvider): () => void {
  providers.set(name, fn);
  return () => { if (providers.get(name) === fn) providers.delete(name); };
}

/** Names of the providers currently registered. Lets a reader tell "this surface reported no
 *  regions" from "no surface is able to report any", which is the same three-way honesty rule
 *  `pointerRecorder.resolved` is built on — a game with no provider must not look like a game
 *  whose regions are all empty. */
export function hitRegionProviders(): string[] {
  return [...providers.keys()];
}

const warnedDuplicates = new Set<string>();

/** Collect regions from every provider, optionally filtered. A bad provider is skipped —
 *  one bad game cannot break the whole overlay. Sorted by `order` so the drawing order matches
 *  hit-test precedence.
 *
 *  ⚠️ "Bad" means the WHOLE per-provider body, not just the call. Guarding only `fn()` covers a
 *  provider that THROWS and misses one that returns malformed DATA — a `.map()` that leaves an
 *  `undefined` hole, or a `() => ({})` typo — and reading `.kind` off that throws from outside the
 *  try, taking down the overlay render and every other provider's regions with it. That is the
 *  exact opposite of the isolation this function advertises, so the try wraps the loop too. */
export function collectHitRegions(filter?: HitRegionFilter): HitRegion[] {
  const out: HitRegion[] = [];
  const seen = new Set<string>();
  for (const [name, fn] of providers) {
    if (filter?.provider && filter.provider !== name) continue;
    try {
      const regions = fn() ?? [];
      if (!Array.isArray(regions)) {
        console.error(`[hitRegions] provider "${name}" returned ${typeof regions}, not an array — skipped`);
        continue;
      }
      for (const r of regions) {
        if (!r || typeof r.id !== 'string') {
          console.error(`[hitRegions] provider "${name}" returned a region with no id — skipped`, r);
          continue;
        }
        if (filter?.kind && r.kind !== filter.kind) continue;
        if (filter?.ids && !filter.ids.includes(r.id)) continue;
        // Duplicate ids are a bug and a quiet one — an overlay would draw both and a reader would
        // have no way to tell which shape belongs to which control. Warned once per id.
        if (seen.has(r.id)) {
          if (!warnedDuplicates.has(r.id)) {
            warnedDuplicates.add(r.id);
            console.warn(`[hitRegions] duplicate region id "${r.id}" — ids must be unique across providers`);
          }
          continue;
        }
        seen.add(r.id);
        // `provider` is stamped from the REGISTRY KEY, overriding whatever the region carried.
        // Otherwise there are two sources for one fact — the key `collectHitRegions` filters on
        // and the field the caller reads back — and nothing keeps them in step: a game registered
        // as 'court-regions' stamping `provider:'court'` makes `{provider:'court'}` return NOTHING
        // while every returned region says 'court'. Single source of truth, per CLAUDE.md.
        out.push(r.provider === name ? r : { ...r, provider: name });
      }
    } catch (e) {
      console.error(`[hitRegions] provider "${name}" failed — skipped`, e);
      continue;
    }
  }
  out.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  return out;
}

// ── Shape geometry ───────────────────────────────────────────────────────────────────────────
// Lives HERE, with the type it operates on, and is the only copy. It was written twice — once in
// the overlay to colour a press marker, once in the agent op to answer `at:{x,y}` — and two
// implementations of "is this point inside this shape" is precisely the drift this repo's
// single-source-of-truth rule exists to stop: the picture and the number would disagree about the
// same press, on the one surface whose entire job is that they agree.

/** Is (x, y) inside `s`? Edges count as inside — a press exactly on the rim is a hit, matching
 *  the `<=` a hand-written hit-test uses. */
export function hitShapeContains(s: HitShape, x: number, y: number): boolean {
  if (s.type === 'circle') { const dx = x - s.x, dy = y - s.y; return dx * dx + dy * dy <= s.r * s.r; }
  if (s.type === 'rect') return Math.abs(x - s.x) <= s.w / 2 && Math.abs(y - s.y) <= s.h / 2;
  // Ray casting — a poly region is authored by a game and may be concave.
  let hit = false;
  const pts = s.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Distance from (x, y) to the nearest EDGE of `s`, 0 when inside. `null` when the shape has no
 *  geometry to measure to (an empty poly) — absent rather than Infinity, so a caller cannot let a
 *  meaningless value win a comparison.
 *
 *  ⚠️ The poly case measures point-to-SEGMENT, not point-to-vertex. Vertex distance was the first
 *  implementation and it does not merely round badly — it picks the WRONG REGION. For a lane
 *  `(0,0)-(1000,0)-(1000,10)-(0,10)` and a press at `(500,15)`, the true miss is 5 px while the
 *  nearest vertex is ~500 px away, so any other control within 500 px is reported as "nearest"
 *  and the one actually missed is omitted. `distancePx` is the number people quote from this
 *  surface; a confidently wrong one is the whole failure mode. */
export function hitShapeDistance(s: HitShape, x: number, y: number): number | null {
  if (s.type === 'circle') return Math.max(0, Math.hypot(x - s.x, y - s.y) - s.r);
  if (s.type === 'rect') {
    return Math.hypot(Math.max(0, Math.abs(x - s.x) - s.w / 2), Math.max(0, Math.abs(y - s.y) - s.h / 2));
  }
  if (s.points.length === 0) return null;
  if (s.points.length === 1) return Math.hypot(x - s.points[0].x, y - s.points[0].y);
  if (hitShapeContains(s, x, y)) return 0;
  let d = Infinity;
  for (let i = 0, j = s.points.length - 1; i < s.points.length; j = i++) {
    d = Math.min(d, pointToSegment(x, y, s.points[j], s.points[i]));
  }
  return d;
}

/** Shortest distance from (px, py) to the segment a-b. */
function pointToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  // A degenerate (zero-length) segment is just its endpoint — dividing by len2 would give NaN.
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** The region containing (x, y) with the highest hit-test precedence, plus every other match.
 *  Returns them in `order`, which is the order the game's own hit-test would check them. */
export function regionsAt(regions: HitRegion[], x: number, y: number): HitRegion[] {
  return regions.filter((r) => hitShapeContains(r.shape, x, y));
}

/** The region whose edge is closest to (x, y). Shapes with no measurable geometry are skipped
 *  rather than winning by landing first, and so is a NaN coordinate. */
export function nearestRegionTo(
  regions: HitRegion[], x: number, y: number,
): { region: HitRegion; distance: number } | null {
  let best: { region: HitRegion; distance: number } | null = null;
  for (const r of regions) {
    const d = hitShapeDistance(r.shape, x, y);
    if (d === null || !Number.isFinite(d)) continue;
    if (!best || d < best.distance) best = { region: r, distance: d };
  }
  return best;
}

// ── Overlay visibility ───────────────────────────────────────────────────────────────────────
// A plain observable boolean rather than React state: the toggle is driven from THREE places (the
// debug menu, the agent op, and a game's own dev shortcut) and only one of them is inside React.

let overlayOn = false;
const listeners = new Set<() => void>();

export function isHitRegionOverlayVisible(): boolean {
  return overlayOn;
}

export function setHitRegionOverlayVisible(on: boolean): void {
  if (overlayOn === on) return;
  overlayOn = on;
  for (const fn of listeners) {
    try { fn(); } catch { /* one bad subscriber must not stop the others */ }
  }
}

export function subscribeHitRegionOverlay(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test-only: drop every provider, the duplicate-warning memory and the toggle. */
export function __resetHitRegionsForTests(): void {
  providers.clear();
  warnedDuplicates.clear();
  overlayOn = false;
  listeners.clear();
}
