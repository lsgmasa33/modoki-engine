/** Phase 0 of #32 (docs/trusted-device-input.md): every device input handler in
 *  `app/debug/bridge.ts` must report the mechanism it actually used, so an agent is never misled
 *  about input fidelity. Today that mechanism is `INPUT_MECHANISM` ('synthetic') for all seven
 *  ops — the six string-returning handlers (tap/drag/pointer/press-key/hover/scroll) get a
 *  ` [input:${INPUT_MECHANISM}]` suffix appended to a SUCCESSFUL reply only, via the single
 *  `withMechanismSuffix` helper; the object-returning `handleType` carries it as a real
 *  `inputMechanism` field instead. Phases 1-2 will change `INPUT_MECHANISM` per platform — this
 *  file pins the CONTRACT (every op reports it, failures never do), not the current value.
 *
 *  Drives the REAL bridge functions under jsdom (same style as bridgePointerAndType.test.ts) —
 *  coordinate-aimed only, since a `selector` aim dynamically imports `agentBridge`, which needs a
 *  live ECS world (out of scope here). Assertions read `INPUT_MECHANISM` from the module rather
 *  than hardcoding the string 'synthetic', so a value change alone (e.g. Phase 1 landing) cannot
 *  make these fail — only a REGRESSION in the reporting behaviour can. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleTap, handleDrag, handlePointer, handlePressKey, handleHover, handleScroll, handleType,
  _resetHeldPointerForTests, INPUT_MECHANISM,
} from '../../app/debug/bridge';

const SUFFIX = ` [input:${INPUT_MECHANISM}]`;

// #486 finding C: a `selector` aim resolves through `resolveAim` → dynamic import of `agentBridge`
// → its `resolve-dom-point` op, which needs a live ECS world — out of scope for this file's
// coordinate-aimed style (see the file header). Stub `runAgentOp` instead of standing up a world,
// so a selector aim can be driven far enough to test the drift warning without touching anything
// this suite otherwise avoids.
vi.mock('../../app/debug/agentBridge', () => ({
  runAgentOp: vi.fn(async (op: string, params?: Record<string, unknown>) => {
    if (op === 'resolve-dom-point') {
      const hit = mockResolveDomPoint;
      return { ok: true, x: 5, y: 5, matched: hit, hitTarget: hit, occluded: false };
    }
    throw new Error(`deviceInputMechanism.test.ts: unexpected agent op ${op}(${JSON.stringify(params)})`);
  }),
}));

// What the stubbed `resolve-dom-point` op reports as `hitTarget` — set per-test just before the
// selector-aimed call, so each test controls what the resolution CLAIMED without touching the mock
// factory (which vitest hoists above the rest of the file).
let mockResolveDomPoint: string | null = null;

beforeEach(() => {
  // jsdom does not implement `elementFromPoint` at all (no layout engine) — the bridge code calls
  // it unconditionally, so every test needs SOME implementation. Default to "nothing there" (the
  // honest jsdom answer would be); a hover/DOM-drag success test overrides it per-test.
  document.elementFromPoint = () => null;
});

afterEach(() => {
  _resetHeldPointerForTests();
  document.body.innerHTML = '';
});

function withCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  return canvas;
}

describe('device input mechanism — successful replies carry it (#32 Phase 0)', () => {
  it('handleTap', async () => {
    withCanvas();
    const r = await handleTap({ x: 10, y: 20 });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith(SUFFIX)).toBe(true);
  });

  it('handleDrag (world-space path)', async () => {
    withCanvas();
    const r = await handleDrag({ fromX: 0, fromY: 0, toX: 50, toY: 50, dom: false });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith(SUFFIX)).toBe(true);
  });

  it('handleDrag (DOM-element path)', async () => {
    const widget = document.createElement('div');
    document.body.appendChild(widget);
    document.elementFromPoint = () => widget;
    const r = await handleDrag({ fromX: 0, fromY: 0, toX: 50, toY: 50 });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith(SUFFIX)).toBe(true);
  });

  it('handlePointer', async () => {
    withCanvas();
    const r = await handlePointer({ action: 'down', x: 10, y: 20 });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith(SUFFIX)).toBe(true);
  });

  it('handlePressKey', async () => {
    const r = await handlePressKey({ key: 'a' });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith(SUFFIX)).toBe(true);
  });

  it('handleHover', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    document.elementFromPoint = () => target;
    const r = await handleHover({ x: 5, y: 5 });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith(SUFFIX)).toBe(true);
  });

  it('handleScroll', async () => {
    const r = await handleScroll({ x: 5, y: 5, dy: 10 });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith(SUFFIX)).toBe(true);
  });

  it('handleType (object reply — a real `inputMechanism` field, not a suffix)', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    const r = await handleType({ text: 'hi' });
    expect(r.ok).toBe(true);
    expect(r.inputMechanism).toBe(INPUT_MECHANISM);
  });
});

describe('device input mechanism — error/refusal replies never carry it (#32 Phase 0)', () => {
  it('handleTap: no canvas/Pixi to dispatch to', async () => {
    const r = await handleTap({ x: 10, y: 20 });
    expect(r).toMatch(/^Error:/);
    expect(r.endsWith(SUFFIX)).toBe(false);
  });

  it('handleDrag: dom:true with nothing under the point', async () => {
    const r = await handleDrag({ fromX: 0, fromY: 0, toX: 10, toY: 10, dom: true });
    expect(r).toMatch(/^Error:/);
    expect(r.endsWith(SUFFIX)).toBe(false);
  });

  it('handleDrag: no canvas/Pixi on the world path', async () => {
    const r = await handleDrag({ fromX: 0, fromY: 0, toX: 10, toY: 10, dom: false });
    expect(r).toMatch(/^Error:/);
    expect(r.endsWith(SUFFIX)).toBe(false);
  });

  it('handlePointer: an unrecognized action is refused', async () => {
    const r = await handlePointer({ action: 'sideways', x: 1, y: 1 } as unknown as Record<string, unknown>);
    expect(r).toMatch(/^Error:/);
    expect(r.endsWith(SUFFIX)).toBe(false);
  });

  it('handlePressKey: no key given', async () => {
    const r = await handlePressKey({});
    expect(r).toMatch(/^Error:/);
    expect(r.endsWith(SUFFIX)).toBe(false);
  });

  it('handleHover: nothing under the point (jsdom default elementFromPoint)', async () => {
    const r = await handleHover({ x: 5, y: 5 });
    expect(r).toMatch(/^Error:/);
    expect(r.endsWith(SUFFIX)).toBe(false);
  });

  it('handleType: nothing focused', async () => {
    const r = await handleType({ text: 'hello' });
    expect(r.ok).toBe(false);
    expect(r.inputMechanism).toBeUndefined();
  });
});

describe('#486 finding C — hover/scroll re-check their aim before reporting it', () => {
  it('resolved hitTarget no longer matches the element at dispatch time: the reply still says ok AND names both elements', async () => {
    mockResolveDomPoint = 'button#old'; // what the selector resolution CLAIMED was there
    const movedIn = document.createElement('button'); // what is ACTUALLY there by dispatch time
    movedIn.id = 'new';
    document.body.appendChild(movedIn);
    document.elementFromPoint = () => movedIn;

    const r = await handleHover({ selector: '#old' });
    expect(r).toMatch(/^ok \(hover button\)/);
    expect(r.endsWith(SUFFIX)).toBe(true);
    expect(r).toContain('CHANGED between resolving it and acting on it');
    expect(r).toContain('resolved button#old');
    expect(r).toContain('acted on button#new');
  });

  it('nothing moved: the reply is byte-identical to an ordinary hover — no phantom drift note', async () => {
    mockResolveDomPoint = 'button#stable';
    const el = document.createElement('button');
    el.id = 'stable';
    document.body.appendChild(el);
    document.elementFromPoint = () => el; // same element the resolution named

    const r = await handleHover({ selector: '#stable' });
    expect(r).toBe(`ok (hover button) @ #stable→button#stable${SUFFIX}`);
    expect(r).not.toContain('CHANGED');
  });

  it('scroll: a resolved target that is GONE at dispatch time is drift, not silence — the wheel went to the body fallback', async () => {
    // The case the first cut skipped. `handleScroll` falls back to scrollingElement/body when
    // nothing is under the point, and it used to suppress the drift check on that branch — so a
    // selector aim whose element had vanished reported `@ #gone→div#gone` for a wheel that element
    // never saw. A null hit is the LOUDEST drift for a selector aim, not an unremarkable fallback.
    mockResolveDomPoint = 'div#gone';
    document.elementFromPoint = () => null;

    const r = await handleScroll({ selector: '#gone', dy: 100 });
    expect(r).toMatch(/^ok \(scroll dx=0 dy=100\)/);   // the wheel DID land somewhere — not a refusal
    expect(r).toContain('resolved div#gone');
    expect(r).toContain('acted on nothing');
  });

  it('a pixel-coordinate aim makes no claim, so a moved element draws no drift note', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    document.elementFromPoint = () => el;

    const r = await handleHover({ x: 5, y: 5 });
    expect(r).toBe(`ok (hover div) @ css(5,5)${SUFFIX}`);
    expect(r).not.toContain('CHANGED');
  });
});
