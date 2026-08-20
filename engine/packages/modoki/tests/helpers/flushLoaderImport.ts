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
