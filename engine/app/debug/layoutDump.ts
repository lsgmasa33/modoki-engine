/** layout-bounds agent op — numeric screen-space layout so Claude can reason about
 *  position / overlap / clipping WITHOUT a screenshot (it's weak at judging pixels).
 *
 *  - UI: real DOM `getBoundingClientRect()` per `[data-entity-id]` (true flexbox
 *    layout, at any nesting depth).
 *  - 2D / 3D: the registered bounds providers (Scene2D PixiJS bounds → CSS;
 *    Scene3D world-AABB projected through the game camera → CSS).
 *  All rects are viewport CSS px (one frame), so layers are directly comparable.
 *
 *  Derived signals: same-layer overlapping pairs (EXCLUDING ancestor/descendant —
 *  a child inside its parent isn't an "overlap") and the off-screen id list.
 *
 *  SIZE: an untargeted call returns COUNTS (+ the cheap offScreen/zeroSize id lists), not the
 *  per-entity rects and not the overlapping pairs. Returning both made this the largest payload
 *  in the whole agent surface — ~74k tokens on a 241-entity scene, of which the O(n²) pair list
 *  alone was more than every rect combined. Ask for what you need: `ids`/`layer` for rects,
 *  `overlaps:true` for the pairs. See `docs/mcp-response-budget.md` Phase 4. */

import { getAllEntities, collectScreenBounds, type ScreenRect } from '@modoki/engine/runtime';

export interface LayoutEntry {
  id: number;
  name: string;
  layer: string | null;
  screen: ScreenRect | null;
  onScreen: boolean;
  zeroSize: boolean;
  /** World-space AABB (3D only) — true geometric extent in world units (V5). */
  worldAABB?: { size: [number, number, number]; center: [number, number, number] };
}

export interface LayoutBoundsParams {
  layer?: 'ui' | '2d' | '3d';
  ids?: number[];
  /** Materialize the overlapping-pair list. Default false: the pairs are O(n²) in COUNT and
   *  were the single largest thing this op ever returned (2,625 pairs / ~105k chars on a
   *  241-entity scene — more than all the rects combined). The COUNT is always reported. */
  overlaps?: boolean;
  /** Force-include the per-entity rect list. Implied by `ids`/`layer` (asking for a subset is
   *  asking for its rects). Default false on an untargeted call — counts only. */
  entities?: boolean;
  /** Cap the returned `entities[]`; sets `truncated` + `totalCount`. Without this, `layer=3d` on
   *  a real scene returns every rect (230 on the reference project) with no way to narrow — a
   *  drill-down that dead-ends is the same trap as an unbounded default. */
  limit?: number;
}

function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function computeLayoutBounds(params: LayoutBoundsParams = {}) {
  const { layer, ids } = params;
  const want = ids && ids.length ? new Set(ids) : null;
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e] as const));
  const entries: LayoutEntry[] = [];

  // ── UI — true DOM rects (flexbox-accurate, any depth) ──
  if ((!layer || layer === 'ui') && typeof document !== 'undefined') {
    document.querySelectorAll('[data-entity-id]').forEach((el) => {
      const id = Number(el.getAttribute('data-entity-id'));
      if (!Number.isFinite(id) || (want && !want.has(id))) return;
      const info = byId.get(id);
      if (!info || info.layer !== 'ui') return; // only ui-layer DOM nodes (skip the 2D canvas host etc.)
      const r = (el as HTMLElement).getBoundingClientRect();
      entries.push({
        id, name: info.name, layer: 'ui',
        screen: { x: r.left, y: r.top, w: r.width, h: r.height },
        onScreen: r.width > 0 && r.height > 0,
        zeroSize: r.width === 0 || r.height === 0,
      });
    });
  }

  // ── 2D + 3D — from the registered bounds providers ──
  if (!layer || layer === '2d' || layer === '3d') {
    for (const b of collectScreenBounds(ids)) {
      if (layer && b.layer !== layer) continue;
      const info = byId.get(b.id);
      entries.push({
        id: b.id, name: info?.name ?? '', layer: b.layer,
        screen: b.screen, onScreen: b.onScreen,
        zeroSize: !b.screen || b.screen.w === 0 || b.screen.h === 0,
        ...(b.worldAABB ? { worldAABB: b.worldAABB } : {}),
      });
    }
  }

  // ── Derived: unexpected overlaps + off-screen ──
  const isAncestor = (ancestor: number, node: number): boolean => {
    let cur = byId.get(node);
    let guard = 0;
    while (cur && cur.parentId && guard++ < 128) { // guard: deep (10–20+) but bounded hierarchies
      if (cur.parentId === ancestor) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  };
  // Always COUNT the overlapping pairs (cheap); only materialize the pair objects when asked.
  // Serializing them is what cost ~105k chars, not finding them.
  const overlaps: { a: number; b: number; layer: string }[] = [];
  let overlapsCount = 0;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const A = entries[i], B = entries[j];
      if (A.layer !== B.layer || !A.screen || !B.screen) continue;
      if (isAncestor(A.id, B.id) || isAncestor(B.id, A.id)) continue; // nested ≠ overlap
      if (!rectsIntersect(A.screen, B.screen)) continue;
      overlapsCount++;
      if (params.overlaps) overlaps.push({ a: A.id, b: B.id, layer: A.layer! });
    }
  }
  // `offScreen` (ids) is ALWAYS returned: it is cheap, and `diagnose.ts` calls this with no
  // params and reads `.offScreen.length`. Dropping it for a count would break modoki_diagnose
  // in the field long before a test noticed. Same reasoning for `zeroSize`.
  const offScreen = entries.filter((e) => !e.onScreen).map((e) => e.id);
  const zeroSize = entries.filter((e) => e.zeroSize).map((e) => e.id);

  const layerCounts: Record<string, number> = {};
  for (const e of entries) layerCounts[e.layer ?? 'null'] = (layerCounts[e.layer ?? 'null'] ?? 0) + 1;

  // Asking for a subset (ids/layer) is asking for its rects; an untargeted call gets counts.
  const wantEntities = params.entities || !!ids?.length || !!layer;
  // `slice(-0)`-style traps do not apply here (we take a prefix, not a tail), but a NaN limit
  // must not disable the cap: `entries.length > NaN` is false.
  const lim = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : undefined;
  const shown = lim != null && entries.length > lim ? entries.slice(0, Math.max(0, lim)) : entries;
  const entitiesTruncated = wantEntities && lim != null && entries.length > lim;
  const hint = !wantEntities || !params.overlaps
    ? `Counts only where omitted. Pass ids=[…] or layer=ui|2d|3d for per-entity rects; overlaps=true for the ${overlapsCount} overlapping pairs.`
    : undefined;

  return {
    count: entries.length,
    layerCounts,
    offScreen,
    offScreenCount: offScreen.length,
    zeroSize,
    zeroSizeCount: zeroSize.length,
    overlapsCount,
    ...(wantEntities ? { entities: shown } : {}),
    ...(entitiesTruncated ? { truncated: true, totalCount: entries.length } : {}),
    ...(params.overlaps ? { overlaps } : {}),
    ...(hint ? { hint } : {}),
  };
}
