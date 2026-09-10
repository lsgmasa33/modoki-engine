/** #1016 — the DEVICE aim surface must send the gesture, and the right one.
 *
 *  ⚠️ **This file exists because the fix shipped without it and a mutation proved the gap.** The
 *  gesture was threaded through `inputRoutes.ts` (the editor routes) and through `domResolve.ts`
 *  (the resolver), and both got tests. `bridge.ts` — the DEVICE surface, serving `device_tap`,
 *  `device_drag`, `device_pointer`, `device_hover`, `device_scroll` and the trusted CDP/WDA route
 *  through `handleResolveAim` — was missed entirely, and deleting `gesture` from its payload left
 *  all 92 cases green. That surface is the one that runs against the SHIPPED game, i.e. the only
 *  place a `minTapSize` tap zone authored by a real project actually exists.
 *
 *  The seam under test is narrow on purpose: what does `bridge.ts` PUT ON THE WIRE? The resolver's
 *  own behaviour is covered in `domResolve.test.ts`; duplicating it here would test the same thing
 *  twice and still leave the wiring unasserted, which is exactly how it went missing. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Capture every agent-op call `bridge.ts` makes. `getRunAgentOp` dynamically imports
 *  `./agentBridge`, so mocking that module is the seam. */
const calls: Array<{ op: string; params: Record<string, unknown> }> = [];

vi.mock('../../app/debug/agentBridge', () => ({
  runAgentOp: async (op: string, params?: unknown) => {
    calls.push({ op, params: (params ?? {}) as Record<string, unknown> });
    // A resolvable, un-occluded answer, so the handler proceeds past the aim.
    return { ok: true, x: 10, y: 20, matched: 'div[data-entity-id="42"]', occluded: false };
  },
}));

const { handleTap, handleDrag, handleHover, handleScroll, handlePointer, handleResolveAim, _resetHeldPointerForTests }
  = await import('../../app/debug/bridge');

const SEL = '[data-entity-id="42"]';
const gestureFor = (op = 'resolve-dom-point') => calls.filter((c) => c.op === op).map((c) => c.params.gesture);

beforeEach(() => { calls.length = 0; document.body.innerHTML = ''; });
afterEach(() => { _resetHeldPointerForTests(); });

describe('#1016 — bridge.ts sends the gesture with every selector aim', () => {
  it('device_tap sends `tap` — the one click-shaped gesture', async () => {
    await handleTap({ selector: SEL });
    expect(gestureFor()).toEqual(['tap']);
  });

  /** ⚠️ The accept side, and the whole reason the split exists: a drag that adopted the tap
   *  redirect would stop being refused, be dispatched, and BEGIN ON THE ZONE'S HOST while
   *  reporting success. Both ends must say `drag`. */
  it('device_drag sends `drag` for BOTH endpoints', async () => {
    await handleDrag({ fromSelector: SEL, toSelector: SEL });
    expect(gestureFor()).toEqual(['drag', 'drag']);
  });

  it('device_hover sends `hover`, device_scroll sends `scroll`', async () => {
    await handleHover({ selector: SEL });
    await handleScroll({ selector: SEL });
    expect(gestureFor()).toEqual(['hover', 'scroll']);
  });

  it('device_pointer sends `press` — the aim resolves before the sequence is known', async () => {
    await handlePointer({ action: 'down', selector: SEL });
    expect(gestureFor()).toEqual(['press']);
  });

  /** ⚠️ **The trusted CDP/WDA route resolves through `handleResolveAim`**, one proxy hop further
   *  out (`deviceCdp.ts`'s `resolveAimViaDevice`). If the gesture does not survive that hop, every
   *  trusted aim silently falls back to the strict answer and #1016 stays unfixed on the surface
   *  where `isTrusted` input actually matters. */
  it('handleResolveAim carries the caller gesture across the proxy hop', async () => {
    await handleResolveAim({ selector: SEL, gesture: 'drag' });
    expect(gestureFor()).toEqual(['drag']);
  });

  it('handleResolveAim rejects a junk gesture to the STRICT side, not to tap', async () => {
    // Reachable from an older or hostile caller. `undefined` is not click-shaped, so a junk value
    // costs at most a refusal the caller can override — never a press landing on the wrong element.
    await handleResolveAim({ selector: SEL, gesture: 'not-a-gesture' });
    expect(gestureFor()).toEqual([undefined]);
  });

  /** ⚠️ **`button` narrows the tap** — Chromium fires `click` for the primary button only (right ->
   *  `contextmenu`, which `pressOrigin.ts` does not listen for), so the runtime does not redirect
   *  it, and modelling the redirect would report `occluded:false` for a press that lands on the
   *  zone.
   *
   *  ⚠️ **On THIS surface the carve-out is unreachable, and these rows drive an input production
   *  cannot produce.** `device_tap`'s schema is `{selector, x, y}` (`mcp-tools.ts`) and
   *  `dispatchTapAt`'s `mouseInit` hardcodes `button: 0`, so a device tap is always primary. The
   *  live rule is pinned in `inputRoutes.test.ts`, where `/api/input/tap` really does take
   *  `z.enum(['left','right','middle'])`. Kept here as the unreachable twin so the day someone adds
   *  `button` to `device_tap` the behaviour is already stated — not as evidence of a live path. */
  it.each([
    ['right', 'press'],
    ['middle', 'press'],
    ['left', 'tap'],
    [undefined, 'tap'],
  ])('device_tap button=%s sends %s', async (button, expected) => {
    await handleTap({ selector: SEL, ...(button ? { button } : {}) });
    expect(gestureFor()).toEqual([expected]);
  });
});
