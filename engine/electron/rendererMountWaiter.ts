/** "Has the editor document loaded AFTER this reload mounted yet?" — the readiness answer an agent's
 *  project switch waits on (#1587).
 *
 *  ⚠️ **Not `state.root`, and not the `gateRendererReady` boolean.** `state.root` flips at the TOP of
 *  `openProject`, before the deps install, the Vite restart and the reload, so a wait keyed on it
 *  (`modoki_identity.projectRoot`) settles almost at once, while the new project is still loading.
 *  `gateRendererReady` is closer but still wrong: it is still `true` from the OLD document in the
 *  window between `reloadIgnoringCache()` and the old document's `did-navigate`, and the old editor
 *  can push its menu structure in that window. Either would report "ready" about the project being
 *  left.
 *
 *  So readiness is an EPOCH. `armReload()` numbers the reload; `onNavigate()` records that a new
 *  document committed (Electron's `did-navigate`, main-frame and committed only); `onMounted()` is
 *  the editor's menu-structure push. A mount settles a waiter only when a navigation that happened at
 *  or after the waiter's reload has already been seen, so a push from the old document cannot. A
 *  later unrelated reload (Cmd+R) still counts: any document committed after the switch is the new
 *  project's. Pure, so the ordering is unit-tested without Electron. */
export function createRendererMountWaiter() {
  /** Reloads armed so far. */
  let reloadEpoch = 0;
  /** The reload epoch in force when the most recent document committed. */
  let navigatedEpoch = 0;
  /** The reload epoch the most recent MOUNT post-dated — so a wait registered after its document
   *  already mounted settles at once instead of timing out. */
  let mountedEpoch = 0;
  const waiters = new Set<{ epoch: number; resolve: (mounted: boolean) => void }>();

  return {
    /** Call immediately BEFORE issuing the reload. Returns the epoch to wait on. */
    armReload(): number {
      return ++reloadEpoch;
    },
    /** A new main-frame document committed. */
    onNavigate(): void {
      navigatedEpoch = reloadEpoch;
    },
    /** The editor in the current document mounted. Settles every waiter whose reload that document
     *  post-dates. */
    onMounted(): void {
      mountedEpoch = navigatedEpoch;
      for (const w of [...waiters]) {
        if (navigatedEpoch >= w.epoch) { waiters.delete(w); w.resolve(true); }
      }
    },
    /** Resolves `true` once a document committed after reload `epoch` has mounted, or `false` when
     *  `timeoutMs` runs out first. */
    waitForMount(epoch: number, timeoutMs: number): Promise<boolean> {
      if (mountedEpoch >= epoch) return Promise.resolve(true);
      return new Promise((resolve) => {
        const w = { epoch, resolve: (mounted: boolean) => { clearTimeout(timer); resolve(mounted); } };
        const timer = setTimeout(() => { waiters.delete(w); resolve(false); }, Math.max(0, timeoutMs));
        waiters.add(w);
      });
    },
  };
}

export type RendererMountWaiter = ReturnType<typeof createRendererMountWaiter>;
