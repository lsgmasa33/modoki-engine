/**
 * Side-effect module: installs the device console-capture ring EAGERLY (#591).
 *
 * ⚠️ IT EXISTS ONLY FOR ITS POSITION, same rationale as `./installErrorCapture.ts`. The capture used
 * to be reachable only through `initDebugBridge()`, behind `main.tsx`'s ASYNC dynamic
 * `import('./debug/bridge')` — and `createRoot().render()` runs synchronously right after that
 * import starts, so React mounts, and its effects run, before that chunk is guaranteed to have
 * resolved. Whether a mount-time `console.info` was captured depended on how fast the chunk loaded:
 * the SAME build captured it on an iPad mini 5 and did not on a Galaxy S22 — a RACE, not a platform
 * quirk. An absent device log was never trustworthy evidence of anything.
 *
 * Imported ABOVE `./App.tsx` in `main.tsx`, because a side-effect import is the only construct that
 * runs before `main.tsx`'s own statements do. Keep it there, and keep this file's own import list
 * minimal — anything it pulls in is itself uncovered.
 *
 * ⚠️ WHAT THIS DOES *NOT* COVER, measured rather than assumed — a module-eval-time log inside
 * App.tsx's own graph. DEVICE-VERIFIED on a Galaxy S22 (SM-S901U1, Android 14, 2026-09-03) with a
 * `games/sling` debug build: this module's install lands ahead of `initDebugBridge()` (its probe line
 * preceded `[debug-bridge] Initializing native bridge` in the ring) and a mount-time `console.info`
 * is captured — but a `console.info` at the top level of `games/sling/game.ts`, which App.tsx reaches
 * through its static `virtual:modoki-games` import, was NOT. Source order does not survive chunking:
 * rolldown puts this module in a shared chunk that the entry chunk imports AFTER several chunks
 * belonging to App.tsx's graph, so "above App.tsx in main.tsx" buys ordering against main.tsx's
 * STATEMENTS (React's mount and its effects — the #591 case) and not against every module App.tsx
 * transitively pulls in. `deviceConsoleCaptureInstallOrder.test.ts` pins the source order, which is
 * necessary and not sufficient; only a device build can answer the rest. Closing that last window
 * would take an inline script in index.html, which nothing yet needs.
 *
 * The gate below must stay BYTE-IDENTICAL to the one guarding `import('./debug/bridge')` in
 * main.tsx (pinned by `deviceConsoleCaptureInstallOrder.test.ts`) — not merely equivalent. Both need
 * to CONSTANT-FOLD at their call sites so a release build's bundler can DCE the branch away; a shared
 * `isEnabled()` function call cannot fold the same way, and losing that would ship the eval-capable
 * bridge chunk (or blow a playable ad's byte cap) on a build meant to have neither. The duplication
 * is the price of keeping both sites foldable.
 */

import { Capacitor } from '@capacitor/core';
import { installDeviceConsoleCapture } from './debug/deviceConsoleCapture';

if (!__MODOKI_PLAYABLE__ && (import.meta.env.DEV || import.meta.env.VITE_DEBUG_BRIDGE || (__MODOKI_DEBUG_BUILD__ && Capacitor.isNativePlatform()))) {
  installDeviceConsoleCapture();
}
