/** #338 — the GPU pool reveal gate.
 *
 *  ⚠️ WHAT THIS TEST CAN AND CANNOT DO. It pins the gate's LOGIC and RATCHETS the delay constant.
 *  It cannot verify the constant is correct: the bug it exists to prevent is a full-screen white
 *  flash for two frames on a real GPU, visible only in a screen recording's per-frame luma. No
 *  jsdom test can see that. So the value's justification lives in `gpuPoolReveal.ts`'s header as a
 *  two-device bisect table, and this file's job is to make sure nobody lowers it without reading it.
 */
import { describe, it, expect } from 'vitest';
import { REVEAL_DELAY_FRAMES, poolRevealDue } from '../../src/runtime/particles/gpuPoolReveal';

describe('poolRevealDue — a fresh GPU pool stays hidden until its init compute has landed', () => {
  it('hides every frame before the threshold and reveals from it — LITERALS on purpose', () => {
    // ⚠️ Deliberately not `for (n = 0; n < REVEAL_DELAY_FRAMES; n++) expect(false)`. That form
    // reduces to "n >= C is false for n < C", a tautology that passes for EVERY C — it pins the
    // comparison's shape and says nothing about the value. These literals are the measured
    // device behaviour: frames 0-2 flashed, frame 3 was clean.
    expect(poolRevealDue(0)).toBe(false);
    expect(poolRevealDue(2)).toBe(false);   // measured FLASHING on both devices
    expect(poolRevealDue(3)).toBe(false);   // measured MARGINAL — flashed 1 run in 4
    expect(poolRevealDue(6)).toBe(true);
    expect(poolRevealDue(50)).toBe(true);
  });

  it('fails CLOSED on a nonsense count — hidden beats flashing', () => {
    // The asymmetry is the whole design: a wrong "hide" costs one invisible frame, a wrong
    // "reveal" costs a full-screen white flash. So garbage must not open the gate.
    for (const bad of [-1, -100, NaN, Infinity, -Infinity]) {
      expect(poolRevealDue(bad), `${bad} must not reveal`).toBe(false);
    }
  });
});

describe('the delay constant is a RATCHET, not a tuning knob (#338)', () => {
  it('is EXACTLY 6 — double the marginal value, because the failure is INTERMITTENT', () => {
    // ⚠️ 3 was the first value that LOOKED clean, and shipping it would have been wrong. The
    // failure is intermittent: one build pinned at 3, run four times, gave 204.1 / 118.1 / 117.9
    // / 118.0 — a flash in one take of four. The original bisect ran a single take per value, so
    // it could not tell "the threshold" from "usually enough". 6 is double the observed edge and
    // was verified by REPEATED takes.
    //
    // Lowering this is what the bug looks like coming back; raising it trades the flash for a
    // visible hole (at 60fps this is already ~117ms of a fresh pool drawing nothing, invisible
    // only because a station cuts in from black). Both directions are hardware claims, so both
    // need repeated takes on a device — see the header for the method.
    expect(REVEAL_DELAY_FRAMES).toBe(6);
  });

});
