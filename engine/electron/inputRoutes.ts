/** `/api/input/*` — the trusted-input host routes (Enact).
 *
 *  Extracted from `main.ts` and dependency-injected for two reasons: the file was the
 *  usual electron-main tarpit (untestable because everything closes over `BrowserWindow`),
 *  and the selector-resolution seam below is exactly the kind of thing that must be
 *  pinned by a test — "did we resolve BEFORE dispatching, or after?" is invisible in a
 *  screenshot and catastrophic in a race.
 *
 *  ADDRESSING. Every pointer route accepts either explicit viewport CSS `{x,y}` or a CSS
 *  `selector`, resolved in the renderer (`resolve-dom-point`) inside the same call. That
 *  ordering is the point: an agent that reads coordinates, then taps them in a second
 *  round-trip, is aiming at where the element WAS. `tap-handle`/`drag-handle` already work
 *  this way for canvas handles; `selector` extends it to editor chrome.
 *
 *  Every selector-resolved response carries `matched` (what the selector found) and
 *  `hitTarget` (the topmost element at that point). When they differ, `occluded` is true
 *  and the click landed on something else — the silent-miss class of bug, reported as data
 *  rather than left for the agent to infer from a downscaled JPEG. */

import type { BackendResult } from '../plugins/backend/editorBackendRouter';
import type { HostRequest } from './backendServer';
import type { MouseButton, InputModifier } from './rendererOps';
// Type-only: no renderer/DOM code is pulled into the Node main process. Imported rather
// than re-declared because both sides speak this shape over the bridge, and a second copy
// of a wire contract silently drifts.
import type { DomPointResolution } from '../app/debug/domPointContract';

/** The trusted-input primitives, pre-bound to the live window by the caller. */
export interface InputOps {
  tap(x: number, y: number, opts?: { button?: MouseButton; clickCount?: number; modifiers?: InputModifier[] }): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }, opts?: { steps?: number; button?: MouseButton; modifiers?: InputModifier[] }): Promise<void>;
  hover(x: number, y: number, modifiers?: InputModifier[]): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  pressKey(key: string, modifiers?: InputModifier[]): Promise<{ activeElement: string | null; editableFocused: boolean }>;
  typeText(text: string, opts?: { clearFirst?: boolean; submitKey?: string }): Promise<{ typed: number; editable: boolean; activeElement: string | null }>;
  focusElement(selector?: string): Promise<{ view: boolean; focused: string | null; blurred: string | null; ok: boolean }>;
}

export interface InputRouteDeps {
  ops: InputOps;
  /** Forward an op to the editor renderer (main.ts's `requestRenderer`). */
  requestRenderer(op: string, params: unknown): Promise<unknown>;
}

/** A point the agent wants to act on: explicit coordinates or a CSS selector. */
export interface PointSpec { x?: number; y?: number; selector?: string }

/** A resolved point plus the provenance an agent needs to trust it. */
export interface ResolvedPoint {
  x: number; y: number;
  matched?: string | null; hitTarget?: string | null; occluded?: boolean;
}

const json = (body: unknown, status?: number): BackendResult => ({ kind: 'json', ...(status ? { status } : {}), body });
const bad = (error: string) => json({ error }, 400);

/** Resolve a `{selector}` in the renderer, or pass `{x,y}` through. Returns the point or
 *  a prefixed error string — never throws, so a bad selector is a 400, not a 500. */
