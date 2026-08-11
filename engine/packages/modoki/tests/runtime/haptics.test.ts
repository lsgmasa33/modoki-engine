/**
 * Haptics subsystem — the engine half of what Court's Phase −1 spike proved out.
 *
 * The load-bearing behaviours, each of which has already failed once somewhere:
 *  - the DEFAULT set resolves with no game authoring, and a game can add to or override it;
 *  - `select` reaches `selectionChanged`, not just start/end (the bug that shipped silent);
 *  - a pattern is spaced by CUMULATIVE delay, not per-step;
 *  - the journal event fires even off-device, since that is the only headless verification route;
 *  - nothing throws into game code, ever;
 *  - teardown cancels beats still in flight.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  playHaptic, configureHaptics, setHapticBackend, disposeHaptics,
  registerHapticPatterns, clearHapticPatterns, resolveHapticPattern, hapticPatternNames,
  ENGINE_HAPTIC_PATTERNS, NoopHapticBackend, cancelPendingHaptics,
  type HapticBackend, type HapticPreset,
} from '@modoki/engine/runtime';
import { createTestWorld, registerHapticControls, HapticSettings } from '@modoki/engine/runtime';
import { createWorld } from 'koota';
import { dispatchUIAction } from '../../src/runtime/core/actionRegistry';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { setPlayState } from '../../src/runtime/core/playState';

/** A backend that records what it was asked to play and claims it CAN vibrate, so the service
 *  takes the device path instead of short-circuiting at the noop check. */
class RecordingBackend implements HapticBackend {
  readonly canVibrate = true;
  readonly played: HapticPreset[] = [];
  async play(preset: HapticPreset): Promise<void> { this.played.push(preset); }
}

let rec: RecordingBackend;

