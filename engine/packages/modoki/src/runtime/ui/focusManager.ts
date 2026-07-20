/** focusManager — the UI focus state + directional resolution for controller/keyboard
 *  navigation (Part B of the input-and-ui-focus plan).
 *
 *  State lives in a Zustand store so `UINode` re-renders its focus ring reactively (no
 *  per-frame polling — matches the dirty-flag `uiTreeProjection` pattern). `uiFocusSystem`
 *  reads the `Input` resource and calls the mutators here; `UINode` subscribes to
 *  `focusedGuid`; `UIRenderer` (or a headless test) drains `pendingActivateGuid`.
 *
 *  ACTIVATION IS DEFERRED ON PURPOSE. `applyBindings` must run from an event context,
 *  never a pipeline tick (its `call` path throws in dev — see bindings.ts F10). So a
 *  "confirm" does NOT fire bindings inside the system tick: `uiFocusSystem` sets
 *  `pendingActivateGuid`, and `consumePendingActivation` (called from the `UIRenderer`
 *  effect or a test) runs the SAME `applyBindings(bindings, 'click', …)` a DOM tap runs.
 *
 *  Pure data + pure functions (no wall-clock, no RNG) → determinism-guard-safe; the
 *  spatial resolver is unit-testable with injected rects. */

import { create } from 'zustand';
import type { World } from 'koota';
import { onWorldSwap, findEntityByGuid } from '../ecs/world';
import { UIAction } from '../traits/UIAction';
import { applyBindings, type UIActionBinding } from './bindings';
import type { ScreenRect } from '../rendering/screenBounds';

export type NavDir = 'up' | 'down' | 'left' | 'right';

interface FocusState {
  /** GUID of the currently focused element in the active scope ('' = none). */
  focusedGuid: string;
  /** Scope stack; top = active scope. Default single '' scope. */
  scopeStack: string[];
  /** GUID whose `click` bindings a deferred activation should fire ('' = none). */
  pendingActivateGuid: string;
}

export const useFocusStore = create<FocusState>(() => ({
  focusedGuid: '',
  scopeStack: [''],
  pendingActivateGuid: '',
}));

// ── Reads ──────────────────────────────────────────────────────────────────────

/** The active scope (top of the stack). */
export function activeScope(): string {
  const s = useFocusStore.getState().scopeStack;
  return s[s.length - 1] ?? '';
}
export function focusedGuid(): string { return useFocusStore.getState().focusedGuid; }

// ── Mutators ─────────────────────────────────────────────────────────────────

/** Set the focused element. No-op if already focused (avoids a needless store write
 *  / re-render each frame). */
export function setFocus(guid: string): void {
  if (useFocusStore.getState().focusedGuid !== guid) useFocusStore.setState({ focusedGuid: guid });
}

/** Push a new focus scope (e.g. a modal opens). Focus is cleared so the scope's
 *  autofocus lands on the next `uiFocusSystem` tick. */
export function pushScope(scope: string): void {
  useFocusStore.setState((s) => ({ scopeStack: [...s.scopeStack, scope], focusedGuid: '' }));
}

/** Pop the active scope (e.g. a modal closes). Never pops the base '' scope. Focus is
 *  cleared so the revealed scope re-autofocuses. Returns whether a pop happened. */
export function popScope(): boolean {
  const s = useFocusStore.getState().scopeStack;
  if (s.length <= 1) return false;
  useFocusStore.setState({ scopeStack: s.slice(0, -1), focusedGuid: '' });
  return true;
}

/** Queue the focused element for activation (drained outside the tick). */
export function requestActivate(guid: string): void {
  if (guid) useFocusStore.setState({ pendingActivateGuid: guid });
}

/** Reset ALL focus state — used on world/scene swap and in test teardown. */
export function resetFocus(): void {
  useFocusStore.setState({ focusedGuid: '', scopeStack: [''], pendingActivateGuid: '' });
}

// ── Deferred activation (event-context only, NOT a pipeline tick) ───────────────

/** Fire the focused element's `click` bindings — the SAME path a tap runs. Reads the
 *  entity's UIAction off ECS so no UI-tree reference is needed. Idempotent: it clears
 *  `pendingActivateGuid` first (reads the live store value, not a captured one), so two
 *  UIRenderers draining in the same tick activate exactly once. Returns the activated
 *  GUID, or null if nothing was pending / the entity is gone. */
export function consumePendingActivation(world: World): string | null {
  const guid = useFocusStore.getState().pendingActivateGuid;
  if (!guid) return null;
  useFocusStore.setState({ pendingActivateGuid: '' });
  const entity = findEntityByGuid(guid, world);
  if (!entity || !entity.has(UIAction)) return null;
  const bindings = (entity.get(UIAction) as { bindings: UIActionBinding[] }).bindings;
  applyBindings(bindings, 'click', { selfGuid: guid });
  return guid;
}

// ── Pure directional resolution ─────────────────────────────────────────────────

function center(r: ScreenRect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Nearest focusable in `dir` from `from`, scored by distance ALONG the axis plus a
 *  penalty for perpendicular offset (so a slightly-off but closer target still wins,
 *  but a wildly-sideways one loses). Candidates not strictly in the pressed direction
 *  are excluded. Returns the winning GUID or null. Pure — the app feeds real rects,
 *  tests feed fabricated ones. */
export function pickInDirection(
  from: ScreenRect,
  candidates: { guid: string; rect: ScreenRect }[],
  dir: NavDir,
): string | null {
  const fc = center(from);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const cc = center(c.rect);
    const dx = cc.x - fc.x;
    const dy = cc.y - fc.y;
    let along: number;
    let perp: number;
    switch (dir) {
      case 'right': along = dx; perp = Math.abs(dy); break;
      case 'left': along = -dx; perp = Math.abs(dy); break;
      case 'down': along = dy; perp = Math.abs(dx); break;
      case 'up': along = -dy; perp = Math.abs(dx); break;
    }
    if (along <= 0) continue; // not in the pressed direction
    const score = along + perp * 2;
    if (score < bestScore) { bestScore = score; best = c.guid; }
  }
  return best;
}

// Reset focus whenever the scene/world changes so stale GUIDs never linger.
let _worldSwapHooked = false;
export function ensureFocusWorldSwapHook(): void {
  if (_worldSwapHooked) return;
  _worldSwapHooked = true;
  onWorldSwap(() => resetFocus());
}
