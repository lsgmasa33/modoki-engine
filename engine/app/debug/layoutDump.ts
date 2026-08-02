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
import { uiSurfaceOf } from './uiSurface';

export interface LayoutEntry {
  id: number;
  name: string;
  layer: string | null;
  screen: ScreenRect | null;
  onScreen: boolean;
  zeroSize: boolean;
  /** World-space AABB (3D only) — true geometric extent in world units (V5). */
  worldAABB?: { size: [number, number, number]; center: [number, number, number] };
  /** Which on-screen surface measured this rect ('game-3d' | 'game-2d' | 'scene-view' | 'game-ui'). The
   *  reason a single entity can appear TWICE in `entities[]`: with the editor's Scene and Game
   *  panels both open, two providers measure every 3D entity through different cameras. Without
   *  this label those two rows are indistinguishable, so a reader picking "the" rect for an id
   *  was picking blind. Set for UI rects too: the DOM is NOT one surface — the editor mounts a
   *  UIRenderer in both SceneView's preview frame and GameView. Omitted only when the node is in
   *  neither known host (a shipped game), which is genuinely unlabelled rather than guessed. */
  surface?: string;
  /** 2D only: the Canvas2D host entity these bounds were measured against. */
  canvasId?: number;
}

export interface LayoutBoundsParams {
  layer?: 'ui' | '2d' | '3d';
  /** Runtime ids. VOLATILE — reassigned on every scene hot-reload; prefer `guids`/`name`. */
  ids?: number[];
  /** Stable guids — the addressing every other Percept tool takes, and the only kind that
   *  survives a reload. This tool used to accept ONLY `ids`, so it was the one read whose target
   *  could go stale between two calls in the same turn. */
  guids?: string[];
  /** Entities whose NAME contains this (case-insensitive) — the same filter as scene-state. */
  name?: string;
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
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e] as const));
  // Resolve guids/name to ids up front so the rest of the function keeps working in ids. An
  // address that resolves to NOTHING is echoed back as `unresolved` rather than silently
  // narrowing to an empty answer — a stale id used to read exactly like "this entity has no
  // on-screen rect", which is the opposite conclusion from "that id no longer exists".
  const unresolved: Array<string | number> = [];
  const fromGuids: number[] = [];
  for (const g of params.guids ?? []) {
    const hit = all.find((e) => (e as { guid?: string }).guid === g);
    if (hit) fromGuids.push(hit.id); else unresolved.push(g);
  }
  const fromName = params.name
    ? all.filter((e) => (e.name ?? '').toLowerCase().includes(params.name!.toLowerCase())).map((e) => e.id)
    : [];
  if (params.name && fromName.length === 0) unresolved.push(params.name);
  for (const i of ids ?? []) if (!byId.has(i)) unresolved.push(i);
  const targeted = [...(ids ?? []), ...fromGuids, ...fromName];
  // A caller that TARGETED and matched nothing must get an EMPTY result, not the whole scene.
  // `targeted.length ? … : null` silently widened a stale-guid query back to every entity — so
  // asking about one entity and receiving 200 rects read as "here it is, among others", which is
  // the same silent-widening class as a dropped filter.
  const didTarget = !!(ids?.length || params.guids?.length || params.name);
  const want = targeted.length ? new Set(targeted) : (didTarget ? new Set<number>() : null);
  const entries: LayoutEntry[] = [];

  // ── UI — true DOM rects (flexbox-accurate, any depth) ──
  if ((!layer || layer === 'ui') && typeof document !== 'undefined') {
    document.querySelectorAll('[data-entity-id]').forEach((el) => {
      const id = Number(el.getAttribute('data-entity-id'));
      if (!Number.isFinite(id) || (want && !want.has(id))) return;
      const info = byId.get(id);
      if (!info || info.layer !== 'ui') return; // only ui-layer DOM nodes (skip the 2D canvas host etc.)
      const r = (el as HTMLElement).getBoundingClientRect();
      // LABEL the surface (independent review, 2026-07-30). The editor mounts a UIRenderer in both
      // SceneView's preview frame and GameView, so a UI entity can have two rects here. Leaving
      // `surface` undefined made `agentBridge`'s dedupe keep the LAST rect and record NO
      // `otherSurfaces` (it only records them when the previous entry HAS a surface) — silently
      // reinstating the "keep one, drop the rest" behaviour the comment above that dedupe claims
      // to have fixed. It also left `perSurface` false, so `computeLayoutBounds` double-counted
      // with no explanation.
      const surface = uiSurfaceOf(el);
      entries.push({
        id, name: info.name, layer: 'ui',
        screen: { x: r.left, y: r.top, w: r.width, h: r.height },
        onScreen: r.width > 0 && r.height > 0,
        zeroSize: r.width === 0 || r.height === 0,
        ...(surface ? { surface } : {}),
      });
    });
  }

  // ── 2D + 3D — from the registered bounds providers ──
  if (!layer || layer === '2d' || layer === '3d') {
    for (const b of collectScreenBounds(want ? [...want] : undefined)) {
      if (want && !want.has(b.id)) continue;
      if (layer && b.layer !== layer) continue;
      const info = byId.get(b.id);
      entries.push({
        id: b.id, name: info?.name ?? '', layer: b.layer,
        screen: b.screen, onScreen: b.onScreen,
        zeroSize: !b.screen || b.screen.w === 0 || b.screen.h === 0,
        ...(b.worldAABB ? { worldAABB: b.worldAABB } : {}),
        ...(b.surface ? { surface: b.surface } : {}),
        ...(b.canvasId !== undefined ? { canvasId: b.canvasId } : {}),
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
  // Asking for a SUBSET is asking for its rects — true for guids/name exactly as it is for ids and
  // layer. Without this, `guids=[…]` returned counts while the hint told the caller to pass guids
  // to get rects: a parameter that does not change the answer in the way its own docs promise.
  const wantEntities = params.entities || !!ids?.length || !!layer || !!params.guids?.length || !!params.name;
  // `slice(-0)`-style traps do not apply here (we take a prefix, not a tail), but a NaN limit
  // must not disable the cap: `entries.length > NaN` is false.
  const lim = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : undefined;
  const shown = lim != null && entries.length > lim ? entries.slice(0, Math.max(0, lim)) : entries;
  const entitiesTruncated = wantEntities && lim != null && entries.length > lim;
  const hint = !wantEntities || !params.overlaps
    ? `Counts only where omitted. Pass guids=[…] (stable) / name=<substr> / ids=[…] or layer=ui|2d|3d for per-entity rects; overlaps=true for the ${overlapsCount} overlapping pairs.`
    : undefined;

  // Every 3D entity is measured once PER MOUNTED SURFACE (the Scene panel and the Game panel each
  // have their own camera), so with both open the counts are inflated — roughly doubled — and
  // `count`/`offScreenCount`/`zeroSizeCount` read as "the scene has twice as many things". Report
  // the DISTINCT entity count alongside, and name the surfaces, so the number is interpretable
  // instead of merely large. (S2.16)
  const distinctIds = new Set(entries.map((e) => e.id));
  const surfaces = [...new Set(entries.map((e) => (e as { surface?: string }).surface).filter(Boolean))] as string[];
  const perSurface = surfaces.length > 1;

  return {
    count: entries.length,
    /** Distinct ENTITIES behind `count`. Differs whenever more than one viewport is mounted. */
    entityCount: distinctIds.size,
    ...(perSurface ? {
      surfaces,
      surfaceNote:
        `${surfaces.length} viewports are mounted (${surfaces.join(', ')}), and each measures every 3D ` +
        `entity through its OWN camera — so \`count\` (${entries.length}) counts RECTS, not entities ` +
        `(${distinctIds.size}). There is no surface FILTER: layer= cannot separate them (both are ` +
        `layer:'3d') and targeting still returns one rect per viewport. Read \`surface\` on each ` +
        `entry to tell them apart, and use \`entityCount\` wherever you meant "how many entities".`,
    } : {}),
    ...(unresolved.length ? {
      unresolved,
      unresolvedNote: 'These addresses matched no live entity — an empty rect list for them means NOT FOUND, not "off screen". Runtime ids are reassigned on every scene reload; prefer guids.',
    } : {}),
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
