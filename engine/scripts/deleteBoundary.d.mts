/** Type sidecar for deleteBoundary.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** A boundary that makes a recursive delete of the root misreport what it did.
 *
 *  - `link`       — a symlink/junction resolving OUTSIDE the root; `rmSync` severs it and orphans
 *                   `target`. At depth 0 this is #883's original case.
 *  - `mount`      — a directory on a different volume; `rmSync` recurses INTO it.
 *  - `unreadable` — we could not tell, and something unreadable must never authorise a delete. */
export interface DeleteBoundary {
  path: string;
  kind: 'link' | 'mount' | 'unreadable';
  target: string | null;
  code: string | null;
}

/** The `fs` surface the walk needs, injectable so the DECISION is testable on a host that cannot
 *  build the fixture — a real mount point needs privileges on POSIX. Pair any fake with the
 *  `skipIf(!win32)` real-fixture test; a fake alone would defend behaviour nothing has. */
export interface DeleteBoundaryFs {
  lstatSync(p: string, o: { throwIfNoEntry: false }): { isSymbolicLink(): boolean; isDirectory(): boolean; dev: number } | undefined;
  readdirSync(p: string, o: { withFileTypes: true }): Array<{ name: string; isSymbolicLink(): boolean; isDirectory(): boolean }>;
  realpathNative(p: string): string;
}

/** Every boundary at or inside `root` that would make `rmSync(root, {recursive:true})` misreport.
 *  Empty means the subtree is self-contained. Never follows a link; a nested link resolving INSIDE
 *  the subtree is ALLOWED (npm's `node_modules/.bin` shims), which is the accept side that stops
 *  this being the blunt "refuse on any nested link" rule #990 ruled out. */
export declare function findDeleteBoundaries(root: string, fsi?: DeleteBoundaryFs): DeleteBoundary[];

/** One line describing a boundary, for a refusal a human has to act on. The three kinds carry
 *  three different remedies and must not share a sentence (#989). */
export declare function describeBoundary(b: DeleteBoundary): string;
