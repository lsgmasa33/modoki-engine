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
  id?: unknown;
  nextLocalId?: unknown;
  rootLocalId?: unknown;
  entities?: ReadonlyArray<{ localId?: unknown }> | unknown;
}

const positiveInt = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);

/** localIds a loaded file still NAMES although its prefab no longer has them (#1933 S5, hub ruling A): a legacy record
 *  of a member deleted from a document written before the mark, kept as an unused override (#1914 F5). Such a document
 *  derives its mark from its rows, so a freed TOP number reads as free and the next new member took it — and the record
 *  then landed on that member. Every number a kept record names is reserved here for the session, per document guid,
 *  so every allocator mints past it, and the next write of that document states the mark past it (`advanceLocalIdCounter`
 *  reads {@link localIdCounter}), after which the persisted mark keeps it — the commit judges "the file already holds
 *  it" by {@link storedLocalIdCounter}, so every write of the document states it, an undo's verbatim restore included.
 *  In memory, for the renderer's life (opening another project reloads it): a file this session never loaded reserves
 *  nothing (the complete answer, a one-time project scan, is the owner's option, recorded on #1933). */
const reservedLocalIds = new Map<string, number>();

/** Reserve `localId` of document `docId` (a no-op for a number below what it already holds). */
export function reserveLocalId(docId: string, localId: number): void {
  const n = positiveInt(localId);
  if (docId && n > (reservedLocalIds.get(docId) ?? 0)) reservedLocalIds.set(docId, n);
}

/** Forget every reservation (test isolation; the editor never forgets one within a session). */
export function clearReservedLocalIds(): void { reservedLocalIds.clear(); }

/** The lowest localId a NEW row of `doc` may take: its stored mark, or above its highest row and its root, and above
 *  every number a loaded record still names ({@link reserveLocalId}), whichever is highest — so a mark a hand edit left
 *  too low cannot hand out a number a row holds. 1 for no document. */
export function localIdCounter(doc: CountedDoc | null | undefined): number {
  const next = storedLocalIdCounter(doc);
  return doc && typeof doc === 'object' && typeof doc.id === 'string' ? Math.max(next, (reservedLocalIds.get(doc.id) ?? 0) + 1) : next;
}

/** What `doc` ITSELF says the mark is — its stated mark, its rows and its root — with no reservation: the question "does
 *  this file already hold the mark?" (`prefabCommit`'s `contentFor`), which {@link localIdCounter} would answer yes for a
 *  file that holds no trace of a reserved number. Allocators read {@link localIdCounter}. */
export function storedLocalIdCounter(doc: CountedDoc | null | undefined): number {
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

/** A prefab document's CONTENT as one string: what two copies of one document share whoever parsed them, every object's
 *  keys sorted, and the mark (`nextLocalId`) and the format `version` left out. Those two are the ONLY fields a write
 *  changes on a document it does not otherwise change: a restore that must keep a mark the undone write raised
 *  (`stateRaisedMark`, an Apply's undo) states the mark and the version that claims it on the very rows it restores.
 *  Nothing that expands a frame reads either: the version gates the mark ({@link markUnstated}), a newer build's refusal
 *  and the restore's stamping, and the mark is read by the next write's allocator, always from the cached document. So a
 *  document differing in them alone is the same document.
 *
 *  The ONE rule for "the same document" (#1892). There were two copies: `prefabCommit`'s (is a file still the document a
 *  step recorded?) got #1774's exemption, and the frame-staleness one (`staleFrames`: was this frame expanded from another
 *  document than the cache holds?) did not, so an Apply's undo made every frame expanded before the Apply read as stale
 *  and rebased it — and Create Prefab's redo, told its undo had rebased the tree, refused in a clean segment.
 *  ⚠️ The prefab fuzz harness states this rule on its own (`markFree` in `tests/editor/prefabFuzz/checks.ts`, #1913), so
 *  its checks do not inherit a defect here: change it there too. A NARROWER rule here that is not made there too goes
 *  unnoticed, since the harness would keep exempting what the product no longer does. */
export function documentContentKey(doc: object): string {
  // Through JSON first, as a write would put it: an undefined field is no field.
  const d = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  delete d.nextLocalId;
  delete d.version;
  return canonicalJson(d);
}

/** {@link documentContentKey}'s equality: the same object, or the same content. */
export function sameDocumentContent(a: object, b: object): boolean {
  return a === b || documentContentKey(a) === documentContentKey(b);
}

/** JSON with every object's keys sorted: two parses of one document compare equal whatever order a writer put them in. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
