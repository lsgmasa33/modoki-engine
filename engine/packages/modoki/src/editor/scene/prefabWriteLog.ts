/** Which prefab (and other asset document) files the editor's writes left changed on disk since a point (#2001 S8b): what an op that throws part-way
 *  says it leaves behind (`editor/instance/instanceRollback.ts`, the hub's edge (3): a file already written is left and
 *  named, never silently). A leaf, so the commit (which records) and the rollback (which reads) need not import each
 *  other. */

let seq = 0;
/** Each path's last write: its sequence number, and whether it put the file's prior bytes back (a commit's own rollback). */
const last = new Map<string, { at: number; back: boolean }>();

/** Record a landed write of `path`; `back`: it restored what was there before (or took away a file the step created). */
export function notePrefabWrite(path: string, back: boolean): void {
  last.set(path, { at: ++seq, back });
}

/** A point to ask {@link prefabWritesSince} from. */
export function prefabWritesMark(): number {
  return seq;
}

/** The paths written since `mark` whose last write did not put them back, in no particular order. */
export function prefabWritesSince(mark: number): string[] {
  return [...last].filter(([, w]) => w.at > mark && !w.back).map(([p]) => p);
}
