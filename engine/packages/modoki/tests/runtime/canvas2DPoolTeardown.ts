/** Tear down every `Canvas2DPool` a test built, so no pool's recovery outlives its test (#1058/#1059).
 *
 *  A slot whose context loss — or `renderAll`'s stuck-render detection — asked `rendererRecovery` for
 *  a rebuild holds a REAL `setTimeout` (`DEFAULT_REBUILD_DELAY_MS`) until that recovery is disposed.
 *  Left armed, the rebuild fires during a LATER test: `vi.advanceTimersByTimeAsync` yields to real
 *  macrotasks between fake ticks, so a rebuild scheduled by an abandoned pool lands inside another
 *  test's sample→assert window and constructs an Application there. That is how
 *  `canvas2DContextLoss.test.ts` read `expected 4 to be 2` on a loaded machine — two leaked rebuilds
 *  plus the real one — while every production path was correct.
 *
 *  `teardownSlot` is the only thing that disposes a slot's recovery, and `destroyPool` reaches it only
 *  for a slot that nothing claims AND whose canvas is not in the DOM (#213's keep-alive rules). So
 *  every DOM attachment and both claims are dropped first; otherwise `destroyPool` would keep exactly
 *  the slots a test was most likely to have left armed.
 *
 *  Not a `.test.ts` on purpose: the package's vitest include is `tests/**` + `*.test.{ts,tsx}`. */

/** The public pool surface this needs — satisfied by a `Canvas2DPool` instance AND by the module's
 *  free-function API over `defaultPool`, which is what `canvas2DPool.test.ts` loads per test. */
export interface TeardownablePool {
  getAllocatedEntityIds(): Set<number>;
  getSlot(entityId: number): { container: { children: unknown[] } } | null;
  unmount(entityId: number): void;
  release(entityId: number): void;
  destroyPool(): void;
}

export function teardownCanvas2DPools(pools: Iterable<TeardownablePool>): void {
  // The WHOLE body, not the canvases a test appended: a rebuild swaps a replacement canvas in place
  // (`replaceWith`), so the element a test holds may no longer be the one in the document.
  document.body.replaceChildren();
  for (const pool of pools) {
    for (const id of pool.getAllocatedEntityIds()) {
      // Emptied BEFORE the claims drop, because dropping the last claim runs the pool's
      // `detachChildren` — `while (children.length) children[0].removeFromParent()` — and neither
      // test file can survive that loop: the `_gpuData` suites attach plain stand-in nodes with no
      // `removeFromParent` (it throws), and the mocked `Container.removeFromParent` does not splice
      // its parent's array (it would spin forever). Detach semantics have their own tests in
      // `canvas2DPool.test.ts`; this helper only has to reach `teardownSlot`.
      const slot = pool.getSlot(id);
      if (slot) slot.container.children.length = 0;
      pool.unmount(id);
      pool.release(id);
    }
    pool.destroyPool();
  }
}
