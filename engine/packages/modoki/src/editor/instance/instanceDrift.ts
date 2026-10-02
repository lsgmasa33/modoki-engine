/**
 * The save-time DRIFT CHECK (#2001 S4, #2014; design § 10.2, review R3(b)): for every instance whose record is fresh,
 * fold the record and compare it with the live tree. A difference means something changed a prefab-supplied entity
 * without the door — a sub-editor, an agent `eval` / `game-tool-call`, a game system at priority ≥ 200 — which the
 * fuzzer cannot reach. Once the save writes the list (S6), such a change is silently not saved; this turns that into a
 * loud report naming the entity and the field.
 *
 * Dev and test builds only. It WARNS and never writes: it neither touches the record nor the live tree.
 *
 * At S4 the fold stands in for `projectInstance` (S5). What it compares, per keyed node of the instance: the node is live
 * and the fold has it (or the other way round), its components, and every field the fold states. A field the fold
 * leaves to the schema default is not compared, as S2's oracle does not (`foldOracle.ts`). Placeholders and the nodes
 * under them are skipped: the rules' visible change there (ruling B/D) is S5's, and the record keeps their list.
 */
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getAllTraits, getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntityById } from '../../runtime/core/ecs/world';
import { foldInstance } from '../../runtime/prefab/foldInstance';
import { storedInstance } from '../../runtime/prefab/instanceStore';
import { valuesEqual } from '../scene/prefab';
import { guidOfEntity, instanceKeyMap } from './instanceKeys';
import { editorPrefabReader } from './instanceSync';

/** Not compared: identity and the live parent (the fold states neither as a field), and the instance markers. */
const SKIP_TRAITS = new Set(['PrefabInstance', 'UnresolvedPrefabRef']);
const SKIP_FIELDS: Record<string, ReadonlySet<string>> = { EntityAttributes: new Set(['guid', 'parentId']) };

/** One line per difference between stored root `rootId`'s fresh record and its live tree; [] when it has none, or no
 *  fresh record. */
export function instanceDrift(rootId: number): string[] {
  const world = getCurrentWorld();
  const guid = guidOfEntity(rootId);
  const st = guid ? storedInstance(world, guid) : undefined;
  if (!st || st.stale) return [];
  const fold = foldInstance(editorPrefabReader, st.record);
  const under = (k: string) => [...fold.placeholders.keys()].some((p) => p === '/' || k === p || k.startsWith(`${p}/`));
  const live = new Map<string, number>();
  for (const [id, k] of instanceKeyMap(rootId)) live.set(k, id);
  const out: string[] = [];
  for (const [k, node] of fold.nodes) {
    if (under(k)) continue;
    const id = live.get(k);
    const e = id !== undefined ? findEntityById(id, world) : undefined;
    if (!e) { out.push(`${k}: the record has this node, the live tree does not`); continue; }
    const name = (e.get(getTraitByName('EntityAttributes')!.trait) as { name?: string } | undefined)?.name ?? k;
    for (const [t, data] of Object.entries(node.traits)) {
      if (SKIP_TRAITS.has(t)) continue;
      const meta = getTraitByName(t);
      if (!meta) continue;
      if (!e.has(meta.trait)) { out.push(`${name} (${k}): the record has ${t}, the live entity does not`); continue; }
      if (data === true) continue;
      const lv = e.get(meta.trait) as Record<string, unknown> | undefined;
      if (!lv) continue;
      for (const [f, v] of Object.entries(data)) {
        if (SKIP_FIELDS[t]?.has(f)) continue;
        if (!valuesEqual(v, lv[f])) out.push(`${name} (${k}): ${t}.${f} is ${JSON.stringify(lv[f])?.slice(0, 80)} live, ${JSON.stringify(v)?.slice(0, 80)} in the record`);
      }
    }
    for (const meta of getAllTraits()) {
      if (SKIP_TRAITS.has(meta.name) || !e.has(meta.trait) || node.traits[meta.name] !== undefined) continue;
      out.push(`${name} (${k}): the live entity has ${meta.name}, the record does not`);
    }
  }
  for (const k of live.keys()) if (!fold.nodes.has(k) && !under(k)) out.push(`${k}: the live tree has this node, the record does not`);
  return out;
}

/** Whether this build runs the drift check: dev and test builds, never a release. */
function driftCheckOn(): boolean {
  return !!(import.meta.env?.DEV || (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST);
}

/** The save's drift check over the record-owning roots `rootIds` lists (asked only in a build that runs the check):
 *  one `console.warn` per instance that drifted, naming each difference. Returns the lines, for a test. Never throws. */
export function warnInstanceDrift(rootIds: () => Iterable<number>): string[] {
  if (!driftCheckOn()) return [];
  let ids: Iterable<number>;
  try { ids = rootIds(); } catch (err) { console.warn(`[instanceDrift] could not list the instances: ${(err as Error)?.message ?? err}`); return []; }
  const all: string[] = [];
  for (const id of ids) {
    let lines: string[];
    try { lines = instanceDrift(id); } catch (err) { lines = [`the drift check threw: ${(err as Error)?.message ?? err}`]; }
    if (!lines.length) continue;
    console.warn(`[instanceDrift] "${guidOfEntity(id)}" was changed outside the instance door (#2001 S4); once the save writes the list, these are not saved:\n  ${lines.slice(0, 12).join('\n  ')}${lines.length > 12 ? `\n  (+${lines.length - 12} more)` : ''}`);
    all.push(...lines);
  }
  return all;
}
