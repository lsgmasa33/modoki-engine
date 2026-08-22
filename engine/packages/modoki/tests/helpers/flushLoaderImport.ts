/** Wait out the on-demand import of three's example loaders (#254).
 *
 *  `loadModelTemplates` / `loadGLB` / `fetchRiggedModel` used to call `new GLTFLoader().load(…)`
 *  synchronously. They now `await` the loader module first (`threeLoaderModules`), so the
 *  `.load` call — and therefore any spy count or fetch a test asserts on — lands a few
 *  microtasks later than the call that triggered it.
 *
 *  A macrotask boundary drains every pending MICROTASK, however deep the chain, which is what
 *  makes this better than `await Promise.resolve()` × N — a count that rots the moment the chain
 *  gains a link. Do NOT reach for fake timers here: `vi.mock` resolves the module in a
 *  microtask, not on a timer.
 *
 *  ⚠️ It is not unconditional, and an earlier version of this comment claimed it was. One
 *  macrotask drains microtasks only; add a single `setTimeout` hop anywhere in the loader setup
 *  and this stops being enough — measured, four consuming tests failed and one hung to the 20s
 *  timeout. So the guarantee is "microtask chains of any depth", not "anything asynchronous".
 *  If a loader accessor ever grows a timer or an IPC hop, this helper needs a real condition to
 *  wait on (poll the observable) rather than another `setTimeout(0)`.
 */
export function flushLoaderImport(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait until `makeGltfLoader()` has SETTLED, then drain every continuation parked behind it —
 *  the condition-waiting form the caveat above asks for.
 *
 *  `flushLoaderImport()` alone drains microtasks, which is enough when the loader module is
 *  already in vitest's module cache. It is NOT enough for the FIRST import in a worker on a slow
 *  filesystem: `vi.resetModules()` per test forces a real re-resolve of
 *  `three/examples/jsm/loaders/GLTFLoader.js`, and that resolve can take a real I/O hop rather
 *  than a microtask chain. When the flush comes up short, the pending `.load` calls land on the
 *  NEXT test's spy instead — which is exactly how the Windows CI leg saw `loadCount` 8 where the
 *  test asserted 1 (3 leaked + 4 leaked + its own 1).
 *
 *  ⚠️ Wait on `makeGltfLoader()`, not on `gltfLoaderCtor()` — that mistake cost a second red
 *  gate. `meshTemplateCache` awaits `makeGltfLoader()`, which is
 *  `Promise.all([gltfLoaderCtor(), meshoptDecoder()])`: TWO independent on-demand imports. Wait
 *  on only the first and the second can still land later, which is exactly the leak again. It
 *  hid from a test perturbation that delayed every accessor by the SAME amount — symmetric
 *  delays make the two resolve in one microtask batch. Wait on precisely what the code awaits.
 *
 *  Waiting on the loader rather than on a `.load` call count is deliberately COUNT-FREE.
 *  Waiting instead for "N `.load` calls to land" works, but N is hand-maintained: add a fifth `loadModelTemplates` to a
 *  test that waits for four and the fifth leaks into the next test — the same bug, reintroduced
 *  silently. It also lets a `toBe(1)` assertion pass while a second load is still in flight,
 *  which is the regression such a test exists to catch. Once the loader promise has settled, one
 *  macrotask hop drains every parked continuation regardless of how many there are.
 *
 *  ⚠️ Same caveat as above, one layer up: this holds because the whole chain is microtasks after
 *  the import. If `makeGltfLoader` ever grows a timer or an IPC hop — or a THIRD import a caller
 *  awaits alongside it — this needs a real condition to wait on. And do NOT use it under
 *  `vi.useFakeTimers()` — `setTimeout` never fires, so the hop never resolves.
 */
export async function waitForLoaderImport(): Promise<void> {
  const { makeGltfLoader } = await import('../../src/runtime/loaders/threeLoaderModules');
  await makeGltfLoader().catch(() => {}); // a rejection still means "no longer pending"
  await flushLoaderImport();
}
