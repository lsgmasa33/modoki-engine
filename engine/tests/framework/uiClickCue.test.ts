/**
 * `ui.click` — the built-in button-click cue raised by `applyBindings`.
 *
 * Why the BINDING layer and not the game: a game cannot see every button. Court put its click on
 * its own chrome dispatcher and the settings panel stayed silent, because those rows open and
 * close through plain `set` bindings authored in the scene — no game code runs there at all, so
 * no game code could have made a sound. Anything that fixes that per-button is a list somebody
 * has to maintain, and it goes stale on the first button added; this is the one place every
 * button provably passes through.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, applyBindings, registerUIAction, unregisterUIAction, drainAudioCues,
  clearAudioCues, registerAudioControls, cueSound, type UIActionBinding,
} from '../../packages/modoki/src/runtime/index';
import { setUIClickCue } from '../../packages/modoki/src/runtime/ui/bindings';

const ACTION = 'test.noop';
let tw: Awaited<ReturnType<typeof createTestWorld>> | undefined;

beforeEach(async () => {
  // The REAL wiring path: `runtime/ui/` may not import `runtime/audio/`, so the cue is installed
  // from the audio side. Calling the registrar (rather than `setUIClickCue` directly) is what
  // makes this a test of the seam actually being connected, not just of the setter existing.
  registerAudioControls();
  tw = await createTestWorld({ systems: [] });
  registerUIAction(ACTION, () => {});
  clearAudioCues(tw.world);
});
afterEach(async () => { unregisterUIAction(ACTION); await tw?.dispose(); tw = undefined; });

const call = (event: UIActionBinding['event']): UIActionBinding[] =>
  [{ event, kind: 'call', action: ACTION }];
const cues = () => drainAudioCues(tw!.world).map((c) => c.name);

describe('an unregistered cue is silent', () => {
  it('a game that never wires audio pushes nothing', () => {
    // `registerAudioControls` is idempotent, so it cannot re-arm what this clears — restore the
    // hook by hand rather than by calling the registrar again, or every later test in this file
    // runs against a disarmed seam and passes for the wrong reason.
    setUIClickCue(null);
    try {
      applyBindings(call('click'), 'click', { selfGuid: 'g1' });
      expect(cues()).toEqual([]);
    } finally {
      setUIClickCue(() => cueSound('ui.click'));
    }
  });
});

describe('a bound click raises exactly one cue', () => {
  it('raises ui.click', () => {
    applyBindings(call('click'), 'click', { selfGuid: 'g1' });
    expect(cues()).toEqual(['ui.click']);
  });

  it('raises it ONCE even when the element carries several click bindings', () => {
    // The canonical two-binding button (a `set` that writes its own state, then a `call`) must
    // click once, not twice — two voices on one press is an audible flam, not a louder click.
    applyBindings([...call('click'), ...call('click')], 'click', { selfGuid: 'g1' });
    expect(cues()).toEqual(['ui.click']);
  });
});

describe('the events that are NOT a press', () => {
  it('stays silent on a CONTINUOUS change — a slider drag fires it per pixel', () => {
    // It is `continuous: true` that makes this silent, not the event name 'change' — a toggle's
    // discrete 'change' (below) fires the same event name and DOES click (#528). Dragging a
    // volume slider emits `change` per pixel; clicking on that would be a machine-gun, and it is
    // the exact surface that prompted the cue.
    applyBindings(call('change'), 'change', { selfGuid: 'g1', eventValue: 42, continuous: true });
    expect(cues()).toEqual([]);
  });

  it('stays silent on submit — deliberately exempt, not a side effect (owner, 2026-09-01)', () => {
    // 'submit' IS discrete by the shared predicate `isDiscrete` (it takes the input lock same as
    // click), so this is NOT the same case as the continuous slider above — it is carved out on
    // purpose in applyBindings because Enter in a text field follows typing, and a tap sound would
    // read as a keyboard click rather than a button press. Keep this test: without it, a future
    // reader could "unify" submit into the shared predicate and this would silently start clicking.
    applyBindings(call('submit'), 'submit', { selfGuid: 'g1', eventValue: 'text' });
    expect(cues()).toEqual([]);
  });
});

describe('a toggle (#528)', () => {
  it("a discrete 'change' (no continuous flag) raises the cue exactly once", () => {
    // The regression this issue is about: UIToggle activates via 'change', not 'click', and the
    // old `event === 'click'` test silenced it. This is the same call UINode.tsx's fire() makes
    // for a toggle — no `continuous` flag, so it is a discrete activation.
    applyBindings(call('change'), 'change', { selfGuid: 'g1', eventValue: true });
    expect(cues()).toEqual(['ui.click']);
  });

  it("a discrete 'change' still respects the input lock", () => {
    // The lock and the cue now share one predicate (#528) — a second discrete activation while
    // the first is still locked must swallow the WHOLE event, cue included, same as a double
    // click already did.
    applyBindings(call('change'), 'change', { selfGuid: 'g1', eventValue: true });
    applyBindings(call('change'), 'change', { selfGuid: 'g2', eventValue: false });
    expect(cues()).toEqual(['ui.click']);
  });
});

describe('what does not earn a click', () => {
  it('an element with no binding for THIS event is silent', () => {
    // `applyBindings` returns before the cue when no row matches, so a click on an element that
    // only binds `change` is not a press to acknowledge — it is a miss.
    applyBindings(call('change'), 'click', { selfGuid: 'g1' });
    expect(cues()).toEqual([]);
  });

  it('an element with no bindings at all is silent', () => {
    applyBindings(undefined, 'click', { selfGuid: 'g1' });
    applyBindings([], 'click', { selfGuid: 'g1' });
    expect(cues()).toEqual([]);
  });
});
