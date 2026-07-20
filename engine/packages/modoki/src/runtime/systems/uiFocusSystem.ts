/** uiFocusSystem — drives UI focus from the `Input` resource (Part B3 of the
 *  input-and-ui-focus plan). App-pipeline, GAME tier: it runs only while the sim is
 *  playing (menus are part of the running game), after `inputSystem` has written the
 *  frame's edges. Each tick:
 *    - gather focusable candidates in the active scope,
 *    - ensure something is focused (autofocus if not),
 *    - nav edges (navUp/Down/Left/Right) → move focus (explicit link, else spatial),
 *    - confirm edge → QUEUE activation (drained outside the tick — see focusManager),
 *    - cancel edge → pop the active scope.
 *
 *  It reads only plain data — the `Input` resource, ECS traits, on-screen rects from
 *  the shared bounds providers (empty headless → spatial nav no-ops, explicit links +
 *  autofocus still work), and the Zustand focus store — so it is deterministic and
 *  harness-safe (a test registers it, sets `Input`, and asserts focus + journal). No
 *  wall-clock, no RNG, no DOM input reads. */

import type { World } from 'koota';
import { EntityAttributes } from '../traits/EntityAttributes';
import { UIElement } from '../traits/UIElement';
import { UIFocusable } from '../traits/UIFocusable';
import { pressed } from '../traits/Input';
import {
  useFocusStore, activeScope, setFocus, requestActivate, popScope,
  pickInDirection, ensureFocusWorldSwapHook, type NavDir,
} from '../ui/focusManager';
import { collectScreenBounds, type ScreenRect } from '../rendering/screenBounds';

interface Candidate {
  guid: string;
  entityId: number;
  order: number;
  scope: string;
  autoFocus: boolean;
  nav: Record<NavDir, string>;
}

/** Collect focusable candidates (EFFECTIVELY visible, focusable, with a stable GUID).
 *
 *  Visibility must be ancestor-inclusive: the canonical hide pattern sets
 *  `UIElement.isVisible=false` on a PANEL container while its children stay visible,
 *  and `UINode` prunes the whole subtree at the first hidden node — so a child of a
 *  hidden parent is NOT rendered and must NOT be focusable/activatable. We build a
 *  self-visibility + parent map from ECS (query-based → headless-safe) and walk each
 *  candidate's parent chain, matching the renderer's prune. */
function gatherCandidates(world: World): Candidate[] {
  // id → { parent entityId, own visibility } for every EntityAttributes entity.
  const meta = new Map<number, { parent: number; visible: boolean }>();
  world.query(EntityAttributes).updateEach(([attr]: any[], entity: any) => {
    let visible = true;
    if (entity.has(UIElement)) visible = (entity.get(UIElement) as { isVisible: boolean }).isVisible !== false;
    meta.set(entity.id(), { parent: (attr.parentId as number) || 0, visible });
  });
  // Visible iff this node AND every ancestor is visible. Cycle-guarded.
  const effectivelyVisible = (id: number): boolean => {
    let cur = id;
    let guard = meta.size + 1;
    while (cur && guard-- > 0) {
      const m = meta.get(cur);
      if (!m) break; // parent not tracked → treat the chain above as visible
      if (!m.visible) return false;
      cur = m.parent;
    }
    return true;
  };

  const out: Candidate[] = [];
  world.query(UIFocusable, EntityAttributes).updateEach(([f, attr]: any[], entity: any) => {
    if (!f.focusable) return;
    const guid = attr.guid as string;
    if (!guid) return; // GUID-addressed; unsaved entities aren't navigable targets
    if (!effectivelyVisible(entity.id())) return; // hidden self OR hidden ancestor
    out.push({
      guid, entityId: entity.id(), order: f.focusOrder ?? 0, scope: f.focusScope || '',
      autoFocus: !!f.autoFocus,
      nav: { up: f.navUp || '', down: f.navDown || '', left: f.navLeft || '', right: f.navRight || '' },
    });
  });
  return out;
}

/** The default focus target for a scope: the autoFocus one (lowest order wins), else
 *  the lowest-order candidate overall. */
function pickAutoFocus(scoped: Candidate[]): string {
  if (scoped.length === 0) return '';
  const ordered = [...scoped].sort((a, b) => a.order - b.order);
  const auto = ordered.find((c) => c.autoFocus);
  return (auto ?? ordered[0]).guid;
}

/** Resolve a directional move from `fromGuid`: explicit authored link first, else the
 *  spatially nearest scoped candidate in `dir` using on-screen rects. Returns the new
 *  focus GUID, or '' if there's nowhere to go. */
function resolveNav(fromGuid: string, dir: NavDir, scoped: Candidate[]): string {
  const from = scoped.find((c) => c.guid === fromGuid);
  if (!from) return '';

  // 1. Explicit hand-authored link (only if it points at a live scoped candidate).
  const linked = from.nav[dir];
  if (linked && scoped.some((c) => c.guid === linked)) return linked;

  // 2. Spatial: nearest-in-direction by on-screen rect. Needs rects from the bounds
  //    providers; absent (headless) → no spatial move.
  const byId = new Map<number, ScreenRect>();
  for (const b of collectScreenBounds()) if (b.screen) byId.set(b.id, b.screen);
  const fromRect = byId.get(from.entityId);
  if (!fromRect) return '';
  const cands = scoped
    .filter((c) => c.guid !== fromGuid && byId.has(c.entityId))
    .map((c) => ({ guid: c.guid, rect: byId.get(c.entityId)! }));
  return pickInDirection(fromRect, cands, dir) ?? '';
}

const NAV: { action: 'navUp' | 'navDown' | 'navLeft' | 'navRight'; dir: NavDir }[] = [
  { action: 'navUp', dir: 'up' },
  { action: 'navDown', dir: 'down' },
  { action: 'navLeft', dir: 'left' },
  { action: 'navRight', dir: 'right' },
];

export function uiFocusSystem(world: World): void {
  ensureFocusWorldSwapHook(); // install the scene-swap focus reset once (app-side)
  const candidates = gatherCandidates(world);
  const scope = activeScope();
  const scoped = candidates.filter((c) => c.scope === scope);

  // Ensure a valid focus for the active scope.
  let focused = useFocusStore.getState().focusedGuid;
  if (!focused || !scoped.some((c) => c.guid === focused)) {
    focused = pickAutoFocus(scoped);
    setFocus(focused);
  }
  if (!focused) return; // nothing focusable in this scope

  // cancel: pop the scope (back out of a modal). Consumes the edge before nav so a
  // single press doesn't also move focus.
  if (pressed(world, 'cancel')) {
    if (popScope()) return;
  }

  // nav: first pressed direction wins this frame (avoids a diagonal double-move).
  for (const { action, dir } of NAV) {
    if (!pressed(world, action)) continue;
    const next = resolveNav(focused, dir, scoped);
    if (next) { setFocus(next); focused = next; }
    break;
  }

  // confirm: queue the focused element's click bindings (fired outside the tick).
  if (pressed(world, 'confirm')) requestActivate(focused);
}
