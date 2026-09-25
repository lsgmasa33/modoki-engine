/** A saved scene as the pre-Phase-4 writer would have spelled it — for TESTS that assert WHAT an instance
 *  recorded (this member is removed, that reference node exists, this nested member was edited) rather
 *  than WHICH CHANNEL held it.
 *
 *  #1468 Phase 4 moved a member's edits off the localId-keyed channels (`overrides`, `removed`,
 *  `removedTraits`, `added`, `nestedOverrides`, `nestedStructure`) onto its member ROW, keyed by minted
 *  identity. Dozens of older tests pin the statement in its old spelling, and the statement is still
 *  what they are about; this unfolds the rows back into it through the documents, so those tests keep
 *  asserting their own subject. The reload in every such test still reads the REAL saved file — only the
 *  assertion looks through this view. Where a test is about the ROW spelling itself, it reads the file
 *  directly (`sceneMemberRowWriter.test.ts`).
 *
 *  The inverse of `foldMemberRowChannels` for well-formed input: a row key is resolved component by
 *  component through `readDoc`, a nested root's own row lands in its frame's path slot, and a nested
 *  frame's structure is rebuilt as the whole list the legacy slot held. Not a module of the engine, so
 *  nothing ships that could mistake it for a reader. */

type Doc = { rootLocalId?: number; entities?: Array<{ localId?: number; nodeGuid?: string; prefab?: string }> };
type Row = { traits?: Record<string, unknown>; removed?: boolean; removedTraits?: string[]; added?: Node[] };
type Node = Record<string, unknown> & {
  prefab?: string; parentLocalId?: number;
  overrides?: Record<string, unknown>; removed?: number[]; removedTraits?: Record<string, string[]>; added?: Node[];
  nestedOverrides?: Record<string, Record<string, unknown>>;
  nestedStructure?: Record<string, { added?: Node[]; removed?: number[]; removedTraits?: Record<string, string[]> }>;
  members?: Record<string, Row>;
};

export function legacyView<T>(entry: T, readDoc: (guid: string) => unknown): T {
  const e = entry as unknown as Node;
  if (!e || typeof e !== 'object') return entry;
  const out: Node = { ...e };
  const top = e.prefab ? readDoc(e.prefab) as Doc | undefined : undefined;
  if (top && e.members) {
    const apply = (at: { path: number[]; lid: number }, row: Row): void => {
      if (!at.path.length) {
        if (row.traits) out.overrides = { ...(out.overrides ?? {}), [at.lid]: row.traits };
        if (row.removedTraits?.length) out.removedTraits = { ...(out.removedTraits ?? {}), [at.lid]: row.removedTraits };
        if (row.removed === true) out.removed = [...(out.removed ?? []), at.lid].sort((a, b) => a - b);
        if (row.added) out.added = [...(out.added ?? []), ...row.added.map((n) => ({ ...n, parentLocalId: at.lid }))];
        return;
      }
      const pk = at.path.join('.');
      if (row.traits) out.nestedOverrides = { ...(out.nestedOverrides ?? {}), [pk]: { ...(out.nestedOverrides?.[pk] ?? {}), [at.lid]: row.traits } };
      if (row.removed !== undefined || row.removedTraits || row.added) {
        const ns = { ...(out.nestedStructure ?? {}) };
        const slot = { added: [...(ns[pk]?.added ?? [])], removed: [...(ns[pk]?.removed ?? [])], removedTraits: { ...(ns[pk]?.removedTraits ?? {}) } };
        if (row.removed === true) slot.removed = [...slot.removed, at.lid].sort((a, b) => a - b);
        if (row.removedTraits?.length) slot.removedTraits[at.lid] = row.removedTraits;
        if (row.added) slot.added.push(...row.added.map((n) => ({ ...n, parentLocalId: at.lid })));
        ns[pk] = slot;
        out.nestedStructure = ns;
      }
    };
    for (const [key, row] of Object.entries(e.members)) {
      const at = resolve(top, key, readDoc);
      if (!at) continue;
      if (!at.nestedRoot) { apply(at, row); continue; }
      // A nested root's row: deleting it is its OUTER frame's statement, the rest is its own frame's.
      const { removed, ...interior } = row;
      if (removed !== undefined) apply(at.nestedRoot, { removed });
      apply(at, interior);
    }
  }
  if (out.added) out.added = out.added.map((n) => (n.prefab ? legacyView(n, readDoc) : n));
  return out as unknown as T;
}

/** {@link legacyView} over every entity of a saved scene. */
export function legacySceneView<T extends { entities: unknown[] }>(scene: T, readDoc: (guid: string) => unknown): T {
  return { ...scene, entities: scene.entities.map((e) => legacyView(e, readDoc)) };
}

/** A row key's member: the localId chain of the nested ROWS it passes through (`path`) and its localId in
 *  the last frame. A key ending at a nested ROW names that nested instance's root: its interior channels
 *  belong to the nested frame (`foldMemberRowChannels` forwards them there), and `nestedRoot` is where
 *  the same row reads as a member of the frame ABOVE — which is where deleting the instance is stated. */
function resolve(doc: Doc, key: string, readDoc: (guid: string) => unknown): { path: number[]; lid: number; nestedRoot?: { path: number[]; lid: number } } | null {
  const comps = key.split('/').slice(1);
  const path: number[] = [];
  let cur: Doc | undefined = doc;
  for (let i = 0; i < comps.length; i++) {
    const pe = cur?.entities?.find((r) => r.nodeGuid === comps[i]);
    if (!pe?.localId) return null;
    const last = i === comps.length - 1;
    if (last && !pe.prefab) return { path, lid: pe.localId };
    if (!pe.prefab) return null;
    const child = readDoc(pe.prefab) as Doc | undefined;
    if (!child) return null;
    if (last) return { path: [...path, pe.localId], lid: child.rootLocalId ?? 1, nestedRoot: { path: [...path], lid: pe.localId } };
    path.push(pe.localId);
    cur = child;
  }
  return null;
}
