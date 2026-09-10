/**
 * Every tappable control meets the 44 pt tap-target floor (#1024).
 *
 * ⚠️ **This file is part of the TEMPLATE, so a scaffolded project is born covered.** That is the
 * half of #1024 that stops the class recurring: three separate passes (#948, #969, #1017) each found
 * under-floor controls by hand, one game at a time, each starting from zero — because a new project
 * had no gate and accumulated its own set before anybody looked.
 *
 * The mechanism (#948): **a tappable's hit area is its artwork.** A control authored 30 pt tall is a
 * 30 pt tap target on every device, and nothing reports it — the button looks right, renders right,
 * and is simply hard to hit. `UIElement.minTapSize` is the one field that separates the drawing box
 * from the receiving box; `docs/ui-system.md` § "Tap zones" is the reference, including the four
 * cases where authoring it does nothing.
 *
 * ## What to do when this goes red
 *
 * It names the control and which list it belongs in. **Do not just add the name** — decide first:
 *
 *  - **`underFloor`** means an authored `px`/`vw`/`vh`/`vmin` axis really does measure under 44 pt.
 *    Fix it by sizing or spacing the artwork, or by authoring `minTapSize` where the control has
 *    clearance. A name here needs a REASON in a comment beside it.
 *  - **`unresolvable`** means the control has an auto or `%` axis, so this file cannot size it at
 *    all. Neither pass nor fail — the only way to know is to measure it live in the editor.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTapTargetFloor } from '@modoki/engine/testing/tapTargetFloor';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'assets');

describeTapTargetFloor({
  label: 'starter',
  assetsDir: ASSETS,
  underFloor: [],
  unresolvable: [],
  // The template ships no tappable UI, so the suite starts as a tripwire — it reds the first time a
  // control arrives under the floor. The scene-directory check still fails if the corpus goes
  // missing, which is the failure a zero could otherwise hide.
  expectAtLeast: 0,
});
