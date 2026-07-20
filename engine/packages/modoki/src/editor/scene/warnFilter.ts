/** Scoped `console.warn` suppression (editor-sceneview F9).
 *
 *  The SceneView 3D viewport used to monkey-patch `console.warn` for its ENTIRE mounted
 *  lifetime (~always) to swallow Three.js r183 WebGPU's spurious `'Light node not found'`
 *  warnings — meaning every warning from any other code in the app passed through the filter,
 *  and a throw between patch + cleanup-assignment could leak the patch.
 *
 *  Instead, wrap ONLY the call that emits the warning (the per-frame `renderer.render`) and
 *  restore in a `finally`. The patch lives for one synchronous call, not the component lifetime,
 *  and a nested mount can't double-patch a held global. Re-entrancy is handled: if a filter is
 *  already active (nested `withWarnFilter`), we don't re-patch — the outer filter stays in
 *  effect and we restore nothing. */

const SUPPRESSED = ['Light node not found'];

let depth = 0;

function shouldSuppress(args: unknown[]): boolean {
  const msg = String(args[0] ?? '');
  return SUPPRESSED.some((s) => msg.includes(s));
}

/** Run `fn` with the Three.js light-node warnings suppressed, restoring `console.warn`
 *  immediately afterward (even if `fn` throws). */
export function withWarnFilter<T>(fn: () => T): T {
  if (depth > 0) {
    // Already inside a filter — the outer patch covers us; just run.
    depth++;
    try { return fn(); } finally { depth--; }
  }
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    if (shouldSuppress(args)) return;
    orig.apply(console, args as never[]);
  };
  depth = 1;
  try {
    return fn();
  } finally {
    depth = 0;
    console.warn = orig;
  }
}
