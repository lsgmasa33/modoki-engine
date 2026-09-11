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
import { handlePointer, _resetHeldPointerForTests } from '../../app/debug/bridge';

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

describe('handlePointer button vocabulary (#993)', () => {
  it.each(PROTO_KEYS)('button %s falls back to left (0), not a function', async (button) => {
    const { down, up, seen } = await pressAndRelease(button);
    expect(down).toMatch(/^ok /);
    expect(seen).toBe(0);
    // The discriminator: the HELD button survives uncoerced, and the release reads it back.
    expect(up).toContain('button left');
    expect(up).not.toContain('button undefined');
  });

  it('an ordinary unknown button name falls back to left too', async () => {
    const { seen, up } = await pressAndRelease('middel');
    expect(seen).toBe(0);
    expect(up).toContain('button left');
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
