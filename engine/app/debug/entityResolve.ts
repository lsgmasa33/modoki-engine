/** Entity point resolution — turn `{guid}`/`{name}`/`{id}` into viewport CSS coordinates, and
 *  report what is actually AT those coordinates (Enact: entity-aware input).
 *
 *  The third leg of aimed input. `domResolve.ts` covers editor chrome by CSS selector and the
 *  handle providers cover the canvas editors by handle id; both resolve INSIDE the call that
 *  dispatches, so nothing can move in between. Scene entities had no such path — the only way
 *  to tap one was to read `get_scene_state?bounds=1` in one round-trip and click those
 *  coordinates in the next, which is exactly the stale-aim race the other two exist to kill.
 *
 *  TWO PATHS, BY LAYER, because a UI entity and a mesh are different kinds of thing:
 *
 *  - **UI** entities ARE DOM nodes (`[data-entity-id]`), so this defers to the same
 *    `resolveElementPoint` / `occlusionAt` recipe the selector path uses. Identical semantics,
 *    including the zero-rect guard — deliberately NOT a second implementation, because
 *    `domResolve.ts`'s own header records what happened last time that recipe was copied.
 *  - **2D / 3D** entities are pixels in a canvas, so their rect comes from the registered
 *    bounds providers (`collectScreenBounds`, the same data `layout-bounds` reports) and the
 *    occlusion check can only see DOM-level covering. See `OcclusionScope` in the contract:
 *    a mesh in front of the target is NOT detected, and the response says so rather than
 *    implying a clean bill of health.
 *
 *  Everything is refused rather than approximated. Ambiguous name, off-screen entity, a centre
 *  outside the viewport — each returns an error, because the failure mode being designed out is
 *  a click that lands somewhere plausible and reports success. See
 *  `docs/enact.md` ("Aimed input has THREE target surfaces"). */

import { getAllEntities, collectScreenBounds, pickAt, type BoundsSurface } from '@modoki/engine/runtime';
import { describeElement, occlusionAt, resolveElementPoint } from './domResolve';
import { uiNodesFor, namedUiSurface } from './uiSurface';
import type { EntityPointSpec, EntityPointResolution, AimedAt } from './entityPointContract';

export type { EntityPointSpec, EntityPointResolution } from './entityPointContract';

/** Resolve the spec to exactly one entity, or say why not.
 *
 *  `guid` wins, then `name`, then `id` — cheapest-to-most-volatile. An ambiguous `name` is an
 *  ERROR, not a first-match: silently picking one of three entities called "Enemy" produces a
 *  successful-looking click on the wrong one, which is the entire class of bug this file exists
 *  to remove. */
function resolveEntity(spec: EntityPointSpec): { info: ReturnType<typeof getAllEntities>[number] } | { error: string } {
  const all = getAllEntities();
  if (spec.guid) {
    const hit = all.find((e) => e.guid === spec.guid);
    return hit ? { info: hit } : { error: `no entity with guid ${JSON.stringify(spec.guid)}` };
  }
  if (spec.name) {
    const hits = all.filter((e) => e.name === spec.name);
    if (hits.length === 0) return { error: `no entity named ${JSON.stringify(spec.name)}` };
    if (hits.length > 1) {
      const guids = hits.map((e) => e.guid || `id:${e.id}`).join(', ');
      return { error: `${hits.length} entities are named ${JSON.stringify(spec.name)} (${guids}) — address by guid` };
    }
    return { info: hits[0] };
  }
  if (typeof spec.id === 'number') {
    const hit = all.find((e) => e.id === spec.id);
    return hit ? { info: hit } : { error: `no entity with id ${spec.id}` };
  }
  return { error: 'provide an entity {guid} | {name} | {id}' };
}

// A UI entity's DOM node(s) come from `uiSurface.ts` — PLURAL, because the editor mounts a
// UIRenderer in both SceneView's preview frame and GameView, so each UI entity can have two live
// nodes. The old single-node `querySelector` here picked one by document order.

/** Is the aim point inside the window? A rect can overlap the viewport while its CENTRE sits
 *  outside it (a mostly-scrolled-off panel, a half-off-screen mesh). Clicking the centre then
 *  lands outside the window entirely — refused rather than clamped to an edge, because a clamp
 *  produces a successful-looking click on whatever happens to be at the border. */
