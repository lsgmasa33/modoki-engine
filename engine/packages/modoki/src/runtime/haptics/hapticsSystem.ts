/**
 * Haptics system — the ONE consumer of `HapticSettings`.
 *
 * All it does is copy the authored/live settings into the service each frame, so "are haptics on"
 * has exactly one home (the trait) and a play costs no world query — `playHaptic` fires from
 * inside gesture handling, where a query per call is exactly the cost that made Court's drag lag
 * on an iPhone 8.
 *
 * ⚠️ **This system never PLAYS anything**, and nothing that plays may live on a per-frame path.
 * Haptics are edge-triggered by definition: a moment fires from a state transition
 * (`commitPlace`, `markLevelSolved`, …). A haptic hung off a frame loop buzzes continuously.
 *
 * A scene with no `HapticSettings` entity leaves the service at its defaults (enabled, full
 * intensity), so a game gets working haptics without authoring anything — the same posture as the
 * default pattern set.
 */

import type { World } from 'koota';
import { HapticSettings } from '../traits/HapticSettings';
import { configureHaptics } from './hapticsService';

export function hapticsSystem(world: World): void {
  const e = world.queryFirst(HapticSettings);
  if (!e) return;
  const s = e.get(HapticSettings);
  if (!s) return;
  configureHaptics({ enabled: s.enabled, masterIntensity: s.masterIntensity });
}
