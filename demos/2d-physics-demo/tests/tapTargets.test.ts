/**
 * Every tappable control in this demo meets the 44 pt tap-target floor (#1024).
 *
 * The mechanism (#948): **a tappable's hit area is its artwork.** A control authored 30 pt tall is a
 * 30 pt tap target on every device, and nothing reports it — the button looks right, renders right,
 * and is simply hard to hit. `UIElement.minTapSize` is the one field that separates the drawing box
 * from the receiving box; `docs/ui-system.md` § "Tap zones" records the two obvious alternatives
 * (`padding`, `minWidth`/`minHeight`) MEASURED failing.
 *
 * This file is DATA — the resolver is `@modoki/engine/testing/tapTargetFloor`, which walks every
 * scene and prefab, resolves each axis against the engine's own `DEVICE_PRESETS` matrix, and knows
 * every case where `minTapSize` is structurally inert. The demo is PUBLISHED, so it reaches the
 * engine through the package specifier like the rest of its code — `engine/tests/` does not exist in
 * the published snapshot.
 *
 * ⚠️ **Both lists are EMPTY on purpose, and that is the point of the file.** `Credits Button`
 * (92x30) and `Credits Close` (120x36) were under the floor on their short axis until #1024 authored
 * `minTapSize: 48` on each; a demo is a worked example, so it is fixed rather than excepted. An
 * empty list still reds the day a new control arrives under the floor, which is the whole ask.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTapTargetFloor } from '@modoki/engine/testing/tapTargetFloor';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'assets');

describeTapTargetFloor({
  label: '2d-physics-demo',
  assetsDir: ASSETS,
  underFloor: [],
  unresolvable: [],
  expectAtLeast: 2,
  // By NAME as well as by count: both controls live in `platformer.scene.json`, so a corpus walk
  // that stopped reading every scene in the directory would otherwise pass on an empty population.
  expectNames: ['Credits Button', 'Credits Close'],
});
