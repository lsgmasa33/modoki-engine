/**
 * The prefab v10 DOCUMENT writer (#2001 S6): every reference row of a prefab document states its nested instance's list
 * as `members` in template form, and nothing in the channels a v9 row used (design § 2.2).
 *
 * A row is read by the one parser (`parseTemplateLists`: legacy channels first, rows over them) and written by the one
 * writer (`serializeTemplateOwner`), so a row already in the v10 form comes out as it went in, and a row a writer built
 * in the old channels (the live capture, an Apply's in-place edit) is converted. Two things are written back verbatim,
 * as everywhere else (docs/prefabs.md § Format rule): a value no reader could interpret, and the legacy channels of a
 * row whose nested prefab did not resolve.
 *
 * The document-level `moved` (v4) goes onto the rows as `parent` tokens; an entry naming no nested member stays on the
 * document (`serializeTemplateDocHeld`).
 */
import { parseTemplateLists } from './parseInstanceRecord';
import { serializeTemplateDocHeld, serializeTemplateOwner } from './serializeInstanceRecord';
import type { PrefabDoc, PrefabDocRow, PrefabReader } from './instanceRecord';
import { nodeRowKey } from '../core/assetRefRules';

/** The channels a prefab reference row stated before v10. A v10 row states `members` (and any held value) only. */
export const LEGACY_ROW_CHANNELS: readonly string[] = ['overrides', 'added', 'removed', 'removedTraits', 'moved', 'templateMoved', 'nestedOverrides', 'nestedStructure'];

/** Put `doc`'s reference rows, and its `moved`, in the prefab v10 form. Mutates `doc`: each reference row is replaced in
 *  `doc.entities` (the array is kept, a caller may key on it), its own identity and traits first, then what the writer
 *  states. `docGuid` names the document for a pre-v5 row's derived identity. */
export function writeTemplateForm(doc: PrefabDoc, docGuid: string, read: PrefabReader): void {
  const { rows, docHeld } = parseTemplateLists(doc, docGuid, read);
  doc.entities.forEach((row, i) => {
    const parsed = typeof row?.localId === 'number' ? rows.get(row.localId) : undefined;
    if (!parsed) return;
    const { fields, superseded } = serializeTemplateOwner(parsed.list);
    // Said, never dropped unsaid (owner ruling F-CB1(a)), as the scene save says it (`instanceSave.ts`, #2012).
    if (superseded.length) console.warn(`[save] prefab ${docGuid}, row ${row.localId}: the save states its own value where the file held one no reader took; that value is not written back: ${superseded.map((v) => v.path.join('.')).join(', ')}`);
    const members = fields.members;
    // A row that states nothing about its instance writes no `members`.
    if (members && typeof members === 'object' && !Object.keys(members).length) delete fields.members;
    const own = Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'members' && !LEGACY_ROW_CHANNELS.includes(k)));
    doc.entities[i] = { ...own, ...fields } as PrefabDocRow;
  });
  const held = serializeTemplateDocHeld(docHeld);
  delete doc.moved;
  if (held.moved !== undefined) doc.moved = held.moved;
}

type Node = { key?: unknown; prefab?: unknown; children?: unknown; members?: unknown };
type Rows = Record<string, { parent?: unknown; own?: unknown }>;
type Owner = { members?: unknown };

const rowsOf = (o: Owner): Rows | undefined => (o.members && typeof o.members === 'object' && !Array.isArray(o.members) ? o.members as Rows : undefined);

/** Every template OWNER of `doc` (a reference row, and each keyed reference node its rows add, at any depth), with an
 *  id that names it in any writing of the same document: the row's localId, then the key of each reference node on the
 *  way down. */
function eachOwner(doc: PrefabDoc, visit: (id: string, owner: Owner) => void): void {
  const nodes = (id: string, list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const n of list as Node[]) {
      if (!n || typeof n !== 'object') continue;
      if (typeof n.prefab === 'string' && typeof n.key === 'string' && n.key) owner(`${id}|${n.key}`, n);
      nodes(id, n.children);
    }
  };
  const owner = (id: string, o: Owner): void => {
    visit(id, o);
    for (const r of Object.values(rowsOf(o) ?? {})) nodes(id, r?.own);
  };
  for (const row of doc.entities ?? []) if (row?.prefab && typeof row.localId === 'number') owner(String(row.localId), row);
}

/** The moves of KEYED nodes `doc`'s template owners state (a v10 `parent` on a node row, `/…/a+<key>`), by owner
 *  ({@link eachOwner}). Such a move applies nowhere (#1883 ruling C: the node sits at its template place), so no capture
 *  of a live tree can restate it, and a writer that rebuilds the document's rows puts it back from here
 *  ({@link keepKeyedNodeParents}), as it put a v4 document's keyed `moved` entries, and a reference node's keyed
 *  `templateMoved` entries, back. */
export function keyedNodeParents(doc: PrefabDoc): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  eachOwner(doc, (id, o) => {
    for (const [key, r] of Object.entries(rowsOf(o) ?? {})) {
      if (!nodeRowKey(key.slice(key.lastIndexOf('/') + 1)) || typeof r?.parent !== 'string') continue;
      const kept = out.get(id) ?? {};
      kept[key] = r.parent;
      out.set(id, kept);
    }
  });
  return out;
}

/** Put `kept` ({@link keyedNodeParents} of the document this write replaces) back on the owners of `doc` that are still
 *  there and state no parent for that node themselves. Mutates `doc`; rows stay in key order. */
export function keepKeyedNodeParents(doc: PrefabDoc, kept: ReadonlyMap<string, Record<string, string>>): void {
  if (!kept.size) return;
  eachOwner(doc, (id, o) => {
    const mine = kept.get(id);
    if (!mine) return;
    const members = { ...(rowsOf(o) ?? {}) };
    let changed = false;
    for (const [key, parent] of Object.entries(mine)) {
      if (members[key]?.parent !== undefined) continue;
      members[key] = { parent, ...members[key] };
      changed = true;
    }
    if (changed) o.members = Object.fromEntries(Object.keys(members).sort().map((k) => [k, members[k]]));
  });
}
