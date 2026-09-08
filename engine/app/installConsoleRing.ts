/**
 * Side-effect module: installs the ONE shared engine console ring EAGERLY (#596/#597 Stage 2).
 *
 * ⚠️ IT EXISTS ONLY FOR ITS POSITION, same rationale as `./installErrorCapture.ts` and
 * `./installDeviceConsoleCapture.ts`. Imported ABOVE `./App.tsx` in `main.tsx`, because a
 * side-effect import is the only construct that runs before `main.tsx`'s own statements do — and
 * ABOVE `./installDeviceConsoleCapture` too, so the shared ring is already wrapping `console.*`
 * (and `./debug/uncaughtCapture`'s window-error listeners are already registered) before that
 * module's own `setConsoleSource` projection ever runs. Keep it there, and keep this file's own
 * import list minimal — anything it pulls in is itself uncovered by the capture.
 *
 * THIS is what actually captures boot, now. `runtime/core/consoleRing.ts` (Stage 1) is the one
 * shared ring every other console capture in the app will PROJECT from rather than patch
 * independently — installing it here, ahead of everything else in `main.tsx`'s static import
 * graph, is what makes that true for a mount-time `console.info`/`.warn`/`.error` the same way
 * `./installErrorCapture.ts` and `./installDeviceConsoleCapture.ts` already do for their own
 * narrower slices.
 *
 * CAPACITY. `1000` in the editor matches the editor Console panel's existing `MAX_LOGS`, so moving
 * that panel onto this ring later (Stage 3) loses no history it shows today. `512` everywhere else
 * covers a debug device build without regressing #154's low-end budget: today's device ring holds
 * 200 entries and the in-game one 300, and 512 is not a shrink against that combined total.
 * `bootPrefix: 128` pins the earliest 128 lines so boot survives ANY later log volume — a size
 * increase alone cannot promise that, because a live error loop can evict a ring of any capacity;
 * only a portion that is never evicted can.
 *
 * THE GATE IS DELIBERATELY WIDER than `./installDeviceConsoleCapture.ts`'s — not equivalent, not a
 * copy-paste — and that asymmetry is load bearing, not a mistake to reconcile
 * (`deviceConsoleCaptureInstallOrder.test.ts` pins both the gate text AND that they differ). The
 * device gate requires `__MODOKI_DEBUG_BUILD__ && Capacitor.isNativePlatform()`, so in a debug WEB
 * build the device ring never exists — while the in-game debug ring (`runtime/debug`, gated
 * `__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__`) does. A shared ring installed on the device's
 * narrower gate would be INERT there: nothing wraps `console.*`, so a consumer reading the shared
 * ring on a debug web build would see an empty buffer and read that as "no logs" instead of "no
 * capture" — the exact defect class #596/#597 exists to end. So this gate is the SUPERSET of every
 * consumer's own gate, written inline rather than through a shared `isEnabled()` helper so it
 * CONSTANT-FOLDS at this call site — a function call cannot fold the same way, and losing that
 * would keep this reachable in a release build the flags say should have nothing here. A release
 * game build still folds this whole expression to `false` and DCEs it, same as every other gate in
 * `main.tsx`.
 *
 * #596/#597 STAGE 3a also registers `./debug/uncaughtCapture`'s `window` `error`/`unhandledrejection`
 * listeners from THIS gate, not `./installDeviceConsoleCapture.ts`'s narrower one. Before Stage 3a
 * those listeners lived in TWO places (`deviceConsoleCapture.ts` and `agentBridge.ts`), each feeding
 * the one shared ring once Stage 2 landed — so every uncaught error produced two ring entries. There
 * is now exactly one registration, and it must ride the SUPERSET gate: the device gate requires
 * `DEV || VITE_DEBUG_BRIDGE || (__MODOKI_DEBUG_BUILD__ && Capacitor.isNativePlatform())`, so a
 * packaged editor or a debug WEB build would leave uncaught errors uncaptured while `agentBridge`
 * (the thing that used to carry a copy of its own) is fully active — the exact inert-mechanism trap
 * this whole refactor exists to end.
 */

import { installConsoleRing } from '@modoki/engine/runtime/core/consoleRing';
import { installUncaughtCapture } from './debug/uncaughtCapture';

if (!__MODOKI_PLAYABLE__ && (import.meta.env.DEV || import.meta.env.VITE_DEBUG_BRIDGE || __MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__)) {
  // retainCallSite (#626): editor-only, deliberately gated on __MODOKI_EDITOR__ rather than left on
  // unconditionally. Retaining up to 1000 live `Error` objects — one per warn/error entry, so the
  // editor Console panel can still show WHERE a call came from even when it logged no `Error` — is
  // exactly the cost #154's low-end device budget must not pay, and this flag is what keeps it off
  // a device.
  installConsoleRing({ capacity: __MODOKI_EDITOR__ ? 1000 : 512, bootPrefix: 128, retainCallSite: __MODOKI_EDITOR__ });
  installUncaughtCapture();
}
