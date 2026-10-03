/**
 * Haptic backends — the platform adapter under `hapticsService`.
 *
 * Picked once, mirroring `storage/backends.ts`:
 *   - Capacitor — device (iOS + Android). The only tier that can vibrate anything.
 *   - Android effects — wraps the Capacitor tier on Android (#2103); see the class below.
 *   - Noop      — desktop, the browser, the editor, and every headless test.
 *
 * ⚠️ **There is no web tier.** `navigator.vibrate` is Android-Chrome-only, duration-only, needs a
 * user activation, and iOS Safari has nothing — so it could deliver at most a flat buzz to a
 * fraction of web players while reporting success everywhere. A partial channel that silently
 * differs by browser is worse than an honest noop. Revisit only with a real web consumer asking.
 *
 * A backend NEVER throws. Every failure this layer can hit is environmental and un-actionable by
 * game code — unsupported hardware, iOS Low Power Mode, the OS-level haptics setting turned off —
 * so they are swallowed here rather than surfaced. Haptics is presentation-only; it must not be
 * able to break a frame.
 */

import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import type { ModokiSystemPlugin } from 'capacitor-modoki-system';
import type { HapticPreset } from './patterns';
import { PRESET_VIBRATION_USAGE, type PlatformHapticEffect } from './platformEffects';

export interface HapticBackend {
  /**
   * Fire one preset. Fire-and-forget: resolves when the native call returns, rejects never.
   *
   * `platform` is the authored platform effect for this preset, present only while
   * `HapticSettings.platformEffects` is on (#2103). A backend that cannot render it ignores it and
   * plays the preset as it always has.
   */
  play(preset: HapticPreset, platform?: PlatformHapticEffect): Promise<void>;
  /** For diagnostics — is this tier capable of anything at all? */
  readonly canVibrate: boolean;
}

/** Nothing happens, successfully. The default everywhere that is not a device. */
export class NoopHapticBackend implements HapticBackend {
  readonly canVibrate = false;
  async play(): Promise<void> { /* deliberately nothing */ }
}

export class CapacitorHapticBackend implements HapticBackend {
  readonly canVibrate = true;

  async play(preset: HapticPreset): Promise<void> {
    try {
      switch (preset) {
        case 'impact.light': await Haptics.impact({ style: ImpactStyle.Light }); return;
        case 'impact.medium': await Haptics.impact({ style: ImpactStyle.Medium }); return;
        case 'impact.heavy': await Haptics.impact({ style: ImpactStyle.Heavy }); return;
        case 'success': await Haptics.notification({ type: NotificationType.Success }); return;
        case 'warning': await Haptics.notification({ type: NotificationType.Warning }); return;
        case 'error': await Haptics.notification({ type: NotificationType.Error }); return;
        case 'select':
          // ⚠️ THREE calls, and the middle one is the only one that vibrates. On BOTH platforms
          // `selectionStart()` merely arms the generator (Android sets a flag; iOS constructs a
          // UISelectionFeedbackGenerator) and `selectionEnd()` tears it down — `selectionChanged()`
          // is what actually reaches the hardware. A start→end pair produces NOTHING, silently.
          // This shipped that way once and no unit test caught it: the test counted
          // `selectionStart`, i.e. asserted on the call that cannot buzz. Found by reading
          // `dumpsys vibrator_manager` on a real phone.
          await Haptics.selectionStart();
          await Haptics.selectionChanged();
          await Haptics.selectionEnd();
          return;
      }
    } catch {
      // Unsupported hardware, Low Power Mode, OS haptics disabled — all silent by contract.
    }
  }
}

/** The two `capacitor-modoki-system` methods this file calls — Android only. */
export type SystemHapticsPlugin = Pick<ModokiSystemPlugin, 'hapticCapabilities' | 'playHapticEffect'>;

