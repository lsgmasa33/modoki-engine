/** `device_pointer`'s `button` is an AGENT-SUPPLIED key into a code-declared table (#993).
 *
 *  `POINTER_BUTTON_CODE` in `app/debug/bridge.ts` is a literal `{ left: 0, middle: 1, right: 2 }`
 *  and `params.button` arrives straight off the MCP payload, so `button: "toString"` used to
 *  return `Object.prototype.toString` — a function, which is not nullish, so the `?? 0` fallback
 *  never fired and the function reached the synthesized PointerEvent.
 *
 *  Coordinate-aimed only, for the same reason `bridgePointerAndType.test.ts` gives: a `selector`
 *  aim dynamically imports `agentBridge`, which needs a live ECS world.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { handlePointer, handlePressKey, _resetHeldPointerForTests } from '../../app/debug/bridge';

const PROTO_KEYS = [
  '__proto__', 'constructor', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
] as const;

afterEach(() => { _resetHeldPointerForTests(); document.body.innerHTML = ''; });

/** Press at (10,20), then RELEASE, and report both the dispatched code and the release's reply.
 *
 *  ⚠️ The release is what discriminates, and the first version of this file did not have it —
 *  it asserted on the pointerdown's `e.button` alone and STAYED GREEN under the reverted fix.
 *  Measured, and the reason is WebIDL: `new PointerEvent(t, { button: fn })` converts `button` to
 *  a `short`, so `Number(fn)` is NaN and ToInt16(NaN) is 0 — the event carries 0 whether or not
 *  the lookup returned a function. `buttons: 1 << fn` collapses the same way.
 *
 *  What does NOT get coerced is `heldPointer.button`, which stores the raw value. The `up` branch
 *  reads it back through `POINTER_BUTTON_NAME[heldPointer.button]`, so with the bug that index is
 *  a function and the reply names the button `undefined`. */
async function pressAndRelease(button: unknown): Promise<{ down: string; up: string; seen: number | undefined }> {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  let seen: number | undefined;
  canvas.addEventListener('pointerdown', (e) => { seen = (e as PointerEvent).button; });
  const down = await handlePointer({ action: 'down', x: 10, y: 20, button });
  const up = await handlePointer({ action: 'up', x: 10, y: 20 });
  return { down, up, seen };
}

describe('handlePointer button vocabulary (#993, #1076)', () => {
  // #1076 turned #993's FALLBACK into a REFUSAL. #993 fixed the prototype-key lookup and let an unknown
  // name press left; that answered `ok` for a press the caller did not ask for. Now nothing is pressed,
  // so the release has nothing to lift — which is what proves no gesture was started at all.
  it.each(PROTO_KEYS)('button %s is refused, and nothing is pressed', async (button) => {
    const { down, up, seen } = await pressAndRelease(button);
    expect(down).toMatch(/^Error: pointer button: unknown value .* Valid: left, right, middle\.$/);
    expect(seen).toBeUndefined();
    expect(up).toMatch(/^Error: no pointer is held/);
  });

  it('an ordinary unknown button name is refused too', async () => {
    const { down, seen, up } = await pressAndRelease('middel');
    expect(down).toBe('Error: pointer button: unknown value "middel" — nothing was dispatched. Valid: left, right, middle.');
    expect(seen).toBeUndefined();
    expect(up).toMatch(/^Error: no pointer is held/);
  });

  // ⚠️ ACCEPT SIDE. A fix that answered 0 for everything would pass every case above while
  // making `middle` and `right` unreachable — and nothing else in the suite would notice.
  it.each([['left', 0], ['middle', 1], ['right', 2]] as const)(
    'ACCEPT: button %s still reaches code %i', async (name, code) => {
      const { down, up, seen } = await pressAndRelease(name);
      expect(seen).toBe(code);
      expect(down).toContain(`button ${name}`);
      expect(up).toContain(`button ${name}`);
    });
});

describe('handlePressKey modifier vocabulary (#1076)', () => {
  /** Press `key` with `modifiers` and report the reply plus every keydown the window saw. */
  async function press(modifiers: unknown): Promise<{ reply: string; downs: KeyboardEvent[] }> {
    const downs: KeyboardEvent[] = [];
    const onDown = (e: Event) => { downs.push(e as KeyboardEvent); };
    window.addEventListener('keydown', onDown);
    try {
      const reply = await handlePressKey({ key: 'z', modifiers });
      return { reply, downs };
    } finally {
      window.removeEventListener('keydown', onDown);
    }
  }

  // Before: `mods.includes('meta')` just never matched `'cmmd'`, so Cmd+Z went out as a plain `z` —
  // an undo became a keystroke — and the reply still said `ok (key z +cmmd)`.
  it('an unknown modifier is refused, and no key is pressed', async () => {
    const { reply, downs } = await press(['cmmd']);
    expect(reply).toBe('Error: press-key modifiers: unknown value "cmmd" — nothing was dispatched. Valid: ctrl, shift, alt, meta.');
    expect(downs).toEqual([]);
  });

  it('ACCEPT: a known modifier still reaches the event', async () => {
    const { reply, downs } = await press(['meta']);
    expect(reply).toMatch(/^ok \(key z \+meta\)/);
    expect(downs.map((e) => [e.key, e.metaKey])).toEqual([['z', true]]);
  });
});
