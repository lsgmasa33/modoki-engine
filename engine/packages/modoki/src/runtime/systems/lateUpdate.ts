/** LateUpdate — game systems that run AFTER the skeletal animation has posed the
 *  skeleton each frame, between the bone read-back and write-back (see
 *  `syncBones`). This is the place to drive bones procedurally (IK, look-at,
 *  recoil): read a `Bone` entity's `Transform` — which read-back has just set to
 *  the clip's pose — and modify it; the change LAYERS ON TOP of the clip and is
 *  written back into the skeleton before it draws. Mirrors Unity's `LateUpdate`.
 *
 *  Ordering note: it runs in the RENDER phase (the mixer poses there, after the
 *  ECS pipeline), and once PER active 3D viewport. So a LateUpdate must be
 *  IDEMPOTENT — a pure function of the read-back pose (read the current bone
 *  Transform, set an absolute/relative result), NOT an accumulator that reads its
 *  own previous output. These are presentation overrides; they must not advance
 *  sim state (time / RNG / journal). */

import type { World } from 'koota';

export type LateUpdateFn = (world: World) => void;

/** Dev-only idempotency probe. The caller (`syncBones`) supplies these closures so the
 *  guard can verify idempotency WITHOUT this module knowing anything about bones/traits:
 *  `capture()` snapshots the mutable pose the systems may edit (each call returns a fresh
 *  array, same length + order); `restore()` writes a snapshot back. See `runLateUpdates`. */
export interface IdempotencyProbe {
  capture(): Float64Array;
  restore(snap: Float64Array): void;
}

const lateUpdates = new Map<string, LateUpdateFn>();

/** Signature of the verified system set — the dev idempotency guard runs once per
 *  distinct set (re-armed on any register/unregister/clear) to bound cost + log spam. */
let _idempotencyCheckedSig: string | null = null;

/** Register a LateUpdate system (replaces any with the same key). */
export function registerLateUpdate(key: string, fn: LateUpdateFn): void {
  lateUpdates.set(key, fn);
  _idempotencyCheckedSig = null; // re-arm the dev idempotency guard
}

/** Remove a previously-registered LateUpdate system. */
export function unregisterLateUpdate(key: string): void {
  lateUpdates.delete(key);
  _idempotencyCheckedSig = null;
}

/** Is any LateUpdate registered? `syncBones` uses this to decide whether bone
 *  Transforms might have been edited this frame (and a same-frame re-propagation
 *  of bone children is therefore warranted). */
export function hasLateUpdates(): boolean {
  return lateUpdates.size > 0;
}

/** Run every registered LateUpdate (insertion order). Called by `syncBones`
 *  between bone read-back and write-back. Errors are isolated so one bad system
 *  can't break the bridge.
 *
 *  DEV idempotency guard: a LateUpdate runs once per active 3D viewport (so in the
 *  editor, with both GameView + SceneView live, twice per frame on the same world).
 *  It MUST therefore be a pure function of the read-back pose — running the systems
 *  twice on the SAME input must yield the same output. When `probe` is supplied and
 *  `import.meta.env.DEV` is set, we snapshot the input pose, run, RESET to that input,
 *  run again, and compare. Resetting between runs is what lets a documented-valid
 *  "clip + relative offset" system pass (it reads the reset pose each time) while a
 *  hidden-state accumulator that reads its own previous output is caught (it drifts).
 *  The check runs once per distinct system set; it never fires in production. */
export function runLateUpdates(world: World, probe?: IdempotencyProbe): void {
  if (lateUpdates.size === 0) return;

  const runAll = () => {
    for (const [key, fn] of lateUpdates) {
      try { fn(world); }
      catch (e) { console.error(`[lateUpdate] system "${key}" threw:`, e); }
    }
  };

  if (probe && import.meta.env?.DEV) {
    const sig = [...lateUpdates.keys()].join('\x00');
    if (sig !== _idempotencyCheckedSig) {
      _idempotencyCheckedSig = sig;
      const input = probe.capture();
      runAll();
      const out1 = probe.capture();
      probe.restore(input);   // reset to the SAME input the first run saw
      runAll();
      const out2 = probe.capture();
      if (!floatArraysClose(out1, out2)) {
        console.error(
          '[lateUpdate] NON-IDEMPOTENT LateUpdate detected — re-running the registered ' +
          'system(s) on the same input pose produced a different result. A LateUpdate runs ' +
          'once per active 3D viewport, so it must be a pure function of the read-back pose ' +
          '(read the bone Transform, set an absolute or relative-to-clip result), NEVER an ' +
          'accumulator that reads its own previous output — that drifts per viewport. ' +
          `System(s): [${[...lateUpdates.keys()].join(', ')}].`,
        );
      }
      probe.restore(out1);    // leave the canonical first-run result for this frame
      return;
    }
  }

  runAll();
}

function floatArraysClose(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return true; // shape changed between runs — not a drift signal
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
}

/** Test/teardown helper — drop all registered LateUpdate systems. */
export function clearLateUpdates(): void {
  lateUpdates.clear();
  _idempotencyCheckedSig = null;
}
