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
 * through its static `virtual:modoki-games` import, was NOT. Source order does not survive
 * bundling — and the mechanism is NOT chunk reordering, which is what this comment claimed until
 * #633 measured it. Rolldown INLINES this module's body (and the three sibling side-effect
 * modules') into the ENTRY CHUNK's body, and by ES semantics an entry body runs only after every
 * one of its static imports has evaluated. So the bundler converts the side-effect IMPORT — the
 * one construct main.tsx:8-11 says runs early enough — into a body STATEMENT, which those same
 * comments say is too late. "Above App.tsx in main.tsx" therefore buys ordering against main.tsx's
 * STATEMENTS (React's mount and its effects — the #591 case) and nothing at all against a module
 * App.tsx transitively pulls in. Re-measured on a `--target web` build of games/sling (#633): the
 * install call sits at entry-chunk byte ~188k, the last static import ends at ~4.7k, and the game's
 * chunk is import #25 of 25. `deviceConsoleCaptureInstallOrder.test.ts` pins the source order,
 * which is necessary and not sufficient; only a real bundle can answer the rest.
 *
 * That last window IS now closed, by the inline early-capture shim in `engine/index.html` (#633) —
 * the only thing no emitted chunk can precede. It buffers `console.*` and `installConsoleRing()`
 * drains it. This module's own projection is unaffected: it reads the ring, which by then holds
 * the drained boot lines too.
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