beforeEach(() => {
  vi.useFakeTimers();
  rec = new RecordingBackend();
  setHapticBackend(rec);
  configureHaptics({ enabled: true, masterIntensity: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  clearHapticPatterns();
  disposeHaptics();
});

describe('the default set', () => {
  it('resolves the engine defaults with no game authoring at all', () => {
    expect(resolveHapticPattern('impact.light')).toBeDefined();
    expect(resolveHapticPattern('success')).toBeDefined();
    expect(resolveHapticPattern('refuse')).toBeDefined();
  });

  it('ships refuse and celebrate as SEQUENCES — a single beat cannot carry either meaning', () => {
    // A one-beat refusal reads as a heavier landing; a one-beat celebration cannot rise. On a
    // phone with no amplitude control the gap is the ONLY thing left that distinguishes them.
    expect(ENGINE_HAPTIC_PATTERNS.refuse.length).toBeGreaterThan(1);
    expect(ENGINE_HAPTIC_PATTERNS.celebrate.length).toBeGreaterThan(1);
  });

  it('returns undefined for an unknown name rather than inventing one', () => {
    expect(resolveHapticPattern('nope.not.a.thing')).toBeUndefined();
  });
});

describe('a game adds to and overrides the default set', () => {
  it('resolves a game-registered name', () => {
    registerHapticPatterns({ 'court.illegal': [{ preset: 'impact.heavy', delayMs: 0 }] });
    expect(resolveHapticPattern('court.illegal')).toHaveLength(1);
    expect(hapticPatternNames()).toContain('court.illegal');
  });

  it('lets a game REPLACE an engine default under the same name', () => {
    registerHapticPatterns({ refuse: [{ preset: 'select', delayMs: 0 }] });
    expect(resolveHapticPattern('refuse')).toEqual([{ preset: 'select', delayMs: 0 }]);
  });

  it('clearHapticPatterns restores the engine default rather than deleting the name', () => {
    registerHapticPatterns({ refuse: [{ preset: 'select', delayMs: 0 }] });
    clearHapticPatterns();
    expect(resolveHapticPattern('refuse')).toBe(ENGINE_HAPTIC_PATTERNS.refuse);
  });
});

describe('playback', () => {
  it('fires the first beat immediately and later beats on their CUMULATIVE delay', () => {
    registerHapticPatterns({
      three: [
        { preset: 'impact.light', delayMs: 0 },
        { preset: 'impact.medium', delayMs: 80 },
        { preset: 'success', delayMs: 110 },
      ],
    });
    playHaptic('three');
    expect(rec.played).toEqual(['impact.light']);
    vi.advanceTimersByTime(80);
    expect(rec.played).toEqual(['impact.light', 'impact.medium']);
    vi.advanceTimersByTime(109);
    expect(rec.played).toHaveLength(2);          // beat 3 is at 190ms, not 110ms
    vi.advanceTimersByTime(1);
    expect(rec.played).toEqual(['impact.light', 'impact.medium', 'success']);
  });

  it('plays nothing when disabled', () => {
    configureHaptics({ enabled: false, masterIntensity: 1 });
    playHaptic('refuse');
    vi.runAllTimers();
    expect(rec.played).toEqual([]);
  });

  it('plays nothing at zero master intensity', () => {
    configureHaptics({ enabled: true, masterIntensity: 0 });
    playHaptic('refuse');
    vi.runAllTimers();
    expect(rec.played).toEqual([]);
  });

  it('does not throw when the backend rejects — presentation must never break a frame', () => {
    setHapticBackend({
      canVibrate: true,
      play: () => Promise.reject(new Error('Low Power Mode')),
    });
    expect(() => playHaptic('impact.light')).not.toThrow();
  });

  it('cancels beats still in flight on teardown', () => {
    registerHapticPatterns({ late: [{ preset: 'impact.light', delayMs: 0 }, { preset: 'error', delayMs: 500 }] });
    playHaptic('late');
    expect(rec.played).toHaveLength(1);
    cancelPendingHaptics();
    vi.advanceTimersByTime(1000);
    expect(rec.played).toHaveLength(1);   // the queued beat never reached the next scene
  });
});

describe('inherited object keys are not patterns (regression)', () => {
  // A plain object inherits from Object.prototype, so a bare `map[name]` lookup answered
  // 'constructor' with the Object FUNCTION. It has a `.length` (arity 1), so it slipped past the
  // empty-pattern guard, and `pattern.forEach` then threw straight through the module's
  // "never throws into game code" contract. Reachable from AUTHORED data: a scene binding
  // `haptics.play` with `{ pattern: "constructor" }` is enough.
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'resolves %s to undefined, not an inherited member', (name) => {
      expect(resolveHapticPattern(name)).toBeUndefined();
    });

  it('playHaptic does not throw for an inherited key', () => {
    expect(() => playHaptic('constructor')).not.toThrow();
    expect(rec.played).toEqual([]);
  });

  it('a game pattern named after an inherited key still resolves', () => {
    // The fix must not over-correct into "these names are banned".
    registerHapticPatterns({ constructor: [{ preset: 'select' as const, delayMs: 0 }] });
    expect(resolveHapticPattern('constructor')).toHaveLength(1);
  });
});

describe('teardown cancels in-flight beats', () => {
  // `cancelPendingHaptics` existed with a doc comment telling callers to use it on teardown, and
  // NOTHING called it — the repo's dominant defect shape, a mechanism that cannot fire. It is
  // wired to onWorldSwap now; this pins the behaviour the wiring exists to produce.
  it('a queued beat does not survive a cancel', () => {
    registerHapticPatterns({ late: [{ preset: 'impact.light', delayMs: 0 }, { preset: 'error', delayMs: 400 }] });
    playHaptic('late');
    expect(rec.played).toEqual(['impact.light']);
    cancelPendingHaptics();
    vi.advanceTimersByTime(2000);
    expect(rec.played).toEqual(['impact.light']);   // the 'error' beat never reached the next scene
  });

  it('a WORLD SWAP cancels them — this is the wiring, not just the function', () => {
    // The function was always correct; what was missing was anything calling it. Asserting the
    // function alone would have passed for the entire time the mechanism was dead, so this drives
    // the real trigger: making another world current fires onWorldSwap.
    registerHapticPatterns({ late: [{ preset: 'impact.light', delayMs: 0 }, { preset: 'error', delayMs: 400 }] });
    playHaptic('late');
    expect(rec.played).toEqual(['impact.light']);
    const next = createTestWorld({});          // becomes the current world -> onWorldSwap
    try {
      vi.advanceTimersByTime(2000);
      expect(rec.played).toEqual(['impact.light']);
    } finally {
      next.dispose();
    }
  });
});

describe('the journal event — the only headless verification route', () => {
  it('records a play even on the noop backend, so a test can assert with no hardware', () => {
    const tw = createTestWorld({});
    try {
      setHapticBackend(new NoopHapticBackend());
      playHaptic('celebrate', tw.world);
      const types = tw.events().map((e) => e.type);
      expect(types).toContain('haptic');
    } finally {
      tw.dispose();
    }
  });

  it('warns on an unknown name — a typo is a game bug, unlike an environment failure', () => {
    const tw = createTestWorld({});
    try {
      playHaptic('court.typo', tw.world);
      expect(tw.events().map((e) => e.type)).toContain('haptic.unknown');
    } finally {
      tw.dispose();
    }
  });
});

/** The DECLARATIVE layer — `hapticControls.ts`'s three UIActions, dispatched the way
 *  `ui/bindings.ts` dispatches them.
 *
 *  ⚠️ THIS BLOCK EXISTS BECAUSE ITS ABSENCE HID A DEAD ACTION FOR THE LIFE OF THE MODULE. Every
 *  test above drives `playHaptic` directly, so `haptics.play` could read its pattern out of a
 *  field no authored binding can populate (`ctx.payload`, typed `string | number`, where the
 *  handler expected an object) and stay green: authoring a pattern silently played `'select'`,
 *  and `haptics.set` did nothing at all. Found 2026-08-11 building the neighbouring `quality.set`.
 *  Dispatch through the registry with the shapes bindings.ts really delivers, or this rots again. */
describe('the declarative actions (hapticControls)', () => {
  beforeEach(() => {
    registerHapticControls();
    setCurrentWorld(createWorld());
    setPlayState('playing'); // dispatchUIAction is inert unless the sim is running
  });

  it('plays the AUTHORED pattern, not the default — `params: { pattern }`', () => {
    registerHapticPatterns({ 'test.buzz': [{ preset: 'impact.heavy', delayMs: 0 }] });
    dispatchUIAction('haptics.play', { params: { pattern: 'test.buzz' } });
    vi.runAllTimers();
    expect(rec.played).toHaveLength(1);
    expect(rec.played[0]).toBe('impact.heavy');
  });

  it('takes the pattern from `payload` too — a control emitting `$value`', () => {
    registerHapticPatterns({ 'test.buzz': [{ preset: 'impact.heavy', delayMs: 0 }] });
    dispatchUIAction('haptics.play', { payload: 'test.buzz' });
    vi.runAllTimers();
    expect(rec.played[0]).toBe('impact.heavy');
  });

  it('falls back to `select` only when nothing was authored', () => {
    dispatchUIAction('haptics.play', {});
    vi.runAllTimers();
    expect(rec.played).toHaveLength(1);
  });

  it('`haptics.set` writes the authored boolean into HapticSettings', () => {
    const world = createWorld();
    setCurrentWorld(world);
    world.spawn(HapticSettings({ enabled: true, masterIntensity: 1 }));
    dispatchUIAction('haptics.set', { params: { enabled: false } });
    expect(world.queryFirst(HapticSettings)?.get(HapticSettings)?.enabled).toBe(false);
  });

  it('`haptics.toggle` flips it', () => {
    const world = createWorld();
    setCurrentWorld(world);
    world.spawn(HapticSettings({ enabled: false, masterIntensity: 1 }));
    dispatchUIAction('haptics.toggle', {});
    expect(world.queryFirst(HapticSettings)?.get(HapticSettings)?.enabled).toBe(true);
  });
});
