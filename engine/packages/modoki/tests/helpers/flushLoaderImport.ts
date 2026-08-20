/** Wait out the on-demand import of three's example loaders (#254).
 *
 *  `loadModelTemplates` / `loadGLB` / `fetchRiggedModel` used to call `new GLTFLoader().load(…)`
 *  synchronously. They now `await` the loader module first (`threeLoaderModules`), so the
 *  `.load` call — and therefore any spy count or fetch a test asserts on — lands a few
 *  microtasks later than the call that triggered it.
 *
 *  A macrotask boundary drains every pending microtask regardless of how deep the promise
 *  chain is, which is what makes this robust where `await Promise.resolve()` × N is a guess
 *  that rots the moment the chain gains a link. Do NOT reach for fake timers here: `vi.mock`
 *  resolves the module in a microtask, not on a timer.
 */
export function flushLoaderImport(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
