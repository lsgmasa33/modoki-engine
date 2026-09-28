/** The asset-root watcher BOTH live-reload consumers use: Electron main (`engine/electron/assetBackend.ts`) and the
 *  Vite asset scanner (`vite-asset-scanner.ts`). It reports FILE-level `add` / `change` / `unlink`, with the path
 *  spelled `join(root, rel)`, which is what chokidar reported.
 *
 *  **Windows: one recursive `fs.watch` per root, and nothing on any subfolder (#1708).** Windows refuses to move a
 *  folder (the Recycle Bin is a move) while a descendant directory has an open handle, and a per-directory watcher
 *  (chokidar, Vite's) holds one on every directory, so a folder with subfolders could not be recycled while the editor
 *  ran. The recursive watch holds the root alone. It reports coarsely (a folder, not its files; a `null` filename when
 *  its buffer overflows), and `assetTreeIndex.ts` — pure and tested on every platform — turns that back into per-file
 *  events. This file is only the wiring: the watch, a coalescing timer, and a restart after an error.
 *
 *  **macOS and Linux: chokidar, as before.** Neither platform blocks moving a directory that has handles open under
 *  it, so there is no bug there to fix, and macOS is the hub's platform.
 *
 *  ⚠️ **A watcher added on any OTHER seam over an asset root reintroduces #1708 on Windows.** That includes watching
 *  one FILE: libuv watches a file by opening its PARENT directory, which blocks moving that directory's ancestors
 *  (measured). This is why Vite's own watcher is told to ignore the project asset roots
 *  (`projectAssetRootsWatchIgnore`). */

import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { createAssetTreeIndex, isIgnoredSegment, type AssetTreeIndex, type TreeEventKind, type TreeFs } from './assetTreeIndex';

export interface AssetTreeWatcher { close(): Promise<void> }

/** The slice of `fs.watch` the win32 branch uses — injectable for the wiring test. */
export type RecursiveWatchFn = (
  root: string,
  listener: (event: string, filename: string | null) => void,
) => { on(event: 'error', cb: (err: Error) => void): unknown; close(): void };

export interface AssetTreeWatcherOptions {
  roots: readonly string[];
  onEvent: (kind: TreeEventKind, absPath: string) => void;
  platform?: NodeJS.Platform;
  /** win32 seams (tests). */
  watch?: RecursiveWatchFn;
  treeFs?: TreeFs;
  dirIdentity?: (abs: string) => string | null;
}

/** Wait this long after the LAST raw event before reconciling, so a burst is read once… */
export const COALESCE_MS = 50;
/** …but never longer than this after the FIRST, so a steady stream still gets reported. */
export const COALESCE_MAX_MS = 500;
/** How often a root whose watch failed is retried. */
export const RESTART_MS = 2000;
/** How often a live watch checks that its root is still the directory it opened — see `lose` below. */
export const ROOT_CHECK_MS = 2000;

