/** useWebCanvasSizing — the shipped web build's letterbox container box.
 *
 *  Its own module (rather than a local in App.tsx) so the boot-ordering contract
 *  below can be pinned by a test without rendering the whole app shell. The pure
 *  geometry lives in the engine (`computeContainerBox`); this is only the React
 *  binding — WHEN to read the settings and recompute. */

import { useEffect, useState } from 'react';
import { computeContainerBox, getRenderSettings } from '@modoki/engine/runtime';

/** Tracks the letterbox container box for the shipped web build's `rendering.web`
 *  sizeMode. Recomputes on window resize. For `free`/`max` the box fills the viewport
 *  (`letterboxed:false`) so the wrapper keeps its default 100%×100% CSS.
 *
 *  `configReady` is a REQUIRED dependency, not a convenience: the project's render
 *  settings are injected by `initWorldSync()` → `setRenderSettings()` DURING the boot
 *  effect, which resolves later than this hook's first run, so a mount-time read only
 *  ever sees the engine defaults (`free` → never letterboxed). Measured on the shipped
 *  games/sling build with `fixed` 1080×1920: it rendered full-bleed until the first
 *  window resize event happened to recompute it. Re-running on the `configReady` flip
 *  (set immediately after the injection in App.tsx) is what makes the FIRST paint
 *  honour the config. Under one-project-per-game (#29) the settings are project-level,
 *  so that flip is the only injection point a shipped build has. */
export function useWebCanvasSizing(configReady: boolean) {
  const [box, setBox] = useState(() =>
    computeContainerBox(window.innerWidth, window.innerHeight, getRenderSettings().web));
  useEffect(() => {
    const apply = () =>
      setBox(computeContainerBox(window.innerWidth, window.innerHeight, getRenderSettings().web));
    apply(); // re-read after boot-time setRenderSettings injection
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [configReady]);
  return box;
}