/**
 * Android, with `capacitor-modoki-system` in the build (#2103): plays a preset's authored platform
 * effect when the vibrator reports everything that effect needs, and otherwise hands the preset to
 * the classic backend unchanged.
 *
 * Support is decided PER PLAY against the vibrator's reported lists, never assumed: Android
 * substitutes a generic vibration for an unsupported predefined effect, which on a phone with no
 * capabilities (the Galaxy A23) would replace today's feel with a different buzz while reporting
 * success. Until the capability query has answered, everything takes the classic path.
 */
export class AndroidEffectsHapticBackend implements HapticBackend {
  readonly canVibrate = true;
  private effects: ReadonlySet<string> = new Set();
  private primitives: ReadonlySet<string> = new Set();
  private readonly classic: HapticBackend;
  private readonly plugin: () => SystemHapticsPlugin;

  constructor(classic: HapticBackend, plugin: () => SystemHapticsPlugin = bridgedSystemHaptics) {
    this.classic = classic;
    this.plugin = plugin;
    void this.loadCapabilities();
  }

  private async loadCapabilities(): Promise<void> {
    try {
      const caps = await this.plugin().hapticCapabilities();
      this.effects = new Set(caps.effects);
      this.primitives = new Set(caps.primitives);
    } catch {
      // No answer means nothing is supported: every preset stays on the classic path.
    }
  }

  /** Can this vibrator render the WHOLE effect? One unsupported primitive disqualifies it. */
  supports(platform: PlatformHapticEffect): boolean {
    if (platform.kind === 'effect') return this.effects.has(platform.effect);
    return platform.primitives.length > 0 && platform.primitives.every((p) => this.primitives.has(p.id));
  }

  async play(preset: HapticPreset, platform?: PlatformHapticEffect): Promise<void> {
    if (platform && this.supports(platform)) {
      try {
        const usage = PRESET_VIBRATION_USAGE[preset];
        const { played } = await this.plugin().playHapticEffect(
          platform.kind === 'effect'
            ? { effect: platform.effect, usage }
            : { primitives: platform.primitives.map((p) => ({ ...p })), usage },
        );
        if (played) return;
      } catch {
        // Fall through: a refused native call must still buzz, as it did before this path existed.
      }
    }
    await this.classic.play(preset);
  }
}

const SYSTEM_PLUGIN = 'ModokiSystem';

function bridgedSystemHaptics(): SystemHapticsPlugin {
  const plugin = (Capacitor as unknown as { Plugins?: Record<string, SystemHapticsPlugin | undefined> }).Plugins?.[SYSTEM_PLUGIN];
  if (!plugin) throw new Error('[haptics] capacitor-modoki-system is not in this native build');
  return plugin;
}

/** True when this native build's system plugin has the haptic methods. Read from the native
 *  `PluginHeaders`, not from `typeof Plugins.ModokiSystem.x` — a game that imports the plugin's JS
 *  replaces that entry with a proxy answering a function for ANY name (`storage/backends.ts`). So a
 *  JS bundle delivered by OTA to an older binary keeps the classic backend. */
function hasSystemHaptics(): boolean {
  const headers = (Capacitor as unknown as { PluginHeaders?: readonly { name: string; methods?: readonly { name: string }[] }[] }).PluginHeaders;
  const methods = new Set(headers?.find((h) => h.name === SYSTEM_PLUGIN)?.methods?.map((m) => m.name) ?? []);
  return methods.has('hapticCapabilities') && methods.has('playHapticEffect');
}

/**
 * Pick the backend for this platform. Resolved ONCE by `hapticsService`: `isNativePlatform()`
 * cannot change within a session, and the editor/web answer is "no" for the whole run.
 */
export function pickHapticBackend(): HapticBackend {
  if (!Capacitor.isNativePlatform()) return new NoopHapticBackend();
  const classic = new CapacitorHapticBackend();
  return Capacitor.getPlatform() === 'android' && hasSystemHaptics()
    ? new AndroidEffectsHapticBackend(classic)
    : classic;
}
