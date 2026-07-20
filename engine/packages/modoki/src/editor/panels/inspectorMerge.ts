/** Inspector multi-select merge logic — extracted from Inspector.tsx so the
 *  trait-intersection + mixed-field computation can be unit-tested without the
 *  panel's heavy transitive deps (three.js, model import, texture resolver). */

import { getEntityTraits, readTraitData } from '../../runtime/ecs/entityUtils';
import type { TraitMeta } from '../../runtime/ecs/traitRegistry';

/** One trait entry in an Inspector read snapshot. `mixed` (multi-select only)
 *  holds the field keys whose values differ across the selected entities. */
export type TraitEntry = { meta: TraitMeta; data: Record<string, unknown> | null; mixed?: Set<string> };

/** Value-equality between two trait-read snapshots. Lets the Inspector skip the
 *  React update (and re-render) when a frame produced identical data — essential
 *  now that we re-read the selected entity every frame for live system updates.
 *  Also compares the `mixed` field-sets so a multi-select that flips a field
 *  in/out of "mixed" still refreshes even when the representative value is stable. */
export function sameTraitResult(a: TraitEntry[], b: TraitEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].meta !== b[i].meta) return false;
    const da = a[i].data, db = b[i].data;
    if (da !== db) {
      if (!da || !db) return false;
      const keys = Object.keys(da);
      if (keys.length !== Object.keys(db).length) return false;
      for (const k of keys) if (da[k] !== db[k]) return false;
    }
    const ma = a[i].mixed, mb = b[i].mixed;
    if ((ma?.size ?? 0) !== (mb?.size ?? 0)) return false;
    if (ma && mb) for (const k of ma) if (!mb.has(k)) return false;
  }
  return true;
}

/** Read traits for the current selection, merging across multiple entities.
 *  Single-select returns each trait verbatim. Multi-select returns only the
 *  traits present on ALL selected entities, each with merged data (a
 *  representative value per field) and a `mixed` set marking fields whose values
 *  differ. `nonShared` lists component trait names present on some but not all
 *  entities — surfaced as a note so the user knows the panel is hiding them. */
export function readMergedTraits(ids: number[]): { result: TraitEntry[]; nonShared: string[] } {
  if (ids.length === 0) return { result: [], nonShared: [] };
  if (ids.length === 1) {
    return {
      result: getEntityTraits(ids[0]).map((meta) => ({ meta, data: readTraitData(ids[0], meta) })),
      nonShared: [],
    };
  }

  // Per-entity trait map keyed by trait name.
  const perEntity = ids.map((id) => {
    const m = new Map<string, { meta: TraitMeta; data: Record<string, unknown> | null }>();
    for (const meta of getEntityTraits(id)) {
      m.set(meta.name, { meta, data: meta.category === 'tag' ? {} : readTraitData(id, meta) });
    }
    return m;
  });

  const commonNames = [...perEntity[0].keys()].filter((n) => perEntity.every((m) => m.has(n)));
  const result: TraitEntry[] = [];
  for (const name of commonNames) {
    const meta = perEntity[0].get(name)!.meta;
    if (meta.category === 'tag') { result.push({ meta, data: {} }); continue; }
    const datas = perEntity
      .map((m) => m.get(name)!.data)
      .filter((d): d is Record<string, unknown> => !!d);
    if (datas.length === 0) { result.push({ meta, data: null }); continue; }
    const merged = { ...datas[0] };
    const mixed = new Set<string>();
    for (const key of Object.keys(merged)) {
      if (!datas.every((d) => Object.is(d[key], datas[0][key]))) mixed.add(key);
    }
    result.push({ meta, data: merged, mixed: mixed.size ? mixed : undefined });
  }

  // Traits present on some-but-not-all entities (EntityAttributes is implicit/
  // core, so it's excluded from the "not shared" note). Tags count too — a tag
  // on a subset is otherwise invisible: not rendered (not common) and, if we
  // only unioned components, not noted either.
  const union = new Set<string>();
  for (const m of perEntity) for (const [n, v] of m) {
    if ((v.meta.category === 'component' || v.meta.category === 'tag') && n !== 'EntityAttributes') union.add(n);
  }
  const commonSet = new Set(commonNames);
  const nonShared = [...union].filter((n) => !commonSet.has(n)).sort();
  return { result, nonShared };
}
