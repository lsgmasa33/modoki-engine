/** `/api/input/*` — the trusted-input host routes (Enact).
 *
 *  Extracted from `main.ts` and dependency-injected for two reasons: the file was the
 *  usual electron-main tarpit (untestable because everything closes over `BrowserWindow`),
 *  and the selector-resolution seam below is exactly the kind of thing that must be
 *  pinned by a test — "did we resolve BEFORE dispatching, or after?" is invisible in a
 *  screenshot and catastrophic in a race.
 *
 *  ADDRESSING. Every pointer route accepts an `entity` ({guid|name|id}), a CSS `selector`, or
 *  explicit viewport CSS `{x,y}` — in that precedence order. The first two are resolved in the
 *  renderer (`resolve-entity-point` / `resolve-dom-point`) inside the same call. That ordering
 *  is the point: an agent that reads coordinates, then taps them in a second round-trip, is
 *  aiming at where the target WAS. `tap-handle`/`drag-handle` already work this way for canvas
 *  handles; `selector` extends it to editor chrome and `entity` to scene entities — the three
 *  target surfaces aimed input has.
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
import type { EntityPointSpec, EntityPointResolution, OcclusionScope, AimedAt } from '../app/debug/entityPointContract';
import type { ErrorCode } from '../tools/shared/mcpResult';

/** The trusted-input primitives, pre-bound to the live window by the caller. */
export interface InputOps {
  tap(x: number, y: number, opts?: { button?: MouseButton; clickCount?: number; modifiers?: InputModifier[] }): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }, opts?: { steps?: number; button?: MouseButton; modifiers?: InputModifier[] }): Promise<void>;
  hover(x: number, y: number, modifiers?: InputModifier[]): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number, modifiers?: InputModifier[]): Promise<void>;
  /** Sustained-pointer primitives (held across calls) — see rendererOps pointerDown/Move/Up. */
  pointerDown(x: number, y: number, opts?: { button?: MouseButton; modifiers?: InputModifier[] }): Promise<void>;
  pointerMove(x: number, y: number, opts?: { button?: MouseButton; modifiers?: InputModifier[] }): Promise<void>;
  pointerUp(x: number, y: number, opts?: { button?: MouseButton; modifiers?: InputModifier[] }): Promise<void>;
  pressKey(key: string, modifiers?: InputModifier[]): Promise<{ activeElement: string | null; gameSwallows: boolean }>;
  typeText(text: string, opts?: { clearFirst?: boolean; submitKey?: string }): Promise<{
    typed: number; editable: boolean; activeElement: string | null;
    /** The focused element's text after typing, when readable — makes `typed` checkable (S3.18). */
    valueAfter?: string | null;
    /** Set when fewer characters landed than were requested. */
    error?: string;
  }>;
  focusElement(selector?: string): Promise<{
    view: boolean; focused: string | null; blurred: string | null; ok: boolean;
    /** A NAMED cause for a miss (invalid selector / no match / focus refused) — S3.7. */
    error?: string;
    /** Where focus actually ended up. */
    activeElement?: string | null;
  }>;
}

export interface InputRouteDeps {
  ops: InputOps;
  /** Forward an op to the editor renderer (main.ts's `requestRenderer`). */
  requestRenderer(op: string, params: unknown): Promise<unknown>;
}

/** The `/api/input/*` dispatcher, plus `resetHeldPointer` for the caller to clear the
 *  sustained-pointer state on a renderer reload (see createInputRoutes). */
export type InputRoutesHandler =
  ((req: HostRequest) => Promise<BackendResult | null>) & { resetHeldPointer(): void };

/** A point the agent wants to act on: an ENTITY, a CSS selector, or explicit coordinates.
 *
 *  Precedence is `entity` → `selector` → `{x,y}`, extending the existing
 *  selector-overrides-coordinates rule rather than replacing it (the tool descriptions have
 *  documented that ordering since selectors landed, so re-litigating it here would break
 *  callers for no gain). */
export interface PointSpec { x?: number; y?: number; selector?: string; entity?: EntityPointSpec }

