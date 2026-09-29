/** A prefab document's localId high-water mark (#1774, owner ruling B, prefab v8): `nextLocalId`, the lowest number a
 *  NEW row may take. Every localId the document has ever used is below it, and it never goes down.
 *
 *  Why it exists: a member's derived guid is a hash of its localId path, so a number handed out a second time hands the
 *  new node the guid of the member that last held it, and every ref still naming that member lands on the new node. A
 *  number freed at the TOP of the numbering is invisible to a writer that numbers above the rows it can see, so a LATER
 *  write handed it out again (#1774). Unity never reuses a fileID either; it never counts, it draws a random one. The
 *  owner kept sequential numbers (they are used elsewhere too) and made the mark persistent.
 *
 *  Two halves, and they live in different places on purpose:
 *  - **Read** ({@link localIdCounter}): every allocator seeds from it — prefab-edit's session floor, a Replace's
 *    `replaceNumbering`, Apply's promotion, `mergeRiggedPrefab`. Guarded per writer by `localIdCounter.test.ts`.
 *  - **Advance** ({@link advanceLocalIdCounter}): each writer states the mark on what it builds, and
 *    `commitPrefabWrites` — which every editor prefab write goes through — raises it to the document it lands over if a
 *    writer did not, so no write lowers it, and states it on any document that claims v8 without one
 *    ({@link markUnstated}, #1797), so no writer can stamp the version and leave the mark out. Under both, `/api/write-file` refuses any write that would lower it
 *    (`classifyPrefabMarkWrite`): the route is reachable raw (an agent's eval, a game panel, the Assets drop import).
 *
 *  A file without the field (every file before v8, a hand edit) derives it from its highest row: no migration pass.
 *  Import-free and in L0, beside `version.ts`, because it is a FORMAT rule with three readers in three places: the
 *  editor's writers, `prefabCommit.ts` (which may not import `editor/scene/prefab.ts`, a load-time cycle), and the
 *  server's write gate (`plugins/prefabWriteGuard.ts`, which refuses a raw write that would lower the mark). */

/** The prefab format version that introduced the mark (v8, `version.ts`): a document claiming it, or any later one,
 *  states `nextLocalId`. A literal rather than `PREFAB_FORMAT_VERSION`, which moves on with every format bump while this
 *  stays the version the field arrived in; and this file stays import-free. */
export const LOCAL_ID_MARK_VERSION = 8;

/** The part of a prefab document the mark reads. */
export interface CountedDoc {
  nextLocalId?: unknown;
  rootLocalId?: unknown;
  entities?: ReadonlyArray<{ localId?: unknown }> | unknown;
}

const positiveInt = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);

/** The lowest localId a NEW row of `doc` may take: its stored mark, or above its highest row and its root, whichever is
 *  higher — so a mark a hand edit left too low cannot hand out a number a row holds. 1 for no document. */
export function localIdCounter(doc: CountedDoc | null | undefined): number {
  if (!doc || typeof doc !== 'object') return 1;
  let next = Math.max(1, positiveInt(doc.nextLocalId), positiveInt(doc.rootLocalId) + 1);
  if (Array.isArray(doc.entities)) for (const e of doc.entities as ReadonlyArray<{ localId?: unknown }>) next = Math.max(next, positiveInt(e?.localId) + 1);
  return next;
}

/** Set `doc.nextLocalId` to the highest of its own counter and each prior document's — `priors` being what this write
 *  replaces or lands over — and return it. Mutates, so every holder of `doc` (an undo record, a cache) sees the mark
 *  that is written. */
export function advanceLocalIdCounter(doc: { nextLocalId?: number } & CountedDoc, ...priors: Array<CountedDoc | number | null | undefined>): number {
  let next = localIdCounter(doc);
  for (const p of priors) next = Math.max(next, typeof p === 'number' ? positiveInt(p) : p ? localIdCounter(p) : 0);
  doc.nextLocalId = next;
  return next;
}

/** True when `doc` claims a format that carries the mark (v8 or later) but does not state a usable one: absent, or not
 *  a positive integer. Such a document still reads correctly (the counter derives the mark from its rows), but it breaks
 *  v8's contract, and a write of it must state the mark (#1797: Apply's write into an enclosing prefab stamped v8 on a
 *  clone of a file that had none). */
export function markUnstated(doc: { version?: unknown; nextLocalId?: unknown } | null | undefined): boolean {
  if (!doc || typeof doc !== 'object') return false;
  if (!(typeof doc.version === 'number' && doc.version >= LOCAL_ID_MARK_VERSION)) return false;
  return positiveInt(doc.nextLocalId) === 0;
}