export async function resolvePoint(
  spec: PointSpec | undefined,
  which: string,
  requestRenderer: InputRouteDeps['requestRenderer'],
): Promise<{ point: ResolvedPoint } | { error: string }> {
  if (spec && typeof spec.selector === 'string' && spec.selector) {
    let res: DomPointResolution | null;
    try {
      res = (await requestRenderer('resolve-dom-point', { selector: spec.selector })) as DomPointResolution | null;
    } catch (e) {
      return { error: `${which}: renderer could not resolve selector (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!res || !res.ok || typeof res.x !== 'number' || typeof res.y !== 'number') {
      return { error: `${which}: ${res?.error ?? 'selector did not resolve'}` };
    }
    return { point: { x: res.x, y: res.y, matched: res.matched, hitTarget: res.hitTarget, occluded: res.occluded } };
  }
  if (spec && typeof spec.x === 'number' && typeof spec.y === 'number') {
    return { point: { x: spec.x, y: spec.y } };
  }
  return { error: `${which}: provide a selector or {x,y}` };
}

/** Strip the undefined provenance fields so a coordinate-addressed call's response stays
 *  as terse as it was before selectors existed. */
function provenance(p: ResolvedPoint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.matched !== undefined) out.matched = p.matched;
  if (p.hitTarget !== undefined) out.hitTarget = p.hitTarget;
  if (p.occluded !== undefined) out.occluded = p.occluded;
  return out;
}

/** Build the `/api/input/*` handler. Returns null for any other route so the caller can
 *  fall through to the next set of host routes / the shared router. */
export function createInputRoutes(deps: InputRouteDeps) {
  const { ops, requestRenderer } = deps;

  return async function inputRoutes({ method, urlPath, body }: HostRequest): Promise<BackendResult | null> {
    if (!urlPath.startsWith('/api/input/') || method !== 'POST') return null;

    if (urlPath === '/api/input/tap') {
      const { x, y, selector, button, clickCount, modifiers } = (body ?? {}) as PointSpec & { button?: MouseButton; clickCount?: number; modifiers?: InputModifier[] };
      const r = await resolvePoint({ x, y, selector }, 'tap', requestRenderer);
      if ('error' in r) return bad(r.error);
      await ops.tap(r.point.x, r.point.y, { button, clickCount, modifiers });
      return json({ ok: true, tapped: { x: r.point.x, y: r.point.y, button: button ?? 'left', clickCount: clickCount ?? 1 }, ...provenance(r.point) });
    }

    if (urlPath === '/api/input/drag') {
      const { from, to, steps, button, modifiers } = (body ?? {}) as { from?: PointSpec; to?: PointSpec; steps?: number; button?: MouseButton; modifiers?: InputModifier[] };
      const rf = await resolvePoint(from, 'from', requestRenderer);
      if ('error' in rf) return bad(rf.error);
      const rt = await resolvePoint(to, 'to', requestRenderer);
      if ('error' in rt) return bad(rt.error);
      await ops.drag({ x: rf.point.x, y: rf.point.y }, { x: rt.point.x, y: rt.point.y }, { steps, button, modifiers });
      return json({
        ok: true,
        dragged: { from: { x: rf.point.x, y: rf.point.y }, to: { x: rt.point.x, y: rt.point.y }, button: button ?? 'left' },
        ...(Object.keys(provenance(rf.point)).length ? { fromTarget: provenance(rf.point) } : {}),
        ...(Object.keys(provenance(rt.point)).length ? { toTarget: provenance(rt.point) } : {}),
      });
    }

    if (urlPath === '/api/input/hover') {
      const { x, y, selector, modifiers } = (body ?? {}) as PointSpec & { modifiers?: InputModifier[] };
      const r = await resolvePoint({ x, y, selector }, 'hover', requestRenderer);
      if ('error' in r) return bad(r.error);
      await ops.hover(r.point.x, r.point.y, modifiers);
      return json({ ok: true, hovered: { x: r.point.x, y: r.point.y }, ...provenance(r.point) });
    }

    if (urlPath === '/api/input/scroll') {
      const { x, y, selector, deltaX, deltaY } = (body ?? {}) as PointSpec & { deltaX?: number; deltaY?: number };
      const r = await resolvePoint({ x, y, selector }, 'scroll', requestRenderer);
      if ('error' in r) return bad(r.error);
      await ops.scroll(r.point.x, r.point.y, deltaX ?? 0, deltaY ?? 0);
      return json({ ok: true, scrolled: { x: r.point.x, y: r.point.y, deltaX: deltaX ?? 0, deltaY: deltaY ?? 0 }, ...provenance(r.point) });
    }

    if (urlPath === '/api/input/key') {
      const { key, modifiers } = (body ?? {}) as { key?: string; modifiers?: InputModifier[] };
      if (typeof key !== 'string' || !key) return bad('key is a required string');
      const r = await ops.pressKey(key, modifiers);
      // The key IS dispatched (DOM hotkeys fire regardless), so this stays ok:true — but if an
      // editable field is focused the GAME never samples it, so surface that so a silent
      // no-reach is visible. (C7 re-audit.)
      return json({
        ok: true, pressed: { key, modifiers: modifiers ?? [] }, activeElement: r.activeElement,
        ...(r.editableFocused ? { warning: `an editable field (${r.activeElement}) is focused and will swallow this key before the game's input sampler sees it — call modoki_focus (no selector) to blur it if you meant to drive the game.` } : {}),
      });
    }

    if (urlPath === '/api/input/type') {
      const { text, clearFirst, submitKey } = (body ?? {}) as { text?: string; clearFirst?: boolean; submitKey?: string };
      if (typeof text !== 'string') return bad('text is a required string');
      const r = await ops.typeText(text, { clearFirst, submitKey });
      // Nothing editable focused ⇒ the chars went nowhere. Report ok:false (isFailureBody surfaces
      // it) with WHERE focus actually is, instead of the old {ok:true, typed:N} into the void. (C7 re-audit.)
      if (!r.editable) {
        return json({ ok: false, typed: 0, activeElement: r.activeElement, error: `no editable element is focused (active: ${r.activeElement ?? 'none'}), so nothing was typed — modoki_tap the target input first, then type.` });
      }
      return json({ ok: true, typed: r.typed, activeElement: r.activeElement });
    }

    if (urlPath === '/api/input/focus') {
      const { selector } = (body ?? {}) as { selector?: string };
      return json({ ...(await ops.focusElement(selector)) });
    }

    // ── Aimed input: resolve a handle's live CSS coords in the renderer, then issue the
    // trusted gesture at it. Handle geometry lives in the renderer; the trusted drag/tap
    // live here — so these routes bridge the two. ──
    if (urlPath === '/api/input/tap-handle' || urlPath === '/api/input/drag-handle') {
      const h = (body ?? {}) as {
        id?: string; to?: { x: number; y: number }; toId?: string; delta?: { dx: number; dy: number };
        steps?: number; button?: MouseButton; clickCount?: number; modifiers?: InputModifier[];
      };
      if (typeof h.id !== 'string' || !h.id) return bad('id (handle id) is required');
      // Carry the aimability annotations computeHandles already produces — the old closure narrowed
      // the result to {id,x,y} and DROPPED them, so tap/drag fired unconditionally: an off-screen
      // handle taps nothing, an occluded one hits the covering element, a disabled one is inert, and
      // all three returned ok:true. (F1)
      type ResolvedHandle = { id: string; x: number; y: number; onScreen?: boolean; occludedBy?: string; meta?: { disabled?: boolean } };
      const resolve = async (id: string) => {
        const res = (await requestRenderer('enact-handles', { ids: [id] })) as { handles?: ResolvedHandle[] } | null;
        return res?.handles?.find((x) => x.id === id) ?? null;
      };
      // OFF-screen (scrolled out of its panel) or DISABLED (greyed-out) = a genuine miss → refuse
      // (ok:false). OCCLUDED (something covers it) → the tap hits the cover, but mirror modoki_tap and
      // still act while surfacing `occluded` as a warning, rather than refusing.
      const blockedReason = (hd: ResolvedHandle): string | null =>
        hd.onScreen === false ? 'off-screen — scroll it into view (modoki_scroll over the panel), then retry'
          : hd.meta?.disabled === true ? 'disabled (inert / greyed-out)'
            : null;

      const from = await resolve(h.id);
      if (!from) return json({ error: `no live handle with id '${h.id}' (query /api/enact-handles to list current handles)` }, 404);
      const fromBlocked = blockedReason(from);
      if (fromBlocked) return json({ ok: false, error: `handle '${h.id}' is ${fromBlocked}`, handle: { id: h.id, x: from.x, y: from.y, onScreen: from.onScreen ?? true } });
      if (urlPath === '/api/input/tap-handle') {
        await ops.tap(from.x, from.y, { button: h.button, clickCount: h.clickCount, modifiers: h.modifiers });
        return json({ ok: true, tappedHandle: { id: h.id, x: from.x, y: from.y }, ...(from.occludedBy ? { occluded: from.occludedBy } : {}) });
      }
      // drag-handle: destination is an explicit to{}, another handle (toId), or from+delta.
      let to: { x: number; y: number } | null = h.to ?? null;
      let toOccluded: string | undefined;
      if (!to && h.toId) {
        const t = await resolve(h.toId);
        if (!t) return json({ error: `no live handle with toId '${h.toId}'` }, 404);
        const tBlocked = blockedReason(t);
        if (tBlocked) return json({ ok: false, error: `toId handle '${h.toId}' is ${tBlocked}`, handle: { id: h.toId, x: t.x, y: t.y, onScreen: t.onScreen ?? true } });
        to = { x: t.x, y: t.y };
        toOccluded = t.occludedBy;
      }
      if (!to && h.delta) to = { x: from.x + h.delta.dx, y: from.y + h.delta.dy };
      if (!to) return bad('provide to{x,y}, toId, or delta{dx,dy}');
      await ops.drag({ x: from.x, y: from.y }, to, { steps: h.steps, button: h.button, modifiers: h.modifiers });
      const occluded = from.occludedBy ?? toOccluded;
      return json({ ok: true, draggedHandle: { id: h.id, from: { x: from.x, y: from.y }, to }, ...(occluded ? { occluded } : {}) });
    }

    return null;
  };
}