function centreIsInWindow(x: number, y: number): boolean {
  if (typeof window === 'undefined') return true;
  return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
}

/** DOM-level occlusion for a canvas-rendered (2D/3D) entity. The entity has no node of its own,
 *  so the question this CAN answer is "does the click reach the rendering surface at all" — a
 *  panel, dialog, or overlay sitting on top. Anything inside a `<canvas>` counts as reaching it. */
function canvasOcclusionAt(x: number, y: number): string | null {
  const top = typeof document === 'undefined' ? null : document.elementFromPoint(x, y);
  if (!top) return 'nothing (clipped or off-window)';
  if (top.tagName === 'CANVAS' || top.closest('canvas')) return null;
  return describeElement(top) ?? 'nothing (clipped or off-window)';
}

/** Does `hitId` count as hitting `targetId`? Exact match, or the hit entity being a DESCENDANT
 *  of the target.
 *
 *  The descendant case is not a nicety. A model is routinely one parent entity with its parts as
 *  child entities, and a surface's picker answers with whichever part the ray actually struck —
 *  so requiring an exact id would call "I clicked the character" occluded by its own arm. Walks
 *  `parentId` (bounded by the entity count, so a cycle cannot hang the renderer). */
function hitCountsAsTarget(hitId: number, targetId: number, all: ReturnType<typeof getAllEntities>): boolean {
  if (hitId === targetId) return true;
  const byId = new Map(all.map((e) => [e.id, e]));
  let cur = byId.get(hitId);
  for (let guard = 0; cur && guard <= all.length; guard++) {
    if (cur.id === targetId) return true;
    if (!cur.parentId) return false;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** Points to try inside the projected rect, centre first.
 *
 *  Why sample at all: the aim point was the centre of the projected AABB, which for a torus, an
 *  L-shape, a crescent — any concave or hollow mesh — **is not on the entity at all**. Before a
 *  picker existed that silently missed, or hit whatever was behind. Now the centre is a
 *  HYPOTHESIS the picker checks, and this is the fallback search when it is wrong.
 *
 *  A coarse spiral-ish grid, deliberately small: this runs inside an input call, and every sample
 *  is a full pick against the live scene. `SAMPLE_GRID` × `SAMPLE_GRID` minus the centre, ordered
 *  by distance from the centre so the closest valid point wins — an aim point near the middle of
 *  the shape behaves more like a human click than a corner would. Insets by half a cell so no
 *  sample sits exactly on the rect edge, where a one-pixel projection error decides the answer. */
const SAMPLE_GRID = 5;
function* sampleAimPoints(x: number, y: number, w: number, h: number): Generator<{ x: number; y: number }> {
  yield { x, y };
  const pts: { x: number; y: number; d: number }[] = [];
  for (let r = 0; r < SAMPLE_GRID; r++) {
    for (let c = 0; c < SAMPLE_GRID; c++) {
      const px = x - w / 2 + (w * (c + 0.5)) / SAMPLE_GRID;
      const py = y - h / 2 + (h * (r + 0.5)) / SAMPLE_GRID;
      if (Math.abs(px - x) < 0.5 && Math.abs(py - y) < 0.5) continue; // that's the centre, already tried
      pts.push({ x: px, y: py, d: (px - x) ** 2 + (py - y) ** 2 });
    }
  }
  pts.sort((a, b) => a.d - b.d);
  for (const p of pts) yield { x: p.x, y: p.y };
}

/** Resolve an entity spec into a serializable report. Never throws — this runs in the renderer
 *  and travels back over the bridge as JSON, so a miss must be a RESULT (the host turns it into
 *  a 400). Mirrors `resolveDomPointReport`. */
export function resolveEntityPointReport(spec: EntityPointSpec): EntityPointResolution {
  const r = resolveEntity(spec ?? {});
  if ('error' in r) return { ok: false, error: r.error };
  const { info } = r;
  const entity = { id: info.id, name: info.name, guid: info.guid, layer: info.layer ?? null };
  const matched = `${info.name || '(unnamed)'}${info.guid ? ` [${info.guid}]` : ` (id:${info.id})`}`;
  const fail = (error: string): EntityPointResolution => ({ ok: false, error, entity, matched });

  // ── UI: the entity is a DOM node — reuse the selector path's recipe verbatim. ──
  if (info.layer === 'ui') {
    // NOT "a single DOM node" — that assumption is what made this branch aim blind. The editor
    // mounts a UIRenderer in BOTH SceneView's `[data-ui-preview-frame]` and GameView's
    // `[data-game-view-area]`, and every UINode stamps `data-entity-id`, so with both panels open
    // this entity has two live nodes. The old code took `querySelector`'s first match in document
    // order and reported success, so a tap meant for the running game could land in the SceneView
    // preview — and `surface` was REFUSED here, so the caller had no way to say which it meant.
    // Enumerate, label, and refuse the ambiguity, exactly as the 2D/3D branch below does.
    const nodes = uiNodesFor(info.id);
    if (nodes.length === 0) return fail(`entity ${matched} is a UI entity but has no rendered DOM node right now`);

    let chosen = nodes[0];
    if (nodes.length > 1) {
      const opts = [...new Set(nodes.map((n) => namedUiSurface(n.surface)))];
      if (!spec.surface) {
        return fail(
          `entity ${matched} is rendered in ${nodes.length} surfaces at once (${opts.join(', ')}) — ` +
          'the editor mounts a UI renderer in both the Scene panel\'s preview frame and the Game ' +
          `panel. Say which one to aim in: surface:'${opts[0]}'. (Aiming at whichever came first in ` +
          'the DOM would land in the other panel half the time, and report success.)',
        );
      }
      const wanted = nodes.filter((n) => namedUiSurface(n.surface) === spec.surface);
      if (wanted.length === 0) {
        return fail(`entity ${matched} has no DOM node in surface '${spec.surface}' — it is rendered in ${opts.join(', ')}`);
      }
      if (wanted.length > 1) {
        return fail(`entity ${matched} has ${wanted.length} DOM nodes in surface '${spec.surface}' — cannot choose between them`);
      }
      chosen = wanted[0];
    } else if (spec.surface && namedUiSurface(chosen.surface) !== spec.surface) {
      // Only one node, but the caller named a DIFFERENT surface: their belief about the layout is
      // wrong, so correct it rather than quietly aiming at the one that exists.
      return fail(
        `entity ${matched} is rendered only in '${namedUiSurface(chosen.surface)}', not in ` +
        `'${spec.surface}' — is that panel open?`,
      );
    }

    const el = chosen.el;
    const p = resolveElementPoint(el);
    if ('error' in p) return fail(`entity ${matched} ${p.error}`);
    if (!centreIsInWindow(p.x, p.y)) {
      return fail(`entity ${matched} centres at (${Math.round(p.x)}, ${Math.round(p.y)}), outside the window — scroll it into view first`);
    }
    const occludedBy = occlusionAt(el, p.x, p.y);
    return {
      ok: true, x: p.x, y: p.y, entity, matched,
      hitTarget: occludedBy ?? describeElement(el),
      occluded: occludedBy !== null,
      occlusionScope: 'element',
      // Echo which surface was actually aimed at, so a single-node aim is still checkable.
      surface: namedUiSurface(chosen.surface),
    };
  }

  // ── 2D / 3D: rect(s) from the registered bounds providers (the layout-bounds data). ──
  //
  // PLURAL on purpose. One entity can be measured by several providers at once — open the
  // editor's Scene and Game panels and every 3D entity has a rect in each, projected through a
  // different camera. This used to `.find()` the first and aim at it, i.e. pick one of two live
  // answers by Set iteration order; when it picked the panel that is not on top, the click
  // landed in the wrong viewport and still reported success. Measured on `games/3d-test`, one
  // entity: `{x:755,y:312,w:47,h:45}` (GameView) vs `{x:76,y:-63,w:496,h:372}` (SceneView),
  // both `onScreen`. So: label, choose deliberately, and REFUSE when the choice is not ours.
  const all = collectScreenBounds([info.id]).filter((b) => b.id === info.id);
  if (all.length === 0) {
    return fail(
      `entity ${matched} has no screen bounds — its layer (${info.layer ?? 'none'}) has no bounds ` +
      'provider mounted, or the entity has no renderable geometry',
    );
  }
  const named = (b: typeof all[number]) => b.surface ?? `unlabelled-${b.layer}`;

  // `surface` is REQUIRED for a 2D/3D aim — even when only one surface has the entity.
  //
  // Refusing only the AMBIGUOUS case (the first version of this) left the dangerous half open: a
  // single-surface aim SUCCEEDS without the caller ever stating which surface it meant, so there
  // is nothing to check the intent against. An agent that believed it was clicking the GameView,
  // while only the SceneView had the entity aimable, got a success and a wrong belief — and the
  // only record of the mismatch was a `surface` field in the response it had no reason to re-read.
  //
  // Requiring it converts that into a refusal that NAMES what is actually on screen, which
  // corrects the belief instead of confirming the wrong one. A refusal is not a confusion; it is
  // the good outcome. The extra parameter is the price of the call meaning the same thing
  // regardless of which panels the human happens to have open — see `docs/enact.md`.
  if (!spec.surface) {
    const opts = all.map(named);
    const uniq = [...new Set(opts)];
    return fail(
      `entity ${matched} is a ${info.layer ?? '2d/3d'} entity, so you must say WHICH on-screen ` +
      `surface to aim in: it is currently measured in ${uniq.map((n) => `'${n}'`).join(', ')}. ` +
      `Pass surface:'${uniq[0]}'. (Required even when there is only one, so a call cannot silently ` +
      'mean a different viewport than you intended when the layout changes.)',
    );
  }
  const wanted = all.filter((b) => named(b) === spec.surface);
  if (wanted.length === 0) {
    return fail(
      `entity ${matched} has no bounds in surface '${spec.surface}' — it is measured in ` +
      `${all.map(named).join(', ')}`,
    );
  }

  // Reasons are per-CANDIDATE: a rect can be aimable in one surface and off-screen in another,
  // so a single verdict would be a lie about one of them.
  const aimable: { b: typeof all[number]; x: number; y: number }[] = [];
  const rejected: string[] = [];
  for (const b of wanted) {
    if (!b.screen || b.screen.w === 0 || b.screen.h === 0) { rejected.push(`${named(b)}: zero-size rect`); continue; }
    if (!b.onScreen) { rejected.push(`${named(b)}: off-screen (behind the camera or outside the viewport)`); continue; }
    const cx = b.screen.x + b.screen.w / 2;
    const cy = b.screen.y + b.screen.h / 2;
    if (!centreIsInWindow(cx, cy)) {
      rejected.push(`${named(b)}: only partly visible — centre (${Math.round(cx)}, ${Math.round(cy)}) is outside the window`);
      continue;
    }
    aimable.push({ b, x: cx, y: cy });
  }
  if (aimable.length === 0) {
    return fail(
      `entity ${matched} has nothing aimable: ${rejected.join('; ')}. ` +
      'Move the camera to frame it first.',
    );
  }
  if (aimable.length > 1) {
    // Reachable only when ONE surface reports several rects for the entity — a Canvas2D host
    // mounted more than once inside the same surface, which `canvasId` distinguishes and `surface`
    // cannot. Refused with the canvasIds named, and WITHOUT telling the caller to pass a `surface`
    // it has already passed: an instruction that cannot work is worse than none. Adding a
    // `canvasId` selector is the fix if this is ever hit in practice — deliberately not built on
    // speculation. (Cross-SURFACE ambiguity can no longer reach here: `surface` is required above.)
    const opts = aimable
      .map((c) => `canvasId ${c.b.canvasId ?? '(none)'} at (${Math.round(c.x)}, ${Math.round(c.y)})`)
      .join(' | ');
    return fail(
      `entity ${matched} has ${aimable.length} aimable rects within surface '${spec.surface}' — ` +
      `${opts}. That means its Canvas2D host is mounted more than once in this surface, which ` +
      'nothing can currently disambiguate — aim at the host itself, or close the duplicate view.',
    );
  }
  const { b: bounds, x: cx, y: cy } = aimable[0];
  const surfaceName = named(bounds);

  // ── Ask the surface's own hit-test what a click here would actually select. ──
  //
  // `pickAt` has THREE answers and they must not be collapsed: an entity id, `null` (nothing
  // there), or `undefined` (no picker registered for this surface — the question was never
  // asked). Only the last one keeps the old `'canvas'` scope, and it is the normal case for the
  // runtime GameView, which ships no default picker on purpose (`screenPick.ts` header).
  const allEntities = getAllEntities();
  const rect = bounds.screen!;
  let x = cx;
  let y = cy;
  let aimedAt: AimedAt = 'centre';
  let samplesTried = 0;
  let found = false;
  let centreHit: number | null | undefined;   // the centre's verdict — what a failed search reports
  let pickHit: number | null | undefined;     // the verdict to report

  for (const p of sampleAimPoints(cx, cy, rect.w, rect.h)) {
    // Only the CENTRE is exempt from the window check — it was validated above. A sample can fall
    // outside the window when the rect straddles the edge, and clicking there is the very thing
    // `centreIsInWindow` exists to refuse.
    if (samplesTried > 0 && !centreIsInWindow(p.x, p.y)) continue;
    const hit = pickAt(surfaceName as BoundsSurface, p.x, p.y);
    samplesTried++;
    if (samplesTried === 1) centreHit = hit;
    if (hit === undefined) break;   // no picker on this surface — nothing to search with
    if (hit !== null && hitCountsAsTarget(hit, info.id, allEntities)) {
      x = p.x; y = p.y;
      aimedAt = samplesTried === 1 ? 'centre' : 'sampled';
      pickHit = hit;
      found = true;
      break;
    }
  }
  // A failed search reports the CENTRE's verdict, not the last sample's: "the wall is in front of
  // it" is the useful answer, where "sample #17 hit empty space" is noise.
  if (!found) pickHit = centreHit;

  const domOccludedBy = canvasOcclusionAt(x, y);

  // ── No picker on this surface: the honest pre-existing behaviour, unchanged. ──
  if (pickHit === undefined) {
    return {
      ok: true, x: cx, y: cy, entity, matched,
      surface: surfaceName,
      hitTarget: domOccludedBy ?? 'canvas',
      occluded: domOccludedBy !== null,
      occlusionScope: 'canvas',
    };
  }

  // ── A picker answered. `occluded` now means what it says. ──
  const blocker = pickHit === null || pickHit === undefined
    ? null
    : allEntities.find((e) => e.id === pickHit) ?? null;
  const blockerDesc = blocker
    ? `${blocker.name || '(unnamed)'}${blocker.guid ? ` [${blocker.guid}]` : ` (id:${blocker.id})`}`
    : 'nothing (empty space in the scene)';
  const occludedByEntity = blocker ? { id: blocker.id, name: blocker.name, guid: blocker.guid } : null;

  if (!found && !spec.allowOccluded) {
    // A REFUSAL, not a flag. `entity` aiming expresses intent about an ENTITY, so a click the
    // surface would not honour is a failed intent — dispatching it would land on the blocker (or
    // on nothing) and report success. Owner decision, 2026-07-29; `allowOccluded: true` is the
    // escape hatch and is named in the message so the capability is discoverable from the error.
    const searched = samplesTried > 1
      ? ` Tried ${samplesTried} points across its projected rect (centre first); none of them picked it.`
      : '';
    return fail(
      `entity ${matched} is not clickable in '${surfaceName}': a click at its aim point selects ` +
      `${blockerDesc}, not it.${searched} This surface's own hit-test was asked, so this is what a ` +
      'real click would do — the entity is behind something, or its clickable geometry is not ' +
      'where its bounds say. Pass allowOccluded:true to click anyway and see what happens.',
    );
  }

  return {
    ok: true, x, y, entity, matched,
    surface: surfaceName,
    // The DOM check still runs and still wins the `hitTarget` slot when a PANEL covers the canvas:
    // the picker predicts what the canvas would do with a click, but a dialog on top means the
    // canvas never receives one. Two different occluders, both real.
    hitTarget: domOccludedBy ?? (found ? 'canvas' : `canvas (entity: ${blockerDesc})`),
    occluded: !found || domOccludedBy !== null,
    occlusionScope: 'entity',
    occludedByEntity: found ? null : occludedByEntity,
    aimedAt,
    ...(samplesTried > 1 ? { samplesTried } : {}),
  };
}