export const nodeTreeFs: TreeFs = {
  readdir(absDir) {
    try {
      return fs.readdirSync(absDir, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch { return null; }
  },
  stat(abs) {
    try {
      const st = fs.statSync(abs);
      return { isDir: st.isDirectory(), mtimeMs: st.mtimeMs, size: st.size };
    } catch { return null; }
  },
};

/** Which directory `abs` IS, or null when it is missing — read as a BIGINT: on this box's volume two different
 *  directories' 64-bit file ids differed by 1 and were the SAME `Number` (measured), so the plain `ino` cannot tell a
 *  replaced root from the original. */
export function nodeDirIdentity(abs: string): string | null {
  try { const st = fs.statSync(abs, { bigint: true }); return st.isDirectory() ? `${st.dev}:${st.ino}` : null; }
  catch { return null; }
}

const nodeRecursiveWatch: RecursiveWatchFn = (root, listener) =>
  fs.watch(root, { recursive: true }, (event, filename) => listener(event, filename == null ? null : String(filename)));

export function createAssetTreeWatcher(opts: AssetTreeWatcherOptions): AssetTreeWatcher {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return createChokidarWatcher(opts.roots, opts.onEvent);
  const watches = opts.roots.map((root) => watchRootRecursive(root, opts.onEvent, opts.watch ?? nodeRecursiveWatch, opts.treeFs ?? nodeTreeFs, opts.dirIdentity ?? nodeDirIdentity));
  return { async close() { for (const w of watches) w.close(); } };
}

const toSlash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

function createChokidarWatcher(roots: readonly string[], onEvent: AssetTreeWatcherOptions['onEvent']): AssetTreeWatcher {
  const slashRoots = roots.map(toSlash);
  const w = chokidar.watch([...roots], {
    ignoreInitial: true,
    // Segments BELOW the root only: a root that happens to sit under a dot folder is still watched. Compared with
    // `/` on both sides, because chokidar hands the predicate `/`-separated paths even on Windows.
    ignored: (p: string) => {
      const f = toSlash(p);
      const root = slashRoots.find((r) => f === r || f.startsWith(r + '/'));
      return root !== undefined && f.slice(root.length).split('/').some((seg) => seg !== '' && isIgnoredSegment(seg));
    },
  });
  w.on('add', (p) => onEvent('add', p)).on('change', (p) => onEvent('change', p)).on('unlink', (p) => onEvent('unlink', p));
  return { close: () => w.close() };
}

function watchRootRecursive(
  root: string, onEvent: AssetTreeWatcherOptions['onEvent'], watch: RecursiveWatchFn, treeFs: TreeFs, dirIdentity: (abs: string) => string | null,
) {
  const index: AssetTreeIndex = createAssetTreeIndex({ root, fs: treeFs, emit: onEvent });
  let handle: ReturnType<RecursiveWatchFn> | null = null;
  let rootId: string | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let firstPendingAt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let warned = false;

  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    firstPendingAt = 0;
    if (!closed) index.flush();
  };
  const schedule = () => {
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, Math.max(0, Math.min(COALESCE_MS, firstPendingAt + COALESCE_MAX_MS - now)));
  };
  /** The watch is no longer on the root: it raised an error, or the root itself was deleted, renamed away or
   *  replaced. ⚠️ Windows raises NO error for the last three. Deleting the watched root makes the handle spin,
   *  reporting `rename` with the ROOT's own absolute path over and over (~150k events a second, measured), and a
   *  rename-away reports nothing at all. So both are detected here instead (the absolute filename, and the root-identity
   *  check), the handle is closed, a rescan unlinks whatever went, and the watch is retried until the root is back. */
  const lose = (why: unknown) => {
    if (closed || (!handle && restartTimer)) return; // already lost, a retry is pending
    if (!warned) { warned = true; console.warn(`[assetTreeWatcher] lost the watch on ${root}; retrying every ${RESTART_MS}ms:`, why); }
    // Rescan only when a LIVE watch was lost. A watch that never opened has nothing to reconcile, and flushing then —
    // at construction, before the seed — reported every file under the root as an `add` (#1708 review).
    const wasLive = handle !== null;
    try { handle?.close(); } catch { /* already gone */ }
    handle = null;
    if (wasLive) { index.note({ overflow: true }); flush(); }
    if (!restartTimer) restartTimer = setTimeout(() => { restartTimer = null; start(true); }, RESTART_MS);
  };
  const start = (afterOutage: boolean) => {
    if (closed) return;
    const id = dirIdentity(root);
    if (id === null) { lose(new Error('root is missing')); return; }
    try {
      handle = watch(root, (event, filename) => {
        // A relative name is a change UNDER the root; an absolute one (`\\?\E:\…`) is the root itself.
        if (filename != null && path.win32.isAbsolute(filename)) { lose(new Error(`root changed (${event})`)); return; }
        warned = false; // this watch demonstrably works, so the NEXT outage is news again
        index.note(filename == null ? { overflow: true } : { rel: filename, kind: event === 'rename' ? 'rename' : 'change' });
        schedule();
      });
      handle.on('error', lose);
    } catch (err) { lose(err); return; }
    rootId = id;
    if (afterOutage) {
      // Whatever changed while nothing was watching is found by one rescan. (`warned` is NOT reset here: a watch that
      // opens and then fails asynchronously every time would warn every cycle. The first event it delivers resets it.)
      index.note({ overflow: true });
      schedule();
    }
  };
  // A rename-away raises no event, so the root's identity is checked on a slow timer.
  const rootCheck = setInterval(() => {
    if (!handle) return;
    if (dirIdentity(root) !== rootId) lose(new Error('root was replaced or removed'));
  }, ROOT_CHECK_MS);
  rootCheck.unref?.();

  // Watch FIRST, then seed: the seed is synchronous, so an event raised during it is delivered after and reconciled
  // against the seeded index, instead of falling in a gap between the two.
  start(false);
  index.seed();

  return {
    close() {
      closed = true;
      clearInterval(rootCheck);
      if (flushTimer) clearTimeout(flushTimer);
      if (restartTimer) clearTimeout(restartTimer);
      try { handle?.close(); } catch { /* already gone */ }
      handle = null;
    },
  };
}
