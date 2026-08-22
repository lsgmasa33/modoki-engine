/** Installs the engine's `faultProvider` seam over `capacitor-game-debug` (#278).
 *
 *  L3 composition: the engine package declares the slot (runtime/core/faultProvider.ts) and cannot
 *  import the plugin — it is a dependency of the app shell, not of `@modoki/engine`. Side-effect
 *  import from main.tsx behind the same `__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__` gate as the
 *  other debug-menu wiring, so a release build never bundles it.
 *
 *  Non-native platforms deliberately register NOTHING: the Device tab then reports "no native
 *  runtime to fault" rather than showing buttons that would resolve cheerfully and do nothing. */

import { Capacitor } from '@capacitor/core';
import { faultProvider, type FaultKind } from '@modoki/engine/runtime';

/** iOS supports `crash` only — it has no ANR, and Crashlytics does not report foreground hangs at
 *  all (MetricKit's MXHangDiagnostic is that oracle, a different subsystem). Listing the other two
 *  on iOS would offer a probe that cannot pass. */
const KINDS_BY_PLATFORM: Record<string, FaultKind[]> = {
  android: ['crash', 'anr', 'uncaught'],
  ios: ['crash'],
};

if (Capacitor.isNativePlatform()) {
  const platform = Capacitor.getPlatform();
  faultProvider.provide({
    supported: () => KINDS_BY_PLATFORM[platform] ?? [],
    trigger: async (kind: FaultKind, opts?: { blockMs?: number }) => {
      // Import the MODULE NAMESPACE and read the plugin off it — never `await` the plugin object
      // itself. A Capacitor plugin proxy is thenable: awaiting it calls `then` on the native side,
      // which resolves to something that is not the plugin and silently sends nothing.
      const mod = await import('capacitor-game-debug');
      await mod.GameDebug.triggerFault({ kind, ...(opts?.blockMs != null ? { blockMs: opts.blockMs } : {}) });
    },
  });
}
