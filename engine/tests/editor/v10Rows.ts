/** Readers for what a prefab v10 reference row STATES (#2001 S6), for tests that assert a writer's output: the row's
 *  list is its `members` (the nested root on `"/"`, a member on `/<nodeGuid>…`, values on `traits`, added nodes on
 *  `own`), and none of the channels a v9 row used. */

export interface V10Node { name?: string; key?: string; guid?: string; prefab?: string; parentLocalId?: number; traits?: Record<string, unknown>; children?: V10Node[]; members?: V10Rows }
export interface V10Row {
  traits?: Record<string, Record<string, unknown>>;
  traitRemovals?: Record<string, boolean>;
  removed?: boolean;
  own?: V10Node[];
  parent?: string;
}
export type V10Rows = Record<string, V10Row>;

/** The channels a v9 row stated; a v10 row states none (a held value aside). */
const V9_CHANNELS = ['overrides', 'added', 'removed', 'removedTraits', 'moved', 'templateMoved', 'nestedOverrides', 'nestedStructure'];

export const rowsOf = (owner: unknown): V10Rows => ((owner as { members?: V10Rows } | undefined)?.members ?? {});
/** The row key of the member the `nodeGuids` path names; the nested root's with none. */
export const rowKey = (...nodeGuids: string[]): string => `/${nodeGuids.join('/')}`;
/** What the owner states about one member (the nested root with no `nodeGuids`). */
export const rowAtKey = (owner: unknown, ...nodeGuids: string[]): V10Row | undefined => rowsOf(owner)[rowKey(...nodeGuids)];
/** Every node the owner adds, at any anchor, in row-key order. */
export const ownNodes = (owner: unknown): V10Node[] => Object.keys(rowsOf(owner)).sort().flatMap((k) => rowsOf(owner)[k]!.own ?? []);
/** The v9 channels `owner` still states: `[]` for a row the v10 writer wrote. */
export const v9Channels = (owner: unknown): string[] => V9_CHANNELS.filter((k) => owner && typeof owner === 'object' && k in owner);

/** What `owner` states beyond the nested root's own name and order (its `"/"` row's `EntityAttributes`), as
 *  `<row key>:<what>` — `[]` for a row whose save pinned nothing of the frames it expands. This is what "the v9 row
 *  wrote no `nestedStructure` / `nestedOverrides` / `added`" asserts in the v10 form, where those channels are never
 *  written and their absence says nothing. */
export const statedBeyondRoot = (owner: unknown): string[] => Object.keys(rowsOf(owner)).sort().flatMap((k) => {
  const { traits, ...rest } = rowsOf(owner)[k]!;
  return [
    ...Object.keys(traits ?? {}).filter((t) => !(k === '/' && t === 'EntityAttributes')).map((t) => `${k}:${t}`),
    ...Object.keys(rest).map((f) => `${k}:${f}`),
  ];
});

interface DocLike { id?: string; rootLocalId?: number; entities?: Array<{ localId?: number; nodeGuid?: string; prefab?: string }> }
/** The VALUES an owner's rows state, back in the shape a v9 row keyed them by — `overrides[localId]` for a member of the
 *  owner's own prefab (its root included), `nestedOverrides["<row localId>"][localId]` for a member one frame down — so a
 *  test written against a member's localId keeps naming it that way. `read` returns a prefab document by guid; a member of
 *  a document with no `nodeGuid` is looked up by its derived identity (`derive`, the engine's `preV5NodeGuid`). */
export function valuesByLocalId(
  owner: unknown, read: (guid: string) => unknown, derive?: (docGuid: string, localId: number) => string,
): { overrides: Record<number, Record<string, Record<string, unknown>>>; nestedOverrides: Record<string, Record<number, Record<string, Record<string, unknown>>>> } {
  const out = { overrides: {} as Record<number, Record<string, Record<string, unknown>>>, nestedOverrides: {} as Record<string, Record<number, Record<string, Record<string, unknown>>>> };
  const source = (owner as { prefab?: string } | undefined)?.prefab;
  const doc = source ? read(source) as DocLike | undefined : undefined;
  if (!doc) return out;
  const idOf = (d: DocLike, e: { localId?: number; nodeGuid?: string }) => e.nodeGuid || (derive && d.id ? derive(d.id, e.localId ?? 0) : '');
  const find = (d: DocLike, g: string) => d.entities?.find((e) => idOf(d, e) === g);
  for (const [key, row] of Object.entries(rowsOf(owner))) {
    if (!row.traits) continue;
    if (key === '/') { out.overrides[doc.rootLocalId ?? 1] = row.traits; continue; }
    const parts = key.slice(1).split('/');
    const first = find(doc, parts[0]!);
    if (!first) continue;
    const inner = first.prefab ? read(first.prefab) as DocLike | undefined : undefined;
    if (parts.length === 1 && !inner) { out.overrides[first.localId!] = row.traits; continue; }
    if (!inner) continue;
    const lid = parts.length === 1 ? inner.rootLocalId ?? 1 : parts.length === 2 ? find(inner, parts[1]!)?.localId : undefined;
    if (lid !== undefined) (out.nestedOverrides[String(first.localId)] ??= {})[lid] = row.traits;
  }
  return out;
}