/** A resolved point plus the provenance an agent needs to trust it. */
export interface ResolvedPoint {
  x: number; y: number;
  matched?: string | null; hitTarget?: string | null; occluded?: boolean;
  /** How far the occlusion check could see — see `OcclusionScope`. Present only for
   *  entity-aimed calls, where `occluded:false` means different things for a UI node
   *  (element-level: trustworthy) and a mesh (canvas-level: says nothing about a mesh in
   *  front of it). Reporting the scope is what keeps the weaker check from reading as the
   *  stronger one. */
  occlusionScope?: OcclusionScope;
  /** The entity an `{entity}` aim resolved to. Echoed because a `{name}` aim should be
   *  checkable, and because a guid-addressed call still reports the volatile id it hit. */
  entity?: { id: number; name: string; guid?: string; layer?: string | null };
  /** Which on-screen surface a 2D/3D entity aim was measured in ('game-3d' | 'game-2d' |
   *  'scene-view'). Present whenever it is known — without it, "I tapped the cube" does not
   *  say WHICH on-screen cube, and in the editor there are routinely two. */
  surface?: string;
  /** Which entity the surface's own hit-test says is actually at the aim point — `null` for
   *  empty space. Only present on the `'entity'` occlusion scope; names the blocker the way
   *  `hitTarget` names a covering DOM element (F15, `docs/enact.md`). */
  occludedByEntity?: { id: number; name: string; guid?: string } | null;
  /** How the aim point inside the entity's projected rect was chosen — `'centre'` (clean hit)
   *  or `'sampled'` (the centre missed a concave/hollow shape, so the rect was searched). Only
   *  present on the `'entity'` scope. */
  aimedAt?: AimedAt;
  /** How many points were tried before the aim succeeded or gave up, when the centre missed
   *  and the rect was sampled. Only present when sampling actually ran. */
  samplesTried?: number;
}

const json = (body: unknown, status?: number): BackendResult => ({ kind: 'json', ...(status ? { status } : {}), body });
const bad = (error: string, code?: ErrorCode) => json({ error, ...(code ? { code } : {}) }, 400);

/** Resolve a `{selector}` in the renderer, or pass `{x,y}` through. Returns the point or
 *  a prefixed error string — never throws, so a bad selector is a 400, not a 500. */
