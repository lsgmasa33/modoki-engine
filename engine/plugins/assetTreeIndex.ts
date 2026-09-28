/** The known-file index behind the Windows asset watcher (#1708) — PURE: no `fs`, no `fs.watch`, no timers.
 *
 *  **Why it exists.** On Windows a folder cannot be MOVED (and the Recycle Bin is a move) while any DESCENDANT
 *  directory has an open handle. chokidar and Vite's watcher both open one `fs.watch` handle per directory, so the
 *  editor could not recycle a folder with subfolders while it ran (#1708). ONE recursive `fs.watch` on the root holds a
 *  handle on the root alone and does not block — measured. But it reports only the TOP of a change: recycling
 *  `nest/sub/deep/` arrives as a single `rename:nest`, a folder moved in as `rename:restored`, and a bulk write as a
 *  `null` filename (the change buffer overflowed — 3000 fast writes gave 2 events). The consumers were written against
 *  chokidar, which reports every FILE, and #1702's delete marks are per FILE. This index turns the recursive watch's
 *  coarse events back into chokidar's shape:
 *
 *  - **Folder expansion** — a path that is gone `unlink`s itself and every known file under it; a folder that arrives
 *    is walked and every file in it `add`ed.
 *  - **Exact-spelling lookup** — "is it still there" asks the PARENT's listing for the exact name, never `stat`: after
 *    a case-only rename `Foo` → `foo`, `stat('Foo')` still succeeds on a case-insensitive volume, and `Foo` would
 *    never be unlinked. And because a case-only FOLDER rename can arrive as the old name alone, a gone path whose
 *    parent lists another spelling of it reconciles that spelling as well.
 *  - **Overflow → rescan → diff** — a `null` event (or too many pending paths) rescans the root and diffs it against
 *    the index, emitting `change` for any file whose `mtimeMs` or `size` differs. A `git checkout` mostly MODIFIES
 *    files, so a rescan that only diffed the file SET would drop exactly the prefab change that must reload.
 *
 *  Paths: the index keys by the path RELATIVE to the root, spelled with `pathImpl.sep` — the spelling `fs.watch`
 *  reports — and emits `pathImpl.join(root, rel)`, the spelling chokidar emitted, so the watcher write-guard
 *  (`normalizeWriteGuardKey`) and `isUnderAssetRoot` see what they saw before. `pathImpl` is injectable so the
 *  Windows spelling is exercised on every platform. The real `fs.watch` wiring is `assetTreeWatcher.ts`. */

import nodePath from 'node:path';

export type TreeEventKind = 'add' | 'change' | 'unlink';

/** One directory entry, named EXACTLY as it is on disk. */
export interface TreeEntry { name: string; isDir: boolean }
export interface TreeStat { isDir: boolean; mtimeMs: number; size: number }

/** The filesystem the index reads, injected. */
export interface TreeFs {
  /** The entries of `absDir` with their on-disk names, or null when it is missing or not a directory. */
  readdir(absDir: string): TreeEntry[] | null;
  /** The stat of `abs`, or null when it is missing. */
  stat(abs: string): TreeStat | null;
}

/** A raw event from the recursive watch: a path relative to the root, or an overflow (`fs.watch`'s null filename). */
export type RawTreeEvent = { rel: string; kind: 'rename' | 'change' } | { overflow: true };

/** A path segment neither watcher reports: a dot entry (the Electron watcher's rule, and `scanAllAssets` skips them
 *  too) or `node_modules`. */
export function isIgnoredSegment(seg: string): boolean {
  return seg.startsWith('.') || seg === 'node_modules';
}

/** More pending paths than this and one rescan is cheaper than reconciling each. */
export const RESYNC_THRESHOLD = 1000;

export interface AssetTreeIndexOptions {
  root: string;
  fs: TreeFs;
  emit: (kind: TreeEventKind, absPath: string) => void;
  pathImpl?: Pick<typeof nodePath, 'join' | 'dirname' | 'basename' | 'sep'>;
  resyncThreshold?: number;
}

