/** Is every on-screen control that carries an action COVERED at its hit point? (#1418)
 *
 *  #1406's gate (`actionControlOnScreen`) refuses an agent dispatch when every carrier is HIDDEN.
 *  A carrier can also be shown and still unreachable: an always-drawn HUD button under a full-screen
 *  modal. A player's tap lands on the modal; an agent's dispatch ran the handler anyway — measured
 *  in Wordweave, where `wordweave.dictionaryOpen` opened the Dictionary UNDER the open Settings.
 *
 *  This asks the question a tap answers: hit-test the carrier's DOM node at its centre with the
 *  bridge's own occlusion test (`coveringElementAt`, the recipe `modoki_tap`'s refusal uses), so the
 *  gate and a real press agree by construction — including `pointer-events: none` pass-through and
 *  the `minTapSize` tap-zone redirect. A carrier is always a DOM `ui` node (the gate queries
 *  `UIAction + UIElement`; nothing on the 2D/3D layers carries a registry action), so the canvas
 *  branches of the occlusion test are not needed here.
 *
 *  ⚠️ **It refuses only on a POSITIVE observation, and fails open everywhere else.** The DOM shows
 *  the LAST render, so a carrier the agent showed this turn has no node yet, and a modal it opened
 *  this turn is not drawn yet — both read as "cannot judge", and the dispatch runs as it did before.
 *  Likewise a zero rect, a centre outside the window or outside a scrolling ancestor's clip (a
 *  player could scroll to it), and no document at all (headless tests, a worker).
 *
 *  ⚠️ **Only a cover inside the game's own UI host counts.** In the editor the Game panel can sit
 *  under editor chrome — a menu, a floating panel — and that is the editor's state, not the game's;
 *  refusing on it would block a dispatch the player could make. A shipped game has no host marker,
 *  so there any cover counts. Where the editor mounts the entity twice (SceneView's preview and the
 *  Game panel), the Game panel's node is the one judged: that is the running game. */

import type { World } from 'koota';
import { EntityAttributes, uiEntityShownNow } from '@modoki/engine/runtime';
import { coveringElementAt, describeOccluder, resolveElementPoint, withinClip } from './domResolve';
import { uiNodesFor, UI_SURFACE_SCENE_VIEW } from './uiSurface';

export interface CarrierCover {
  carrier: string;
  /** What sits over the carrier's centre — the covering UI entity's name where it is one. */
  coveredBy: string;
}

/** The game UI host a node lives in — the element a counted cover must be inside. `null` for a
 *  shipped game (no editor host), where the whole document is the game. */
function gameHostOf(el: Element): Element | null {
  return el.closest('[data-game-view-area]');
}

/** Which UI entity is REALLY covering, judged against the ECS now.
 *
 *  ⚠️ The DOM is the LAST render, so the element on top may belong to an entity the agent hid or
 *  closed this frame — and a player's tap one frame later would not land on it (measured live:
 *  settingsClose then dictionaryOpen in one modoki_batch was refused as "under SettingsPanel").
 *  So walk the `[data-entity-id]` ancestors OUTWARD and take the first entity the ECS still shows.
 *  ⚠️ Outward, not just the innermost (close-out review): a child hidden this frame inside a modal
 *  that stays up must not fail the check open — the modal is still the cover.
 *  ⚠️ But the walk STOPS at an ancestor of the carrier itself (close-out review 2): that entity is
 *  shown by construction (the carrier is), and it cannot be what sits over its own descendant.
 *  Without the stop, an overlay closed this frame inside the carrier's own HUD root was reported
 *  as covered "under HUD Root" — the false refusal the walk exists to prevent.
 *
 *  - `{ id }` — a shown entity covers the carrier.
 *  - `'stale'` — every entity around the top element is gone from view: cannot judge.
 *  - `{ id: null }` — no UI entity of its own covers: the top element is engine/editor overlay DOM
 *    inside the host (e.g. the debug menu), or it is the carrier's shared ancestor's OWN drawing.
 *    Either is drawn now, so it counts (named from the DOM).
 *
 *  Not handled: `data-entity-id` carries koota's bare id with no generation, so a cover destroyed
 *  this frame whose id is at once reused by a new shown entity reads as covered. That errs toward
 *  refusing, and needs a generation stamp in the DOM to fix. */
function coveringEntity(world: World, top: Element, carrierEl: Element): { id: number | null } | 'stale' {
  let sawEntity = false;
  for (let el = top.closest('[data-entity-id]'); el; el = el.parentElement?.closest('[data-entity-id]') ?? null) {
    if (el.contains(carrierEl)) break; // the carrier's own ancestor — shown, and not over it
    const id = Number(el.getAttribute('data-entity-id'));
    if (!Number.isFinite(id) || id <= 0) continue;
    sawEntity = true;
    if (uiEntityShownNow(world, id)) return { id };
  }
  return sawEntity ? 'stale' : { id: null };
}

/** Name the cover by its UI entity — what an agent can act on (close THAT modal). A modal root is a
 *  style-only div, which `describeOccluder` alone names as `div inside div.flexlayout__tab_moveable`
 *  (measured on Wordweave's SettingsRoot). */
function nameCover(world: World, id: number | null, top: Element): string {
  if (id !== null) {
    let name: string | undefined;
    world.query(EntityAttributes).updateEach(([attr]: any[], entity: any) => {
      if (entity.id() === id) name = (attr.name as string) || (attr.guid as string) || undefined;
    });
    if (name) return name;
  }
  return describeOccluder(top) ?? 'something';
}

/** One carrier's verdict: its cover, or `null` when it is reachable OR cannot be judged. */
function coverOf(world: World, carrier: { id: number; name: string }): CarrierCover | null {
  const nodes = uiNodesFor(carrier.id);
  // The Game panel's node (or a shipped game's unlabelled one) — never SceneView's preview copy.
  const node = nodes.find((n) => n.surface !== UI_SURFACE_SCENE_VIEW);
  if (!node) return null; // not rendered yet, or only in the SceneView preview
  const p = resolveElementPoint(node.el);
  if ('error' in p) return null;
  if (p.x < 0 || p.y < 0 || p.x > window.innerWidth || p.y > window.innerHeight) return null;
  if (!withinClip(node.el, p.x, p.y)) return null;
  const top = coveringElementAt(node.el, p.x, p.y, 'tap');
  if (!top) return null; // cleanly hit (undefined), or nothing at the point at all (null)
  const host = gameHostOf(node.el);
  if (host && !host.contains(top)) return null; // editor chrome over the Game panel
  const cover = coveringEntity(world, top, node.el);
  if (cover === 'stale') return null; // closed this frame — fails open like every other stale read
  return { carrier: carrier.name, coveredBy: nameCover(world, cover.id, top) };
}

/** Every shown carrier's cover when ALL of them are covered, else `null` (one reachable carrier —
 *  or one the DOM cannot judge — is enough for a player to press the action). */
export function coveredCarriers(world: World, shown: ReadonlyArray<{ id: number; name: string }>): CarrierCover[] | null {
  // jsdom implements no hit test; a missing one cannot judge anything (and must not throw a verdict
  // into a transport error).
  if (shown.length === 0 || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
  const covers: CarrierCover[] = [];
  for (const carrier of shown) {
    const cover = coverOf(world, carrier);
    if (!cover) return null;
    covers.push(cover);
  }
  return covers;
}
