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
  it('stays silent on change — a slider drag fires it continuously', () => {
    // The reason this matters: dragging a volume slider emits `change` per pixel. Clicking on
    // that would be a machine-gun, and it is the exact surface that prompted the cue.
    applyBindings(call('change'), 'change', { selfGuid: 'g1', eventValue: 42 });
    expect(cues()).toEqual([]);
  });

  it('stays silent on submit — that is a keystroke', () => {
    applyBindings(call('submit'), 'submit', { selfGuid: 'g1', eventValue: 'text' });
    expect(cues()).toEqual([]);
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
