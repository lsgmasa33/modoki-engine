/** One GPU device per container, not one per effect run.
 *
 *  React `<StrictMode>` (engine/app/main.tsx) deliberately double-invokes every effect in dev:
 *  mount → unmount → remount. Without this lease that meant SceneView created a WebGPU
 *  renderer, acquired a real GPU adapter+device, disposed it, and immediately requested a
 *  second device — while the first was still releasing, because `dispose()` returns long
 *  before the browser has actually torn the device down.
 *
 *  That race is the likeliest source of the renderer-init failures the retry in SceneView
 *  exists to absorb. Note `makeWebGPURenderer` already falls back WebGPU→WebGL2 internally, so
 *  a throw from it means BOTH backends failed — which "this machine has no GPU" would do
 *  consistently, not intermittently, but a device-teardown race would do exactly
 *  intermittently.
 *
 *  So: hold the renderer against its container and hand the same one back to a remount, rather
 *  than racing a second device into existence and retrying past the wreckage. The retry stays
 *  as a net for genuine environmental failures — which is what a retry should be for.
 *
 *  Generic over the renderer type so this module carries no `three/webgpu` import (that entry
 *  is dep-optimizer sensitive — see the comment at the top of SceneView.tsx) and stays
 *  trivially unit-testable with a fake.
 */

/** The subset of a renderer this module touches. */
export interface LeasableRenderer {
  dispose(): void;
  domElement: { remove(): void };
}

interface RendererLease<R> {
  promise: Promise<R>;
  renderer?: R;
  refs: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

const leases = new WeakMap<object, RendererLease<LeasableRenderer>>();

/**
 * Reuse the renderer already leased to `container`, else create one via `create`.
 *
 * A failed `create` is deliberately NOT cached — the next mount gets a clean attempt rather
 * than inheriting a rejected promise forever.
 */
export function acquireRenderer<R extends LeasableRenderer>(
  container: object,
  create: () => Promise<R>,
  onReuse?: () => void,
): Promise<R> {
  const existing = leases.get(container) as RendererLease<R> | undefined;
  if (existing) {
    // A pending release means the previous holder just unmounted — this is the StrictMode
    // remount (or a fast re-open) claiming the same renderer back. Cancel the teardown.
    if (existing.releaseTimer !== undefined) {
      clearTimeout(existing.releaseTimer);
      existing.releaseTimer = undefined;
    }
    existing.refs++;
    onReuse?.();
    return existing.promise;
  }
  const lease: RendererLease<R> = { promise: undefined as unknown as Promise<R>, refs: 1 };
  lease.promise = create().then(
    (r) => { lease.renderer = r; return r; },
    (e) => { leases.delete(container); throw e; },
  );
  leases.set(container, lease as RendererLease<LeasableRenderer>);
  return lease.promise;
}

/**
 * Drop one hold. The last one schedules disposal on a macrotask rather than doing it now:
 * StrictMode remounts immediately after unmounting, so deferring lets the remount re-acquire
 * this exact renderer instead of paying for a fresh GPU device it doesn't need.
 */
export function releaseRenderer(container: object): void {
  const lease = leases.get(container);
  if (!lease) return;
  lease.refs--;
  if (lease.refs > 0 || lease.releaseTimer !== undefined) return;
  lease.releaseTimer = setTimeout(() => {
    if (lease.refs > 0) return; // re-acquired between scheduling and firing
    leases.delete(container);
    lease.renderer?.dispose();
    lease.renderer?.domElement.remove();
  }, 0);
}

/**
 * Force-drop the lease NOW: no defer, no reuse, no refcount. For a renderer that is DEAD —
 * its GPU context/device was lost — where the deferred, reusable release above is exactly
 * wrong.
 *
 * WHY THIS EXISTS (#121 P1). `releaseRenderer` schedules teardown on a macrotask precisely so
 * that an `acquireRenderer` arriving first CANCELS it and gets the same renderer back. That is
 * correct for a StrictMode remount and fatal for context-loss recovery, whose rebuild is
 * `cleanup(); setup();` in one task: the re-acquire lands before the timer fires, the lease
 * hands back the corpse, and recovery becomes a silent no-op that logs nothing and never
 * renders again. A lost renderer must never be leasable — a three renderer cannot be revived
 * once `_isDeviceLost` is set (see `core/activeRenderer.ts`), so reuse can only ever be wrong.
 *
 * Disposal is guarded: `dispose()` on a renderer whose context is already gone may throw, and
 * a throw here would abort the rebuild it is clearing the way for.
 */
export function discardRenderer(container: object): void {
  const lease = leases.get(container);
  if (!lease) return;
  if (lease.releaseTimer !== undefined) {
    clearTimeout(lease.releaseTimer);
    lease.releaseTimer = undefined;
  }
  leases.delete(container);
  try { lease.renderer?.dispose(); } catch { /* already-dead renderer — nothing to reclaim */ }
  try { lease.renderer?.domElement.remove(); } catch { /* detached already */ }
}

/** Test-only: is a renderer currently leased to this container? */
export function __hasLease(container: object): boolean {
  return leases.has(container);
}