export interface AssetTreeIndex {
  /** Walk the root and record every file, emitting nothing (chokidar's `ignoreInitial`). */
  seed(): void;
  /** Queue a raw event; nothing is read or emitted until {@link flush}. */
  note(ev: RawTreeEvent): void;
  hasPending(): boolean;
  /** Reconcile everything queued against the disk and emit the file-level events. */
  flush(): void;
  /** The known files, relative to the root (tests). */
  knownFiles(): string[];
}

interface FileSig { mtimeMs: number; size: number }

export function createAssetTreeIndex(opts: AssetTreeIndexOptions): AssetTreeIndex {
  const { root, fs, emit } = opts;
  const p = opts.pathImpl ?? nodePath;
  const threshold = opts.resyncThreshold ?? RESYNC_THRESHOLD;
  const files = new Map<string, FileSig>();
  const dirs = new Set<string>();
  const pending = new Map<string, 'rename' | 'change'>();
  let overflow = false;

  const abs = (rel: string) => (rel === '' ? root : p.join(root, rel));
  const isUnder = (k: string, rel: string) => rel === '' || k === rel || k.startsWith(rel + p.sep);
  const ignored = (rel: string) => rel.split(p.sep).some(isIgnoredSegment);
  const parentOf = (rel: string) => { const d = p.dirname(rel); return d === '.' ? '' : d; };

  /** What is at `rel` now, found through the PARENT's listing by exact name (see the docblock). A listing is cached
   *  for the length of one flush, which reads one moment of the disk. */
  function listingOf(dir: string, listings: Map<string, Map<string, TreeEntry> | null>): Map<string, TreeEntry> | null {
    let listing = listings.get(dir);
    if (listing === undefined) {
      const entries = fs.readdir(abs(dir));
      listing = entries ? new Map(entries.map((e) => [e.name, e])) : null;
      listings.set(dir, listing);
    }
    return listing;
  }

  function lookup(rel: string, listings: Map<string, Map<string, TreeEntry> | null>): TreeStat | null {
    const entry = listingOf(parentOf(rel), listings)?.get(p.basename(rel));
    if (!entry) return null;
    if (entry.isDir) return { isDir: true, mtimeMs: 0, size: 0 };
    return fs.stat(abs(rel));
  }

  /** Every file and directory under `rel` (a directory, or '' for the root) as it is on disk now. */
  function walk(rel: string, outFiles: Map<string, FileSig>, outDirs: Set<string>): void {
    const entries = fs.readdir(abs(rel));
    if (!entries) return;
    for (const e of entries) {
      if (isIgnoredSegment(e.name)) continue;
      const child = rel === '' ? e.name : p.join(rel, e.name);
      if (e.isDir) { outDirs.add(child); walk(child, outFiles, outDirs); continue; }
      const st = fs.stat(abs(child));
      if (st && !st.isDir) outFiles.set(child, { mtimeMs: st.mtimeMs, size: st.size });
    }
  }

  function recordAncestors(rel: string): void {
    for (let d = parentOf(rel); d !== ''; d = parentOf(d)) dirs.add(d);
  }

  /** `rel` is gone: unlink it, and every known file under it — the FOLDER EXPANSION. */
  function removeUnder(rel: string, silent = false): void {
    for (const k of [...files.keys()]) {
      if (!isUnder(k, rel)) continue;
      files.delete(k);
      if (!silent) emit('unlink', abs(k));
    }
    for (const d of [...dirs]) if (isUnder(d, rel)) dirs.delete(d);
  }

  function setFile(rel: string, sig: FileSig, silent: boolean): void {
    const prev = files.get(rel);
    if (prev && prev.mtimeMs === sig.mtimeMs && prev.size === sig.size) return;
    files.set(rel, sig);
    recordAncestors(rel);
    if (!silent) emit(prev ? 'change' : 'add', abs(rel));
  }

  /** Make the index under the directory `rel` match the disk: unlink what went, add what arrived, change what differs.
   *  With `rel === ''` this is the full rescan. */
  function syncDir(rel: string, silent: boolean): void {
    const found = new Map<string, FileSig>();
    const foundDirs = new Set<string>();
    walk(rel, found, foundDirs);
    for (const k of [...files.keys()]) {
      if (k !== rel && isUnder(k, rel) && !found.has(k)) {
        files.delete(k);
        if (!silent) emit('unlink', abs(k));
      }
    }
    for (const d of [...dirs]) if (d !== rel && isUnder(d, rel) && !foundDirs.has(d)) dirs.delete(d);
    for (const d of foundDirs) dirs.add(d);
    if (rel !== '') { dirs.add(rel); recordAncestors(rel); }
    for (const [k, sig] of found) setFile(k, sig, silent);
  }

  function reconcile(rel: string, kind: 'rename' | 'change', listings: Map<string, Map<string, TreeEntry> | null>): void {
    if (rel === '' || ignored(rel)) return;
    const st = lookup(rel, listings);
    if (!st) {
      removeUnder(rel);
      // ⚠️ A case-only FOLDER rename (`Sprites` → `sprites`) can arrive as the OLD name alone — observed on Windows,
      // late, with the new-name half never sent. So a gone path whose parent now lists another spelling of it
      // reconciles that spelling too; without this `sprites/*` never enters the index, and a later delete in it is
      // never reported. Harmless on a case-SENSITIVE volume: there the other spelling is its own path, re-synced.
      // Only when the exact name is NOT listed (a listed name whose stat failed is not a rename), and a file variant is
      // set directly rather than reconciled: on a case-SENSITIVE directory listing `a.json` and `A.json` with both
      // stats failing, recursing here ping-ponged between the two until the stack overflowed (#1708 review).
      const parent = parentOf(rel);
      const listing = listingOf(parent, listings);
      if (!listing || listing.has(p.basename(rel))) return;
      const lower = p.basename(rel).toLowerCase();
      for (const [name, e] of listing) {
        if (name.toLowerCase() !== lower) continue;
        const other = parent === '' ? name : p.join(parent, name);
        if (e.isDir) { syncDir(other, false); continue; }
        const ost = lookup(other, listings);
        if (ost && !ost.isDir) setFile(other, { mtimeMs: ost.mtimeMs, size: ost.size }, false);
      }
      return;
    }
    if (st.isDir) {
      if (files.has(rel)) { files.delete(rel); emit('unlink', abs(rel)); }
      // A `change` on a known folder is Windows saying a CHILD changed; the child reports itself. A `rename` means the
      // folder itself arrived (moved in, restored, renamed to this name) and nothing under it will be reported.
      if (kind === 'rename' || !dirs.has(rel)) syncDir(rel, false);
      return;
    }
    if (dirs.has(rel)) removeUnder(rel); // it was a folder; a file took its name
    setFile(rel, { mtimeMs: st.mtimeMs, size: st.size }, false);
  }

  return {
    seed() { files.clear(); dirs.clear(); syncDir('', true); },
    note(ev) {
      if ('overflow' in ev) { overflow = true; return; }
      if (pending.get(ev.rel) !== 'rename') pending.set(ev.rel, ev.kind); // a rename outranks a change
    },
    hasPending: () => overflow || pending.size > 0,
    flush() {
      const rescan = overflow || pending.size > threshold;
      const batch = [...pending];
      pending.clear();
      overflow = false;
      if (rescan) { syncDir('', false); return; }
      const listings = new Map<string, Map<string, TreeEntry> | null>();
      for (const [rel, kind] of batch) reconcile(rel, kind, listings);
    },
    knownFiles: () => [...files.keys()],
  };
}
