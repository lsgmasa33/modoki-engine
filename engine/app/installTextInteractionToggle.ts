/**
 * Side-effect module: install the iOS text-interaction toggle (#1360).
 *
 * ⚠️ **It exists only for its POSITION**, exactly like `./installErrorCapture` — see that file for
 * the full argument. Imports are hoisted and evaluate in source order before any statement of the
 * importing module runs, so calling this from `main.tsx`'s body would run after `./App.tsx`'s whole
 * graph has mounted; a field focused during boot would then be typed into before the listener
 * existed.
 *
 * The mechanism, and why the native half needs it at all, live in `./textInteractionToggle.ts`.
 */

import { installTextInteractionToggle } from './textInteractionToggle';

installTextInteractionToggle();
