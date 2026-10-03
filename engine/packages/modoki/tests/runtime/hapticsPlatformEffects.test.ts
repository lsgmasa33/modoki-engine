/**
 * Android platform haptic effects (#2103) — the default path on a vibrator that reports them.
 *
 * What has to hold, each of which fails silently on a phone:
 *  - ON is the default, from one constant, and OFF hands the backend nothing (the old path);
 *  - every authored mapping field on `HapticSettings` is READ — perturbed here, not left at its
 *    default, because a value equal to the default cannot tell "read" from "ignored";
 *  - a vibrator that does not report an effect keeps the classic call for that preset (the A23
 *    reports nothing, and Android would otherwise substitute a different buzz);
 *  - a refused or failed native call still buzzes through the classic path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Capacitor } from '@capacitor/core';
import {
  playHaptic, configureHaptics, setHapticBackend, disposeHaptics, hapticsSystem, HapticSettings,
  AndroidEffectsHapticBackend, CapacitorHapticBackend, NoopHapticBackend, pickHapticBackend,
  parseAndroidEffect, isAndroidEffectSpecValid,
  ANDROID_EFFECT_FIELDS, DEFAULT_ANDROID_EFFECTS,
  hapticPlatformEffectsOn, setHapticPlatformEffects,
  type HapticBackend, type HapticPreset, type PlatformHapticEffect, type SystemHapticsPlugin,
} from '@modoki/engine/runtime';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { PRESET_VIBRATION_USAGE } from '../../src/runtime/haptics/platformEffects';

const PRESETS = Object.keys(ANDROID_EFFECT_FIELDS) as HapticPreset[];

class RecordingBackend implements HapticBackend {
  readonly canVibrate = true;
  readonly played: { preset: HapticPreset; platform: PlatformHapticEffect | undefined }[] = [];
  async play(preset: HapticPreset, platform?: PlatformHapticEffect): Promise<void> {
    this.played.push({ preset, platform });
  }
}

const TICK_EFFECT: PlatformHapticEffect = { kind: 'effect', effect: 'TICK' };

let rec: RecordingBackend;
beforeEach(() => {
  rec = new RecordingBackend();
  setHapticBackend(rec);
});
afterEach(() => {
  disposeHaptics();
  vi.restoreAllMocks();
});

describe('the authored mapping format', () => {
  it('reads a predefined effect', () => {
    expect(parseAndroidEffect('effect:TICK')).toEqual({ kind: 'effect', effect: 'TICK' });
  });

  it('reads primitives with scale and gap, defaulting both', () => {
    expect(parseAndroidEffect('CLICK, CLICK@0.7+65, THUD+45')).toEqual({
      kind: 'primitives',
      primitives: [
        { id: 'CLICK', scale: 1, delayMs: 0 },
        { id: 'CLICK', scale: 0.7, delayMs: 65 },
        { id: 'THUD', scale: 1, delayMs: 45 },
      ],
    });
  });

  it('empty means "no mapping" and is valid; a mistake is not', () => {
    expect(parseAndroidEffect('  ')).toBeNull();
    expect(isAndroidEffectSpecValid('  ')).toBe(true);
    for (const bad of ['effect:THUD', 'BUZZ', 'CLICK@1.5', 'CLICK@', 'CLICK,,TICK', 'click']) {
      expect(parseAndroidEffect(bad), bad).toBeNull();
      expect(isAndroidEffectSpecValid(bad), bad).toBe(false);
    }
  });

  it('every shipped default parses — a default that did not would silently keep the old call', () => {
    for (const preset of PRESETS) expect(parseAndroidEffect(DEFAULT_ANDROID_EFFECTS[preset]), preset).not.toBeNull();
  });
});

describe('the switch', () => {
  it('OFF hands the backend no platform effect', () => {
    configureHaptics({ enabled: true, masterIntensity: 1, platformEffects: false });
    playHaptic('select');
    expect(rec.played.map((p) => p.platform)).toEqual([undefined]);
  });

  it('ON is the default: with nothing configured at all, and for a caller that passes only the gates', () => {
    playHaptic('impact.light');   // a scene with no HapticSettings never configures the service
    configureHaptics({ enabled: true, masterIntensity: 1 });
    playHaptic('impact.light');
    expect(rec.played.map((p) => p.platform)).toEqual([TICK_EFFECT, TICK_EFFECT]);
  });

  it('ON hands over the preset\'s mapping', () => {
    configureHaptics({ enabled: true, masterIntensity: 1, platformEffects: true });
    playHaptic('impact.medium');
    expect(rec.played).toEqual([{ preset: 'impact.medium', platform: { kind: 'effect', effect: 'CLICK' } }]);
  });

  it('a mistyped mapping warns once and plays with no platform effect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureHaptics({
      enabled: true, masterIntensity: 1, platformEffects: true,
      androidEffects: { ...DEFAULT_ANDROID_EFFECTS, select: 'TICKK' },
    });
    playHaptic('select');
    playHaptic('select');
    expect(rec.played.map((p) => p.platform)).toEqual([undefined, undefined]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the warning fires where the value is AUTHORED: on a backend that cannot vibrate, with the switch off, before any play', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setHapticBackend(new NoopHapticBackend());
    configureHaptics({
      enabled: true, masterIntensity: 1, platformEffects: false,
      androidEffects: { ...DEFAULT_ANDROID_EFFECTS, warning: 'CLICK+' },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("'warning'");
  });

  it('disposeHaptics returns the switch and the mapping to their defaults', () => {
    configureHaptics({
      enabled: true, masterIntensity: 1, platformEffects: false,
      androidEffects: { ...DEFAULT_ANDROID_EFFECTS, select: 'LOW_TICK' },
    });
    disposeHaptics();
    setHapticBackend(rec);
    playHaptic('select');
    // ON again (it was off), and the default mapping (it was LOW_TICK).
    expect(rec.played[0].platform).toEqual(parseAndroidEffect(DEFAULT_ANDROID_EFFECTS.select));
  });

  it('an EMPTY mapping is a choice, not a mistake: no platform effect and no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureHaptics({
      enabled: true, masterIntensity: 1, platformEffects: true,
      androidEffects: { ...DEFAULT_ANDROID_EFFECTS, select: '' },
    });
    playHaptic('select');
    expect(rec.played[0].platform).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('HapticSettings is the authoring surface, and every field of it is read', () => {
  it('a perturbed value in each of the seven fields reaches the backend for its own preset', () => {
    const world = createWorld();
    // One distinct, non-default mapping per preset, so a field read for the wrong preset — or not
    // read at all — shows up as the wrong scale.
    const authored: Record<string, string | boolean | number> = { enabled: true, masterIntensity: 1, platformEffects: true };
    PRESETS.forEach((preset, i) => { authored[ANDROID_EFFECT_FIELDS[preset]] = `LOW_TICK@0.${i + 1}+${i + 11}`; });
    world.spawn(HapticSettings(authored as never));

    hapticsSystem(world);
    for (const preset of PRESETS) playHaptic(preset);

    expect(rec.played).toEqual(PRESETS.map((preset, i) => ({
      preset,
      platform: { kind: 'primitives', primitives: [{ id: 'LOW_TICK', scale: (i + 1) / 10, delayMs: i + 11 }] },
    })));
  });

  it('the trait\'s `platformEffects` is what turns it on — off in the scene, nothing is handed over', () => {
    const world = createWorld();
    world.spawn(HapticSettings({ platformEffects: false }));
    hapticsSystem(world);
    playHaptic('impact.heavy');
    expect(rec.played[0].platform).toBeUndefined();
  });

  it('the trait ships ON with the documented defaults — what a scene authoring `HapticSettings: {}` resolves to', () => {
    const world = createWorld();
    const s = world.spawn(HapticSettings()).get(HapticSettings)!;
    expect(s.platformEffects).toBe(true);
    for (const preset of PRESETS) expect(s[ANDROID_EFFECT_FIELDS[preset]]).toBe(DEFAULT_ANDROID_EFFECTS[preset]);
  });

  it('the debug-menu helpers write and read the trait', () => {
    const world = createWorld();
    setCurrentWorld(world);
    expect(setHapticPlatformEffects(false)).toBe(false);   // no HapticSettings yet: nothing to write
    expect(hapticPlatformEffectsOn()).toBe(true);          // and the service is at the default, ON
    world.spawn(HapticSettings({ enabled: false }));
    expect(hapticPlatformEffectsOn()).toBe(true);          // the trait's default: a checkbox starts ticked
    expect(setHapticPlatformEffects(false)).toBe(true);
    expect(hapticPlatformEffectsOn()).toBe(false);         // and still flips to the old path
    expect(world.queryFirst(HapticSettings)?.get(HapticSettings)?.enabled).toBe(false);   // the rest is kept
  });
});

/** The native plugin, as the S22 answers it (or as told). Records every play request. */
function fakePlugin(caps: { effects: string[]; primitives: string[] }, played: boolean | 'reject' = true) {
  const requests: Parameters<SystemHapticsPlugin['playHapticEffect']>[0][] = [];
  const plugin: SystemHapticsPlugin = {
    hapticCapabilities: async () => caps,
    playHapticEffect: async (options) => {
      requests.push(options);
      if (played === 'reject') throw new Error('refused');
      return { played };
    },
  };
  return { plugin, requests };
}
const S22 = {
  effects: ['CLICK', 'DOUBLE_CLICK', 'TICK', 'HEAVY_CLICK'],
  primitives: ['CLICK', 'THUD', 'SPIN', 'QUICK_RISE', 'SLOW_RISE', 'QUICK_FALL', 'TICK', 'LOW_TICK'],
};
const TICK: PlatformHapticEffect = { kind: 'effect', effect: 'TICK' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('the Android backend', () => {
  it('plays a supported effect natively, under the preset\'s usage, and NOT through the classic call', async () => {
    const { plugin, requests } = fakePlugin(S22);
    const b = new AndroidEffectsHapticBackend(rec, () => plugin);
    await flush();
    await b.play('impact.light', TICK);
    await b.play('success', parseAndroidEffect('CLICK, CLICK@0.7+65')!);
    expect(requests).toEqual([
      { effect: 'TICK', usage: 'touch' },
      { primitives: [{ id: 'CLICK', scale: 1, delayMs: 0 }, { id: 'CLICK', scale: 0.7, delayMs: 65 }], usage: 'media' },
    ]);
    expect(rec.played).toEqual([]);
  });

  it('keeps today\'s usage split: the impacts and select are touch, the notifications media', () => {
    expect(PRESET_VIBRATION_USAGE).toEqual({
      'impact.light': 'touch', 'impact.medium': 'touch', 'impact.heavy': 'touch', select: 'touch',
      success: 'media', warning: 'media', error: 'media',
    });
  });

  it('with the switch off (no platform effect) it is the classic call, even on an S22', async () => {
    const { plugin, requests } = fakePlugin(S22);
    const b = new AndroidEffectsHapticBackend(rec, () => plugin);
    await flush();
    await b.play('impact.light');
    expect(requests).toEqual([]);
    expect(rec.played.map((p) => p.preset)).toEqual(['impact.light']);
  });

  it('a vibrator that reports nothing (the A23) takes the classic call for every preset', async () => {
    const { plugin, requests } = fakePlugin({ effects: [], primitives: [] });
    const b = new AndroidEffectsHapticBackend(rec, () => plugin);
    await flush();
    for (const preset of PRESETS) await b.play(preset, parseAndroidEffect(DEFAULT_ANDROID_EFFECTS[preset])!);
    expect(requests).toEqual([]);
    expect(rec.played.map((p) => p.preset)).toEqual(PRESETS);
  });

  it('ONE unsupported primitive sends the whole preset to the classic call', async () => {
    const { plugin, requests } = fakePlugin({ effects: [], primitives: ['TICK'] });
    const b = new AndroidEffectsHapticBackend(rec, () => plugin);
    await flush();
    await b.play('error', parseAndroidEffect('TICK@0.6, THUD+45')!);
    await b.play('select', parseAndroidEffect('TICK@0.6')!);
    expect(requests).toHaveLength(1);
    expect(rec.played.map((p) => p.preset)).toEqual(['error']);
  });

  it('before the capability answer arrives, it is the classic call', async () => {
    const { plugin, requests } = fakePlugin(S22);
    const b = new AndroidEffectsHapticBackend(rec, () => plugin);
    await b.play('impact.light', TICK);   // no flush: capabilities still in flight
    expect(requests).toEqual([]);
    expect(rec.played.map((p) => p.preset)).toEqual(['impact.light']);
  });

  it('a native `played: false` falls back to the classic call rather than staying silent', async () => {
    const { plugin } = fakePlugin(S22, false);
    const b = new AndroidEffectsHapticBackend(rec, () => plugin);
    await flush();
    await b.play('impact.light', TICK);
    expect(rec.played.map((p) => p.preset)).toEqual(['impact.light']);
  });

  it('a rejected native call falls back too, and does not reject into the caller', async () => {
    const { plugin } = fakePlugin(S22, 'reject');
    const b = new AndroidEffectsHapticBackend(rec, () => plugin);
    await flush();
    await expect(b.play('impact.light', TICK)).resolves.toBeUndefined();
    expect(rec.played.map((p) => p.preset)).toEqual(['impact.light']);
  });

  it('a build without the plugin is the classic backend in effect', async () => {
    const b = new AndroidEffectsHapticBackend(rec, () => { throw new Error('not in this build'); });
    await flush();
    await b.play('impact.light', TICK);
    expect(rec.played.map((p) => p.preset)).toEqual(['impact.light']);
  });
});

describe('which backend a platform gets', () => {
  type Header = { name: string; methods: { name: string }[] };
  const cap = Capacitor as unknown as { Plugins?: Record<string, unknown>; PluginHeaders?: Header[] };
  const HAPTIC_METHODS = ['hapticCapabilities', 'playHapticEffect'];

  /** A native build: the platform, and the method list the system plugin's native side declares. */
  function native(platform: 'android' | 'ios', nativeMethods: string[] | null) {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue(platform);
    if (nativeMethods) {
      cap.PluginHeaders = [{ name: 'ModokiSystem', methods: nativeMethods.map((name) => ({ name })) }];
      cap.Plugins = { ...cap.Plugins, ModokiSystem: fakePlugin(S22).plugin };
    }
  }
  const savedPlugins = cap.Plugins;
  afterEach(() => {
    delete cap.PluginHeaders;
    cap.Plugins = savedPlugins;
  });

  it('Android with both native methods gets the effects backend, wired to the bridged plugin', async () => {
    native('android', ['openUrl', ...HAPTIC_METHODS]);
    const { plugin, requests } = fakePlugin(S22);
    cap.Plugins = { ...cap.Plugins, ModokiSystem: plugin };
    const b = pickHapticBackend();
    expect(b).toBeInstanceOf(AndroidEffectsHapticBackend);
    await flush();
    await b.play('impact.light', TICK);
    expect(requests).toEqual([{ effect: 'TICK', usage: 'touch' }]);   // reached Capacitor.Plugins.ModokiSystem
  });

  it('the FIRST haptic of a session is already the new path: the system warms the backend before any play', async () => {
    native('android', ['openUrl', ...HAPTIC_METHODS]);
    const { plugin, requests } = fakePlugin(S22);
    cap.Plugins = { ...cap.Plugins, ModokiSystem: plugin };
    setHapticBackend(null);                 // as at boot: nothing picked yet
    hapticsSystem(createWorld());           // one frame, in a scene with no HapticSettings at all
    await flush();                          // the capability answer arrives
    playHaptic('impact.light');
    await flush();
    expect(requests).toEqual([{ effect: 'TICK', usage: 'touch' }]);
  });

  it('Android whose binary predates the methods keeps the classic backend, each method required', () => {
    for (const methods of [['openUrl'], ['openUrl', HAPTIC_METHODS[0]], ['openUrl', HAPTIC_METHODS[1]]]) {
      native('android', methods);
      expect(pickHapticBackend(), methods.join()).toBeInstanceOf(CapacitorHapticBackend);
    }
  });

  it('Android with no system plugin at all keeps the classic backend', () => {
    native('android', null);
    expect(pickHapticBackend()).toBeInstanceOf(CapacitorHapticBackend);
  });

  it('iOS keeps the classic backend even if the methods were listed', () => {
    native('ios', ['openUrl', ...HAPTIC_METHODS]);
    expect(pickHapticBackend()).toBeInstanceOf(CapacitorHapticBackend);
  });

  it('off-device is the noop backend', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    expect(pickHapticBackend()).toBeInstanceOf(NoopHapticBackend);
  });
});
