/**
 * Haptic backends — the platform adapter under `hapticsService`.
 *
 * Two tiers, picked once, mirroring `storage/backends.ts`:
 *   - Capacitor — device (iOS + Android). The only tier that can vibrate anything.
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
import type { HapticPreset } from './patterns';

export interface HapticBackend {
  /** Fire one preset. Fire-and-forget: resolves when the native call returns, rejects never. */
  play(preset: HapticPreset): Promise<void>;
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

/**
 * Pick the backend for this platform. Resolved ONCE by `hapticsService`: `isNativePlatform()`
 * cannot change within a session, and the editor/web answer is "no" for the whole run.
 */
export function pickHapticBackend(): HapticBackend {
  return Capacitor.isNativePlatform() ? new CapacitorHapticBackend() : new NoopHapticBackend();
}
