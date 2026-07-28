/** Ref-counted suppression of Rapier's one bogus init warning, shared by BOTH the 2D and
 *  3D WASM loaders.
 *
 *  Rapier 0.19.x's bundled wasm-bindgen glue logs a "deprecated parameters for the
 *  initialization function" warning when we call `mod.init()` with no args (the only
 *  signature we can call; there's no newer release to fix upstream). We swallow just that
 *  one line for the duration of init and pass every other warning through untouched.
 *
 *  Why ref-counted (not a naive capture/restore per loader): a game using BOTH 2D and 3D
 *  physics inits both loaders, and they can INTERLEAVE — the 3D loader's synchronous
 *  `.then` can run while the 2D loader has already replaced `console.warn`, so a naive
 *  `origWarn = console.warn` would capture the OTHER loader's wrapper as the "original" and
 *  the order-dependent `.finally` restores could permanently leak a wrapper that eats
 *  warnings. Counting patch depth and capturing the genuine `console.warn` only on the
 *  0→1 transition (restoring only on 1→0) makes interleaved init safe. */

let realWarn: typeof console.warn | null = null;
let depth = 0;

/** Begin suppressing Rapier's init deprecation warning. Pair with {@link endSuppressRapierInitWarning}. */
export function beginSuppressRapierInitWarning(): void {
  if (depth++ === 0) {
    realWarn = console.warn;
    const captured = realWarn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('deprecated parameters for the initialization function')) return;
      (captured as (...a: unknown[]) => void)(...args);
    };
  }
}

/** Stop suppressing; restores the genuine `console.warn` once the last suppressor ends. */
export function endSuppressRapierInitWarning(): void {
  if (--depth === 0 && realWarn) {
    console.warn = realWarn;
    realWarn = null;
  }
  if (depth < 0) depth = 0; // defensive: never let unbalanced calls drive depth negative
}
