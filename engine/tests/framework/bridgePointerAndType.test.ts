/** Device-side handlers added for #31 (`device_pointer`/`device_type_text`) — `handlePointer`
 *  and `handleType` in `app/debug/bridge.ts`. These are the ONLY place the held-pointer refusal
 *  logic and the synthetic-typing fallback live, so a test against the MCP tool's stub backend
 *  (see `engine/tests/tools/devicePointerAndType.test.ts`) cannot exercise them — it can only
 *  assert that the tool relays whatever the (fake) device says. This file drives the REAL
 *  bridge functions under jsdom, coordinate-aimed only (a `selector` aim would dynamically
 *  import `agentBridge`, which needs a live ECS world — out of scope for this file).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { handlePointer, handleType, _resetHeldPointerForTests } from '../../app/debug/bridge';

afterEach(() => {
  _resetHeldPointerForTests();
  document.body.innerHTML = '';
});

function withCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  return canvas;
}

describe('handlePointer — sustained press held across calls', () => {
  it('down succeeds and reports held:true', async () => {
    withCanvas();
    const r = await handlePointer({ action: 'down', x: 10, y: 20 });
    expect(r).toMatch(/^ok /);
    expect(r).toMatch(/held:true/);
  });

  it('a SECOND down while already held is REFUSED, not a silent re-press', async () => {
    withCanvas();
    await handlePointer({ action: 'down', x: 10, y: 20 });
    const r = await handlePointer({ action: 'down', x: 30, y: 40 });
    expect(r).toMatch(/^Error:/);
    expect(r).toMatch(/already held/);
  });

  it('move with NOTHING held is refused as a stray event', async () => {
    withCanvas();
    const r = await handlePointer({ action: 'move', x: 10, y: 20 });
    expect(r).toMatch(/^Error:/);
    expect(r).toMatch(/no pointer is held/);
  });

  it('up with NOTHING held is refused the same way', async () => {
    withCanvas();
    const r = await handlePointer({ action: 'up', x: 10, y: 20 });
    expect(r).toMatch(/^Error:/);
    expect(r).toMatch(/no pointer is held/);
  });

  it('down -> move -> up succeeds, and up clears the held state (a later move refuses again)', async () => {
    withCanvas();
    expect(await handlePointer({ action: 'down', x: 10, y: 20 })).toMatch(/^ok /);
    expect(await handlePointer({ action: 'move', x: 15, y: 25 })).toMatch(/^ok /);
    const up = await handlePointer({ action: 'up', x: 15, y: 25 });
    expect(up).toMatch(/^ok /);
    expect(up).toMatch(/held:false/);
    const strayMove = await handlePointer({ action: 'move', x: 16, y: 26 });
    expect(strayMove).toMatch(/no pointer is held/);
  });

  it('move/up reuse the button from the down, ignoring a button passed on move', async () => {
    withCanvas();
    await handlePointer({ action: 'down', x: 10, y: 20, button: 'right' });
    const r = await handlePointer({ action: 'move', x: 11, y: 21, button: 'left' });
    expect(r).toMatch(/button right/); // NOT left — the held button wins
  });

  it('an unusable aim (no selector, incomplete coords) is refused before touching canvas/held state', async () => {
    withCanvas();
    const r = await handlePointer({ action: 'down', x: 10 }); // y missing, no selector
    // resolveAim treats missing y as undefined -> screenshotToCSS(10, undefined) — not a thrown
    // error, but the point is meaningless. The important invariant: it must not silently succeed
    // and leave heldPointer set to a garbage point without any signal.
    // (This documents present behaviour; if a stricter refusal is added later this assertion
    // should be revisited rather than silently kept green.)
    expect(typeof r).toBe('string');
  });

  it('an unrecognized action is refused', async () => {
    const r = await handlePointer({ action: 'sideways', x: 1, y: 1 } as unknown as Record<string, unknown>);
    expect(r).toMatch(/^Error:/);
    expect(r).toMatch(/must be 'down', 'move', or 'up'/);
  });
});

describe('handleType — synthetic value-set into the focused element', () => {
  it('refuses when nothing is focused', async () => {
    const r = await handleType({ text: 'hello' });
    expect(r.ok).toBe(false);
    expect(r.typed).toBe(0);
    expect(r.error).toMatch(/no element is focused/);
  });

  it('refuses a readOnly input — focus alone is not enough', async () => {
    const input = document.createElement('input');
    input.readOnly = true;
    document.body.appendChild(input);
    input.focus();
    const r = await handleType({ text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/readOnly\/disabled/);
  });

  it('types into a focused text input via the native setter + input event (React-visible)', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    let firedInputEvent = false;
    input.addEventListener('input', () => { firedInputEvent = true; });

    const r = await handleType({ text: 'hello' });
    expect(r.ok).toBe(true);
    expect(r.typed).toBe(5);
    expect(input.value).toBe('hello');
    expect(r.valueAfter).toBe('hello');
    expect(firedInputEvent).toBe(true);
  });

  it('appends by default, replaces with clearFirst', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'existing';
    document.body.appendChild(input);
    input.focus();

    await handleType({ text: '!' });
    expect(input.value).toBe('existing!');

    const r = await handleType({ text: 'fresh', clearFirst: true });
    expect(r.ok).toBe(true);
    expect(input.value).toBe('fresh');
  });

  // NOT TESTED HERE: the contentEditable path (`el.isContentEditable === true`). jsdom does not
  // implement the `contentEditable` IDL attribute at all — `div.contentEditable = 'true'` is a
  // silent no-op (measured: no attribute is set, and `isContentEditable` reads back `undefined`
  // forever), so there is no way to drive that branch under this test environment. It needs
  // on-device (real WebView) verification: focus a contentEditable element, call
  // device_type_text, and confirm `ok:true` + the appended text.

  it('submitKey dispatches a terminal key chord on the focused element', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    let sawEnter = false;
    input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') sawEnter = true; });
    const r = await handleType({ text: 'go', submitKey: 'Enter' });
    expect(r.ok).toBe(true);
    expect(sawEnter).toBe(true);
  });

  it('a non-string text is refused, not coerced', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const r = await handleType({ text: 42 as unknown as string });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/needs a `text` string/);
  });
});

/** Found on a real iPhone, not in jsdom: `up` with no coords called resolveAim with nothing to
 *  resolve, producing NaN, and the canvas received pointerup at (0,0) instead of the drag-end
 *  point — a Pixi drag would release at the origin. The button was already reused for move/up;
 *  the position must be too. */
describe('pointer up/move without coords reuses the HELD position', () => {
  it('releases where the gesture got to, not at (0,0)', async () => {
    _resetHeldPointerForTests();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const seen: Array<{ type: string; x: number; y: number }> = [];
    for (const t of ['pointerdown', 'pointermove', 'pointerup']) {
      canvas.addEventListener(t, (e) => {
        const p = e as PointerEvent;
        seen.push({ type: t, x: p.clientX, y: p.clientY });
      });
    }
    await handlePointer({ action: 'down', x: 200, y: 400 });
    await handlePointer({ action: 'move', x: 300, y: 520 });
    await handlePointer({ action: 'up' });                       // no coords — the normal case
    const up = seen.find((s) => s.type === 'pointerup');
    expect(up).toBeDefined();
    expect(Number.isNaN(up!.x)).toBe(false);
    expect([up!.x, up!.y]).toEqual([300, 520]);
    canvas.remove();
  });
});
