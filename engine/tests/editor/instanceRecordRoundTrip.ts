/** Shared by the #2008 P2 round-trips: over the corpus (`instanceRecordRoundTrip.test.ts`), the fuzzer's saved scenes
 *  (`instanceRecordRoundTripFuzz.test.ts`) and hand-built fixtures for what neither reaches
 *  (`instanceRecordRoundTripFixtures.test.ts`). */

import { parseInstanceRecord, parseTemplateList, parseTemplateLists, type ParseOptions } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import {
  serializeInstanceRecord, serializeTemplateDocHeld, serializeTemplateOwner,
} from '../../packages/modoki/src/runtime/prefab/serializeInstanceRecord';
import type {
  ParsedInstance, PrefabDoc, PrefabDocRow, PrefabReader, TemplateOverrideList,
} from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import type { SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

/** A record (or fold) as plain data, Maps included, so `toEqual` reports a readable difference. */
export function asData(v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), asData(x)]));
  if (v instanceof Set) return [...v].map(asData);
  if (Array.isArray(v)) return v.map(asData);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asData(x)]));
  return v;
}

/** Scene-owned content as the record links it: anchored by its row, so `parentLocalId` is not data (it is ignored on
 *  read and written as 0, `SceneMemberRow.own`). A legacy top-level `added` node states its anchor there; the row
 *  states it once converted. */
export function ownAsLinked(own: ReadonlyMap<string, { parentLocalId?: number }>): unknown {
  return asData(new Map([...own].map(([g, n]) => [g, { ...n, parentLocalId: 0 }])));
}

/** The channels a prefab reference row stated before v10. A v10 row states `members` (and any held value) only. */
const LEGACY_ROW_CHANNELS = ['overrides', 'added', 'removed', 'removedTraits', 'moved', 'templateMoved', 'nestedOverrides', 'nestedStructure', 'members'];

/** `row` as the v10 writer states it: its own identity and traits, and the writer's fields in place of every channel. */
export function toV10Row(row: object, fields: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(row).filter(([k]) => !LEGACY_ROW_CHANNELS.includes(k)));
  return { ...rest, ...fields };
}

/** Every document as prefab v10 states it: each reference row from its template list, the document-level `moved` from
 *  what no row could take (`docHeld`). An instance must fold the same against these as against the originals: P2 parses
 *  against the originals only, so this is what proves the chain reads the writer's own rows. `stats.converted` counts
 *  the rows that stated a legacy channel and no longer do: without it, a conversion that did nothing would compare each
 *  original with itself and pass (#2008 review round 3). */
export function toV10Docs(docs: ReadonlyMap<string, PrefabDoc>, read: PrefabReader, stats?: { converted: number }): Map<string, PrefabDoc> {
  const out = new Map<string, PrefabDoc>();
  for (const [guid, doc] of docs) {
    const { rows, docHeld } = parseTemplateLists(doc, guid, read);
    const { moved: _legacy, ...rest } = doc;
    const entities = doc.entities.map((r) => {
      const t = typeof r.localId === 'number' ? rows.get(r.localId) : undefined;
      if (!t) return r;
      const row = toV10Row(r, serializeTemplateOwner(t.list).fields);
      const legacy = (o: object) => LEGACY_ROW_CHANNELS.some((k) => k !== 'members' && k in o);
      if (stats && legacy(r) && !legacy(row)) stats.converted++;
      return row as unknown as PrefabDocRow;
    });
    out.set(guid, { ...rest, ...serializeTemplateDocHeld(docHeld), entities });
  }
  return out;
}

/** parse → serialize → parse → serialize, for one scene entry. The identity map is empty: the parsed pins are already
 *  in the list, and a pin the projection would add is the one thing a first save adds (design § 2.7). */
export function roundTripEntry(entry: SceneEntityEntry, read: PrefabReader, opts: ParseOptions = {}): {
  first: ParsedInstance; second: ParsedInstance; bytes1: string; bytes2: string;
} {
  const write = (p: ParsedInstance) => serializeInstanceRecord(p.record, { identity: new Map(), sceneOwned: (g) => p.ownContent.get(g) });
  const first = parseInstanceRecord(entry, read, opts);
  const s1 = write(first);
  const second = parseInstanceRecord({ id: entry.id, ...s1.entry } as SceneEntityEntry, read, opts);
  const s2 = write(second);
  return { first, second, bytes1: JSON.stringify(s1.entry), bytes2: JSON.stringify(s2.entry) };
}

/** parse → serialize → parse → serialize, for one prefab reference row given its parsed list. */
export function roundTripTemplateRow(row: PrefabDocRow, list: TemplateOverrideList, read: PrefabReader): {
  again: TemplateOverrideList; bytes1: string; bytes2: string;
} {
  const fields = serializeTemplateOwner(list).fields;
  const again = parseTemplateList(toV10Row(row, fields) as unknown as PrefabDocRow, read).list;
  return { again, bytes1: JSON.stringify(fields), bytes2: JSON.stringify(serializeTemplateOwner(again).fields) };
}