export async function resolvePoint(
  spec: PointSpec | undefined,
  which: string,
  requestRenderer: InputRouteDeps['requestRenderer'],
): Promise<{ point: ResolvedPoint } | { error: string; code?: ErrorCode }> {
  // ── entity: resolve {guid}/{name}/{id} to the entity's LIVE screen rect in the renderer. ──
  // Highest precedence: it is the most specific thing the caller can say, and (unlike a
  // selector) there is no legacy call shape that passes it incidentally.
  if (spec && spec.entity && typeof spec.entity === 'object' && Object.keys(spec.entity).length > 0) {
    let res: EntityPointResolution | null;
    try {
      res = (await requestRenderer('resolve-entity-point', spec.entity)) as EntityPointResolution | null;
    } catch (e) {
      return { error: `${which}: renderer could not resolve entity (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!res || !res.ok || typeof res.x !== 'number' || typeof res.y !== 'number') {
      return { error: `${which}: ${res?.error ?? 'entity did not resolve'}`, ...(res?.code ? { code: res.code } : {}) };
    }
    return {
      point: {
        x: res.x, y: res.y,
        matched: res.matched, hitTarget: res.hitTarget, occluded: res.occluded,
        occlusionScope: res.occlusionScope, entity: res.entity, surface: res.surface,
        occludedByEntity: res.occludedByEntity, aimedAt: res.aimedAt, samplesTried: res.samplesTried,
      },
    };
  }
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
  return { error: `${which}: provide an entity {guid|name|id}, a selector, or {x,y}` };
}

/** Strip the undefined provenance fields so a coordinate-addressed call's response stays
 *  as terse as it was before selectors existed. */
function provenance(p: ResolvedPoint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.matched !== undefined) out.matched = p.matched;
  if (p.hitTarget !== undefined) out.hitTarget = p.hitTarget;
  if (p.occluded !== undefined) out.occluded = p.occluded;
  // Only ever set alongside `occluded`, and always when an entity resolved it — so a caller
  // can never see an entity-aimed `occluded` without the scope that qualifies it.
  if (p.occlusionScope !== undefined) out.occlusionScope = p.occlusionScope;
  if (p.entity !== undefined) out.entity = p.entity;
  if (p.surface !== undefined) out.surface = p.surface;
  // Only ever set on the 'entity' occlusion scope — see the fields' own doc comments above.
  if (p.occludedByEntity !== undefined) out.occludedByEntity = p.occludedByEntity;
  if (p.aimedAt !== undefined) out.aimedAt = p.aimedAt;
  if (p.samplesTried !== undefined) out.samplesTried = p.samplesTried;
  return out;
}

/** What the renderer says about whether trusted input can be DELIVERED right now.
 *  `null` when the renderer could not answer — an UNKNOWN state, never a refusal. */
export interface InputDeliverability { visibilityState?: string; hasFocus?: boolean }

/** Ask the renderer whether trusted input can actually be DELIVERED right now.
 *
 *  Chromium drops every `sendInputEvent` to a page whose `visibilityState` is `'hidden'` —
 *  nothing arrives at all. Measured 2026-08-18: three consecutive taps at a correctly-resolved
 *  Assets row delivered ZERO events (a capture-phase `document` listener recorded nothing, the
 *  row never selected), and every call still answered `ok:true, occluded:false`. That is the
 *  silent-failure class this whole surface exists to remove: the reply described what the call
 *  AIMED at, never what arrived, so the agent blamed whatever feature it was driving.
 *
 *  ⚠️ What PUTS a window into that state changed later the same day (#243), so do not read this
 *  gate as "occluded input is dropped" — it no longer is, on macOS. `main.ts` now appends
 *  `disable-backgrounding-occluded-windows`, and a COVERED window measures `'visible'` at 61fps
 *  where it used to report `'hidden'` at fps 0. A MINIMISED one does too, and a trusted tap was
 *  measured LANDING there (`mousedown:trusted`/`mouseup:trusted`, focus moved to the tapped
 *  input). Believing the old rule is exactly the stop-and-ask-a-human round trip #243 removed.
 *  The gate stays because its remaining causes are unmeasured — another Space, a sleeping
 *  display, or a platform the switch does not reach — and a cheap gate that never fires costs
 *  nothing, whereas removing it would restore the silent miss on whatever still triggers it.
 *
 *  Best-effort, like the attribution lease: a renderer that cannot answer must never fail the
 *  input (a refused tap is a broken tool; an unqualified one is only a missing hint).
 *
 *  Exported because `/api/input/*` is NOT the only route that dispatches trusted input —
 *  `/api/capture-gesture` drives its own drag through `rendererOps` — and a gate only one of
 *  them passes through is a gate with a hole in it. */
export async function inputDeliverability(
  requestRenderer: InputRouteDeps['requestRenderer'],
): Promise<InputDeliverability | null> {
  try {
    return (await requestRenderer('input-deliverability', {})) as InputDeliverability | null;
  } catch { return null; }
}

/** The 409 for a hidden window, or null when the input can go ahead (including the
 *  could-not-tell case). `what` names the caller's action so the message reads as the answer to
 *  the call that was actually made. */
export function hiddenWindowRefusal(live: InputDeliverability | null, what: string): BackendResult | null {
  if (live?.visibilityState !== 'hidden') return null;
  return json({
    ok: false,
    code: 'REFUSED_BY_OP' satisfies ErrorCode,
    error: `the editor page reports document.visibilityState "hidden", so Chromium would drop `
      + `${what} and deliver nothing — no event reaches the page at all. Nothing was dispatched; `
      + 'the identical call lands once the page is visible. NOTE (#243): a COVERED or MINIMISED '
      + 'window no longer causes this on macOS — both measure as "visible", and a trusted tap was '
      + 'measured landing while minimised — so raising the window is probably NOT the fix here. '
      + 'Look for a cause the occlusion switch does not reach: another Space, a sleeping display, '
      + 'or a platform where it does not apply.',
    windowVisibility: 'hidden',
  }, 409);
}

/** The `/api/input/*` paths this file actually dispatches. The gate and the fall-through both
 *  read it, so "is this one of ours?" has one answer — and a route added to `dispatchInput`
 *  without being added here simply falls through, rather than being silently ungated. */
const DISPATCHED_INPUT_ROUTES = new Set([
  '/api/input/tap', '/api/input/drag', '/api/input/pointer', '/api/input/hover',
  '/api/input/scroll', '/api/input/key', '/api/input/type', '/api/input/focus',
  '/api/input/tap-handle', '/api/input/drag-handle',
]);

/** Build the `/api/input/*` handler. Returns null for any other route so the caller can
 *  fall through to the next set of host routes / the shared router. */
export function createInputRoutes(deps: InputRouteDeps) {
  const { ops, requestRenderer } = deps;

  /** The currently-HELD sustained pointer (from `/api/input/pointer` action:'down'), or null.
   *  Lives in the factory closure so it persists ACROSS requests — that is the whole point: a
   *  `down` in one MCP call, a `move`/`up` in later ones. Tracks the button so a `move`/`up`
   *  reuses the held one (and threads it into the event, making the move a drag-move), and so a
   *  `move`/`up` with nothing held is a clear 409 rather than a silent stray event. */
  let heldPointer: { button: MouseButton; x: number; y: number } | null = null;

  /** Attribute everything this dispatch causes to the AGENT.
   *
   *  Trusted input is indistinguishable from a human's by construction, so the renderer
   *  cannot infer provenance — the injector has to declare it. Without this, every agent
   *  tap/keypress/drag journals as `source:'human'` (measured: modoki_tap on a Hierarchy
   *  row produced !focus + !select tagged human, while modoki_gizmo — a renderer op, and
   *  therefore wrapped — correctly said agent).
   *
   *  ONE seam for every /api/input/* route: a per-route wrapper would be nine chances to
   *  forget, and the next route added would silently reintroduce the bug.
   *
   *  Best-effort on purpose. A failed lease must never fail the INPUT — mis-attribution is
   *  a reporting defect, a refused tap is a broken tool — so both calls swallow their
   *  errors, and the lease's own deadline cleans up if the close never lands. */
  async function withAgentAttribution<T>(fn: () => Promise<T>): Promise<T> {
    let id: number | undefined;
    try {
      const r = (await requestRenderer('actor-lease', { open: true })) as { id?: number } | null;
      id = r?.id;
    } catch { /* no renderer / op unavailable — dispatch anyway, unattributed */ }
    try {
      return await fn();
    } finally {
      if (id !== undefined) {
        try { await requestRenderer('actor-lease', { id }); } catch { /* deadline will expire it */ }
      }
    }
  }

  /** Gate every dispatching `/api/input/*` route on whether trusted input can actually be
   *  DELIVERED right now. Why this exists, what Chromium actually drops, and the #243 change to
   *  which window states still reach it: see `inputDeliverability` above — the one copy. (This
   *  used to restate that comment verbatim, and the two would have drifted apart at #243.) */
  const handler = (async function inputRoutes(req: HostRequest): Promise<BackendResult | null> {
    const { method, urlPath } = req;
    if (!urlPath.startsWith('/api/input/') || method !== 'POST') return null;
    // An unrecognised `/api/input/<x>` must FALL THROUGH (null) so the caller can try the next
    // handler — including while the window is hidden. Checking the route set here rather than
    // letting `dispatchInput`'s trailing `return null` decide keeps that true: the gate below
    // would otherwise answer 409 for a path this file does not own.
    if (!DISPATCHED_INPUT_ROUTES.has(urlPath)) return null;
    const live = await inputDeliverability(requestRenderer);
    // `/api/input/focus` is exempt: it is the one route here that dispatches NO OS input —
    // `focusElement` is `wc.focus()` plus `executeJavaScript`, which a hidden window still runs.
    // Refusing it would state a reason ("Chromium would drop this input") that is untrue for it,
    // and a refusal whose stated cause is false is worse than either answer.
    const refusal = urlPath === '/api/input/focus' ? null : hiddenWindowRefusal(live, 'this input');
    if (refusal) return refusal;
    const r = await withAgentAttribution(() => dispatchInput(req));
    // Visible but NOT OS-focused: input arrives, yet Chromium fires no focus/blur/focusin/
    // focusout — so anything the editor does ON a focus event silently does not happen (a
    // commit-on-blur field is the classic). Reported, not refused: the input itself is real.
    if (r && r.kind === 'json' && live && live.hasFocus === false && r.body && typeof r.body === 'object' && !Array.isArray(r.body)) {
      (r.body as Record<string, unknown>).windowFocused = false;
    }
    return r;
  }) as InputRoutesHandler;

  /** Drop any held sustained-pointer press. Called when the renderer reloads/navigates: the
   *  synthetic press has no real OS button behind it, so a new document starts with nothing
   *  held — but `heldPointer` would otherwise persist and 409 the next `down` as "already
   *  held" (a stranded state machine). Idempotent. */
  handler.resetHeldPointer = () => { heldPointer = null; };
  return handler;

  async function dispatchInput({ urlPath, body }: HostRequest): Promise<BackendResult | null> {

    if (urlPath === '/api/input/tap') {
      const { x, y, selector, entity, button, clickCount, modifiers } = (body ?? {}) as PointSpec & { button?: MouseButton; clickCount?: number; modifiers?: InputModifier[] };
      const r = await resolvePoint({ x, y, selector, entity }, 'tap', requestRenderer);
      if ('error' in r) return bad(r.error, r.code);
      await ops.tap(r.point.x, r.point.y, { button, clickCount, modifiers });
      return json({ ok: true, tapped: { x: r.point.x, y: r.point.y, button: button ?? 'left', clickCount: clickCount ?? 1 }, ...provenance(r.point) });
    }

    if (urlPath === '/api/input/drag') {
      const { from, to, steps, button, modifiers } = (body ?? {}) as { from?: PointSpec; to?: PointSpec; steps?: number; button?: MouseButton; modifiers?: InputModifier[] };
      const rf = await resolvePoint(from, 'from', requestRenderer);
      if ('error' in rf) return bad(rf.error, rf.code);
      const rt = await resolvePoint(to, 'to', requestRenderer);
      if ('error' in rt) return bad(rt.error, rt.code);
      // A zero-length drag is a CLICK, not a drag: mouseDown+mouseUp at one pixel is what Blink
      // synthesizes a `click` from. Measured — `modoki_drag {from:{700,200},to:{700,200}}` over
      // empty SceneView space returned ok:true and CLEARED the human's selection (entity 38 →
      // null), because SceneView's select gesture only cancels past DESELECT_DRAG_PX. Reachable
      // via `drag_handle {delta:{dx:0,dy:0}}` or two selectors resolving to the same centre.
      // Refuse rather than dispatch: this route already reports off-screen/disabled handles as
      // ok:false, and a click wearing a drag's name is the same class of false success.
      if (rf.point.x === rt.point.x && rf.point.y === rt.point.y) {
        return bad(`drag is a no-op: from and to resolved to the same point (${rf.point.x}, ${rf.point.y}). A press+release at one pixel is a CLICK, not a drag — use modoki_tap / modoki_tap_handle, or give "to" a different point (drag_handle takes a non-zero delta).`);
      }
      await ops.drag({ x: rf.point.x, y: rf.point.y }, { x: rt.point.x, y: rt.point.y }, { steps, button, modifiers });
      return json({
        ok: true,
        dragged: { from: { x: rf.point.x, y: rf.point.y }, to: { x: rt.point.x, y: rt.point.y }, button: button ?? 'left' },
        ...(Object.keys(provenance(rf.point)).length ? { fromTarget: provenance(rf.point) } : {}),
        ...(Object.keys(provenance(rt.point)).length ? { toTarget: provenance(rt.point) } : {}),
      });
    }

    // ── SUSTAINED pointer (held across calls): down → move* → up ──
    // The stateful twin of /api/input/drag. `down` presses and LEAVES the button held; later
    // `move`s re-aim it (a drag-move, since the button stays down); `up` releases. Between calls
    // the press physically persists (no mouseUp sent), so an agent can read held-only state — a
    // slingshot pull, a charge meter, a drag-to-aim rubber-band — with get_scene_state / eval /
    // a screenshot mid-gesture, which the atomic drag can't expose.
    if (urlPath === '/api/input/pointer') {
      const { action, x, y, selector, entity, button, modifiers } =
        (body ?? {}) as PointSpec & { action?: 'down' | 'move' | 'up'; button?: MouseButton; modifiers?: InputModifier[] };
      if (action !== 'down' && action !== 'move' && action !== 'up') {
        return bad(`pointer: action must be 'down', 'move', or 'up' (got ${JSON.stringify(action)})`);
      }
      if (action === 'down' && heldPointer) {
        return json({ error: `a pointer is already held (button '${heldPointer.button}' down at ${heldPointer.x},${heldPointer.y}). Release it with action:'up' before pressing again.` }, 409);
      }
      if ((action === 'move' || action === 'up') && !heldPointer) {
        return json({ error: `no pointer is held — send action:'down' first (this ${action} would be a stray event).` }, 409);
      }
      const r = await resolvePoint({ x, y, selector, entity }, `pointer ${action}`, requestRenderer);
      if ('error' in r) return bad(r.error, r.code);
      // 'down' takes its button from the request (default left); 'move'/'up' REUSE the held one so
      // the whole gesture is one consistent button and a move reads as a drag-move.
      const effButton: MouseButton = action === 'down' ? (button ?? 'left') : heldPointer!.button;
      if (action === 'down') {
        await ops.pointerDown(r.point.x, r.point.y, { button: effButton, modifiers });
        heldPointer = { button: effButton, x: r.point.x, y: r.point.y };
      } else if (action === 'move') {
        await ops.pointerMove(r.point.x, r.point.y, { button: effButton, modifiers });
        heldPointer = { button: effButton, x: r.point.x, y: r.point.y };
      } else {
        await ops.pointerUp(r.point.x, r.point.y, { button: effButton, modifiers });
        heldPointer = null;
      }
      return json({ ok: true, pointer: { action, x: r.point.x, y: r.point.y, button: effButton, held: heldPointer !== null }, ...provenance(r.point) });
    }

    if (urlPath === '/api/input/hover') {
      const { x, y, selector, entity, modifiers } = (body ?? {}) as PointSpec & { modifiers?: InputModifier[] };
      const r = await resolvePoint({ x, y, selector, entity }, 'hover', requestRenderer);
      if ('error' in r) return bad(r.error, r.code);
      await ops.hover(r.point.x, r.point.y, modifiers);
      return json({ ok: true, hovered: { x: r.point.x, y: r.point.y }, ...provenance(r.point) });
    }

    if (urlPath === '/api/input/scroll') {
      const { x, y, selector, entity, deltaX, deltaY, modifiers } = (body ?? {}) as PointSpec & { deltaX?: number; deltaY?: number; modifiers?: InputModifier[] };
      const r = await resolvePoint({ x, y, selector, entity }, 'scroll', requestRenderer);
      if ('error' in r) return bad(r.error, r.code);
      // A scroll with no delta is a no-op wearing an action's name (S3.15). `deltaY` documents no
      // default and the tool shape is non-strict about intent — a misspelled `dy` reaches here as
      // nothing at all — so the pre-fix behaviour dispatched a zero-delta wheel and answered
      // `ok:true, scrolled:{deltaX:0,deltaY:0}`. Refuse, exactly as /api/input/drag and
      // /api/input/drag-handle refuse a zero-length gesture, and for the same reason.
      if (!deltaX && !deltaY) {
        return bad('scroll is a no-op: neither deltaX nor deltaY is a non-zero number, so no wheel movement would be delivered. Pass deltaY (~120 ≈ one wheel tick down, negative = up) and/or deltaX. Accepted keys: x, y, selector, entity, deltaX, deltaY, modifiers.');
      }
      await ops.scroll(r.point.x, r.point.y, deltaX ?? 0, deltaY ?? 0, modifiers);
      return json({ ok: true, scrolled: { x: r.point.x, y: r.point.y, deltaX: deltaX ?? 0, deltaY: deltaY ?? 0, ...(modifiers?.length ? { modifiers } : {}) }, ...provenance(r.point) });
    }

    if (urlPath === '/api/input/key') {
      const { key, modifiers, panel } = (body ?? {}) as { key?: string; modifiers?: InputModifier[]; panel?: string };
      if (typeof key !== 'string' || !key) return bad('key is a required string');
      // Panel-scoped chords resolve against the FOCUSED panel, so a bare `w` sent with the
      // wrong panel focused does nothing — silently, since the dispatcher yields rather than
      // erroring. `panel` sets the keyboard scope first so the caller can steer a chord
      // instead of tapping-and-hoping. Reported back so a mismatch is visible. (P7)
      let focusedPanel: string | null | undefined;
      if (typeof panel === 'string' && panel) {
        const f = (await requestRenderer('set-focus-scope', { panel })) as { focusedPanel?: string | null } | null;
        focusedPanel = f?.focusedPanel ?? null;
        if (focusedPanel !== panel) {
          return bad(`could not focus panel "${panel}" (scope is now ${JSON.stringify(focusedPanel)}) — is that panel open? Panel ids are the FlexLayout tab ids: scene, game, hierarchy, inspector, console, assets, animation-editor, timeline-editor, particle-editor, spriteanim-editor, skin-editor, ai.`);
        }
      }
      const r = await ops.pressKey(key, modifiers);
      // The key IS dispatched (DOM hotkeys fire regardless), so this stays ok:true — but if a
      // field is focused the GAME never samples it, so surface that so a silent no-reach is
      // visible. (C7 re-audit.)
      //
      // WORDED CAREFULLY: this warning is about the GAME's sampler only. The editor's keymap
      // uses a narrower predicate, so a panel/app shortcut can still fire while this warns —
      // measured: `f` framed the selection with a readOnly input focused. The old wording
      // ("will swallow this key") claimed more than the probe knows and read as a flat
      // contradiction of what had just happened.
      return json({
        ok: true, pressed: { key, modifiers: modifiers ?? [] }, activeElement: r.activeElement,
        ...(focusedPanel !== undefined ? { focusedPanel } : {}),
        ...(r.gameSwallows ? { warning: `a form field (${r.activeElement}) has focus, so the RUNNING GAME's input sampler will ignore this key — call modoki_focus (no selector) to blur it if you meant to drive the game. Editor shortcuts are unaffected and may still fire.` } : {}),
      });
    }

    if (urlPath === '/api/input/type') {
      const { text, clearFirst, submitKey } = (body ?? {}) as { text?: string; clearFirst?: boolean; submitKey?: string };
      if (typeof text !== 'string') return bad('text is a required string');
      const r = await ops.typeText(text, { clearFirst, submitKey });
      // Nothing editable focused ⇒ the chars went nowhere. Report ok:false (isFailureBody surfaces
      // it) with WHERE focus actually is, instead of the old {ok:true, typed:N} into the void. (C7 re-audit.)
      if (!r.editable) {
        // Two DIFFERENT failures, and telling them apart is the whole value of the message.
        // "Nothing focused" → tap the input. "Something IS focused but rejects text" (a readOnly
        // or disabled field, a checkbox, a <select>) → tapping again will not help, and the old
        // one-size message told the caller to re-do the step they had just done correctly.
        return json({
          ok: false, typed: 0, activeElement: r.activeElement,
          error: r.activeElement
            ? `the focused element (${r.activeElement}) cannot receive typed text — it is readOnly/disabled, or not a text control (checkbox, select, button). Nothing was typed. If you meant a different field, aim at it explicitly; if the field is readOnly the value is not editable here.`
            : 'no element is focused, so nothing was typed — modoki_tap the target input first, then type.',
        });
      }
      // A SHORT insert is a failure, not a success with a small number (S3.18): `typed` is now the
      // MEASURED delta of the focused element's value, and Chromium's synthetic char path silently
      // drops anything it cannot express as a keyCode (CJK, emoji, accented letters). Reporting
      // ok:true there is the same false success the readOnly case was fixed for.
      if (r.error) {
        return json({ ok: false, typed: r.typed, requested: text.length, activeElement: r.activeElement,
          ...(r.valueAfter !== undefined ? { valueAfter: r.valueAfter } : {}), error: r.error });
      }
      return json({ ok: true, typed: r.typed, activeElement: r.activeElement,
        ...(r.valueAfter !== undefined ? { valueAfter: r.valueAfter } : {}) });
    }

    if (urlPath === '/api/input/focus') {
      const { selector, panel } = (body ?? {}) as { selector?: string; panel?: string };
      // `panel` sets the KEYBOARD SCOPE; `selector` sets DOM focus. Genuinely different:
      // clicking a Hierarchy row moves the scope but leaves document.activeElement on
      // <body>. Both may be given — the scope is set first. (P7)
      let focusedPanel: string | null | undefined;
      if (typeof panel === 'string' && panel) {
        const f = (await requestRenderer('set-focus-scope', { panel })) as { focusedPanel?: string | null } | null;
        focusedPanel = f?.focusedPanel ?? null;
      }
      const r = selector !== undefined || panel === undefined
        ? await ops.focusElement(selector)
        : { ok: true as const };
      return json({ ...r, ...(focusedPanel !== undefined ? { focusedPanel } : {}) });
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
      type ResolvedHandle = { id: string; x: number; y: number; onScreen?: boolean; occludedBy?: string; occlusionChecked?: boolean; meta?: { disabled?: boolean } };
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
      // S3.17 — `occluded` means the SAME thing here as on every other aimed route: a BOOLEAN,
      // always present, with the covering element's identity in `occludedBy`. The handle routes
      // used to emit `occluded` as a STRING naming the cover and omit it when clean, so a caller
      // written against tap/drag/hover/pointer read a truthy string as "occluded: yes" only by
      // accident and could not branch on the absent case at all.
      //
      // …but `occluded` must not be ASSERTED when the check never ran (independent review,
      // 2026-07-30). Deriving it from `occludedBy !== undefined` alone reported
      // `occluded:false, occludedBy:null` — an affirmative "nothing covers this" — for every
      // handle whose provider supplies no owning element, and NO Canvas2D/SVG provider does. So
      // every keyframe / bone / vertex / gizmo handle claimed a clean occlusion check that had not
      // happened. Before S3.17 the field was simply absent (absent = unknown), so the
      // normalisation turned a silence into a wrong answer.
      //
      // `computeHandles` already distinguishes the two with `occlusionChecked`; this just has to
      // honour it. `occluded:null` = not checked, and `occlusionChecked` says so explicitly —
      // mirroring `occlusionScope` on the entity-aim path, where the same "how far can this
      // guarantee see" question is answered rather than implied.
      const occlusion = (hd: ResolvedHandle): Record<string, unknown> => (
        hd.occlusionChecked
          ? { occluded: hd.occludedBy !== undefined, occludedBy: hd.occludedBy ?? null, occlusionChecked: true }
          : { occluded: null, occludedBy: null, occlusionChecked: false }
      );
      if (urlPath === '/api/input/tap-handle') {
        await ops.tap(from.x, from.y, { button: h.button, clickCount: h.clickCount, modifiers: h.modifiers });
        return json({ ok: true, tappedHandle: { id: h.id, x: from.x, y: from.y }, ...occlusion(from) });
      }
      // drag-handle: destination is an explicit to{}, another handle (toId), or from+delta.
      let to: { x: number; y: number } | null = h.to ?? null;
      let toHandle: ResolvedHandle | null = null;
      if (!to && h.toId) {
        const t = await resolve(h.toId);
        if (!t) return json({ error: `no live handle with toId '${h.toId}'` }, 404);
        const tBlocked = blockedReason(t);
        if (tBlocked) return json({ ok: false, error: `toId handle '${h.toId}' is ${tBlocked}`, handle: { id: h.toId, x: t.x, y: t.y, onScreen: t.onScreen ?? true } });
        to = { x: t.x, y: t.y };
        toHandle = t;
      }
      if (!to && h.delta) to = { x: from.x + h.delta.dx, y: from.y + h.delta.dy };
      if (!to) return bad('provide to{x,y}, toId, or delta{dx,dy}');
      // Same degenerate case as /api/input/drag, and this is the route that reaches it most
      // easily: `delta:{dx:0,dy:0}` is a truthy object, and a `toId` handle can sit on top of
      // `id`. mouseDown+mouseUp at one pixel is a click — refuse rather than dispatch one under
      // the name "drag", in a route that already refuses off-screen and disabled handles.
      if (from.x === to.x && from.y === to.y) {
        return json({
          ok: false,
          error: `drag-handle is a no-op: the destination resolved to the same point as handle '${h.id}' (${from.x}, ${from.y}) — a press+release at one pixel is a CLICK, not a drag. Use /api/input/tap-handle, or pass a non-zero delta{dx,dy}.`,
          handle: { id: h.id, x: from.x, y: from.y },
        });
      }
      await ops.drag({ x: from.x, y: from.y }, to, { steps: h.steps, button: h.button, modifiers: h.modifiers });
      // PER ENDPOINT, mirroring /api/input/drag's fromTarget/toTarget: collapsing the two into one
      // `occluded` field left the caller unable to tell WHICH end was covered — and a covered
      // destination and a covered source call for different fixes. `toTarget` is reported only for
      // a `toId` destination (a raw to{x,y} or a delta has no handle to inspect).
      return json({
        ok: true,
        draggedHandle: { id: h.id, from: { x: from.x, y: from.y }, to },
        fromTarget: { id: h.id, ...occlusion(from) },
        ...(toHandle ? { toTarget: { id: h.toId, ...occlusion(toHandle) } } : {}),
        // Kept for callers written against the old shape: true when EITHER end is covered.
        occluded: from.occludedBy !== undefined || toHandle?.occludedBy !== undefined,
        occludedBy: from.occludedBy ?? toHandle?.occludedBy ?? null,
      });
    }

    return null;
  }
}
