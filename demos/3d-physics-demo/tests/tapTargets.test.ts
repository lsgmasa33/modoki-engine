/**
 * Every tappable control in this demo meets the 44 pt tap-target floor (#1024).
 *
 * Resolver: `@modoki/engine/testing/tapTargetFloor` — it walks every scene and prefab, resolves each
 * authored axis against the engine's own `DEVICE_PRESETS` matrix, and knows every case where
 * `UIElement.minTapSize` is structurally inert (`docs/ui-system.md` § "Tap zones" enumerates them). This file is only the demo's data.
 *
 * ⚠️ **This demo authors NO tappable UI today, and the suite is here anyway.** That is the
 * "born covered" half of #1024: the guard is a TRIPWIRE, and it reds the moment a control arrives
 * under the floor rather than waiting for a fourth by-hand census to find it. `expectAtLeast: 0` is
 * what says so out loud — the scene-directory check above it still fails if the corpus goes missing,
 * which is the failure a zero could otherwise hide.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTapTargetFloor } from '@modoki/engine/testing/tapTargetFloor';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'assets');

describeTapTargetFloor({
  label: '3d-physics-demo',
  assetsDir: ASSETS,
  underFloor: [],
  unresolvable: [],
  expectAtLeast: 0,
});
