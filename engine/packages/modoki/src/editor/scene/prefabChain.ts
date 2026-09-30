/** An instance's own layer against its enclosing chain: the listing base, the enclosing row overrides, own structure, and
 *  nested frame moves.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { rowAt } from '../../runtime/loaders/prefabOverrides';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { worldIdentityParents } from '../../runtime/core/ecs/identityParents';
import { nestedMoveRef } from './overrideKeyGrammar';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, findEntity } from '../../runtime/core/ecs/entityUtils';
import { isOwnedRoot } from '../../runtime/core/assetRefRules';
import { getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import { memberPathIndex } from '../../runtime/loaders/loadSceneFile';
import { frameBase, layerAddedTraits, type FrameLayer } from './prefabBase';
import { type PrefabFile } from './prefab';
import { getCachedPrefabSync } from './prefabCache';
import { baseTokenResolver } from './prefabTokens';
import { foldMarkedEqual, gateOnMarks, getOverrideValues } from './prefabInstanceOverrides';
import { instanceMovedMembers, prefabMoveTargets } from './prefabMembers';
import {
  captureInstanceStructure, type InstanceStructure, liveTemplateKeys, resolveAddedNodeTokens, type StructureCaptureOpts,
  subtractChainStructure,
} from './prefabCapture';

/** The overrides the Inspector highlights on member `entityId` (`"Trait.field"`): its value diffs against the instance's
 *  base (a nested instance's template under the rows enclosing it, #1492), through the save's mark gate (#1717). */
export function memberOverrideKeys(
  entityId: number, localId: number, currentTraits: Record<string, Record<string, unknown>>, prefab: PrefabFile, rootInstanceId: number,
): Set<string> {
  const base = rootInstanceId ? instanceBase(rootInstanceId, prefab) : prefab;
  const diffs = getOverrideValues(localId, currentTraits, base, rootInstanceId ? baseTokenResolver(rootInstanceId) : undefined);
  const moved = () => !!rootInstanceId && instanceMovedMembers(rootInstanceId, prefab)(entityId, !!diffs['Transform']);
  const entity = findEntity(entityId);
  const marks = entity ? getOverrideMarkSet(entity) : null;
  gateOnMarks(diffs, marks, rowAt(base, localId), moved);
  foldMarkedEqual(diffs, marks, currentTraits, rootInstanceId ? enclosingRowOverrides(rootInstanceId)?.[localId] : undefined);
  const out = new Set<string>();
  for (const [traitName, fields] of Object.entries(diffs)) for (const field of Object.keys(fields)) out.add(`${traitName}.${field}`);
  return out;
}

/** A move made inside an owned NESTED instance of the instance at `rootInstanceId` to a parent outside that
 *  nested instance (#1437, owner's B): its own prefab cannot name the parent, so it is offered to the OUTER
 *  instance. `key` is `~moved.<nested row chain>:<row localId>` — the chain as `nestedStructure` keys it. */
/** `key` is the INTERNAL spelling (row localIds), what Apply/Revert match against once they have turned
 *  a caller's keys into it (`toLocalIdKeys`); `ref` is the one handed OUT, naming each row and the member
 *  by `nodeGuid` where it has one (#1468 Phase 4, `overrideKeyGrammar.ts`). */
export interface NestedFrameMove { key: string; ref: string; chain: number[]; lid: number; memberEcs: number; parentGuid: string; frameRoot: number }

export function nestedFrameMoves(rootInstanceId: number): NestedFrameMove[] {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta) return [];
  const all = getAllEntities();
  const identity = worldIdentityParents(getCurrentWorld());
  const piOf = (id: number) => readTraitData(id, piMeta) as { rootInstanceId?: number; parentLocalId?: number; localId?: number; source?: string } | null;
  /** The frame whose row expanded owned nested root `n`: its owner (`identityParents.ts`). */
  const frameAbove = (n: number): number => identity.ownerOf(n);
  const out: NestedFrameMove[] = [];
  const topDoc = getCachedPrefabSync(piOf(rootInstanceId)?.source ?? '');
  for (const e of all) {
    const pi = piOf(e.id);
    if (!pi || !isOwnedRoot(pi, e.id) || e.id === rootInstanceId) continue;
    const chain: number[] = [];
    let f = e.id;
    for (let n = 0; f && f !== rootInstanceId && n < 64; n++) {
      const p = piOf(f);
      if (!p?.parentLocalId) { f = 0; break; }
      chain.unshift(p.parentLocalId);
      f = frameAbove(f);
    }
    const doc = f === rootInstanceId ? getCachedPrefabSync(pi.source ?? '') : null;
    if (!doc) continue;
    const s = captureInstanceStructure(e.id, doc);
    if (!Object.keys(s.moved).length) continue;
    // A parent inside the nested instance — deeper nested ones included — is its own prefab's to record, UNLESS a
    // prefab around it places the member: that prefab's move wins over any the nested one makes, so only it can
    // take the member back (or elsewhere inside).
    const aroundBase = prefabMoveTargets(e.id, { ...doc, moved: undefined });
    const inFrame = new Set<string>();
    for (const [, t] of memberPathIndex(getCurrentWorld(), e.id)) {
      const g = t ? (t.get(eaMeta.trait) as { guid?: string }).guid : '';
      if (g) inFrame.add(g);
    }
    for (const [lidStr, parentGuid] of Object.entries(s.moved)) {
      const lid = Number(lidStr);
      const memberEcs = [...s.ownedNested].find(([, row]) => row === lid)?.[0]
        ?? all.find((m) => piOf(m.id)?.rootInstanceId === e.id && piOf(m.id)?.localId === lid && m.id !== e.id)?.id;
      if (!memberEcs || (inFrame.has(parentGuid) && !aroundBase(memberEcs))) continue;
      const key = `~moved.${chain.join('.')}:${lid}`;
      out.push({ key, ref: topDoc ? nestedMoveRef(topDoc, chain, lid, getCachedPrefabSync) : key, chain, lid, memberEcs, parentGuid, frameRoot: e.id });
    }
  }
  return out;
}

// ── Revert overrides (per-instance reset toward the prefab base) ─────────

/** Deep-clone a per-field override map (values are JSON-safe trait data). */
function cloneOverrides(
  m: Record<number, Record<string, Record<string, unknown>>>,
): Record<number, Record<string, Record<string, unknown>>> {
  return JSON.parse(JSON.stringify(m));
}

/** What the layers ENCLOSING instance `rootInstanceId` author on it ({@link frameBase}): null for a stored root nothing
 *  encloses, a SCENE-authored reference node, and a frame whose chain cannot be read. */
export function enclosingLayer(rootInstanceId: number): FrameLayer | null {
  return frameBase(rootInstanceId)?.layer ?? null;
}

/** What the layers enclosing instance `rootInstanceId` set on its FIELDS ({@link enclosingLayer}), with member tokens
 *  resolved to live guids. So an instance's BASE — what it resolves to with no override of its own — is its template
 *  under this. Null for an instance nothing encloses.
 *
 *  ONE answer for two questions about a NESTED instance (#1492): what its override list compares against
 *  (`collectInstanceOverrideTree`), and what Revert puts back (`revertOverridesSelective`). Each used to read the bare
 *  template, which a nested instance never shows: a field the outer row sets was listed as the instance's override, and
 *  reverted to the template's value. (Apply no longer asks it: U13 reverts the enclosing override, #1693.) */
export function enclosingRowOverrides(rootInstanceId: number): Record<number, Record<string, Record<string, unknown>>> | null {
  const layer = enclosingLayer(rootInstanceId);
  return layer ? baseTokenResolver(rootInstanceId)(layer.overrides) as Record<number, Record<string, Record<string, unknown>>> : null;
}

/** Instance `rootInstanceId`'s structural diff against `prefab` that is its OWN: the live capture minus what the
 *  layers enclosing it already author ({@link enclosingLayer}, #1506). The subtraction the rebuild makes of a nested
 *  instance (`subtractChainStructure`), made here for the surfaces that ask "what did THIS instance change": the
 *  override list, and Apply, which writes a listed structural key into `prefab`. Against the bare template, a member
 *  an outer row removes was listed as this instance's removal, and Apply of it deleted the member from `prefab` —
 *  from every instance of it. `full` is the capture, when the caller already holds it.
 *
 *  An `added` node the layer authored is never the instance's own, edited or not — see the end of the body. */
export function ownInstanceStructure(rootInstanceId: number, prefab: PrefabFile, full = captureWithLayer(rootInstanceId, prefab)): InstanceStructure {
  const layer = enclosingLayer(rootInstanceId);
  if (!layer) return full;
  const { structure: s } = layer;
  const added = resolveAddedNodeTokens(baseTokenResolver(rootInstanceId), s.added);
  const { structure, replace } = subtractChainStructure(full, { ...s, added }, s.added?.length ? liveTemplateKeys(full.added) : new Map());
  // A node the layer authored and the scene EDITED is kept whole by that subtraction (the rebuild respawns it in place
  // of the fresh copy), but it is still the LAYER's node: listed, Apply copied it into `prefab`, and every other
  // instance of the enclosing prefab then showed it twice — the row's copy and the template's (close-out review). Its
  // edits are the scene's, saved with it.
  const edited = new Set(replace.map((r) => r.guid));
  return edited.size ? { ...structure, added: structure.added.filter((n) => !edited.has(n.guid)) } : structure;
}

/** {@link captureInstanceStructure} of instance `rootInstanceId` against `prefab`, its removed-components pass measured
 *  against the traits the layers enclosing it add too (#1676): a removal of one is the instance's own edit, which the
 *  listing offers — Apply then writes it to the prefab that adds it (#1693), and Revert puts the row's component back. */
export function captureWithLayer(rootInstanceId: number, prefab: PrefabFile, opts: StructureCaptureOpts = {}): InstanceStructure {
  const layer = frameBase(rootInstanceId)?.layer;
  return captureInstanceStructure(rootInstanceId, prefab, layer ? { ...opts, layerTraits: layerAddedTraits(layer, prefab) } : opts);
}

/** The structural keys (localId form) in capture `full` that the layers enclosing the instance author rather than the
 *  instance itself — `full` minus {@link ownInstanceStructure}. Empty for an instance nothing encloses. The listing
 *  never offers them; this is what Apply and Revert refuse, for a caller that still holds one (an older listing, a
 *  hand-built set, a direct API call). */
export function layerAuthoredStructureKeys(rootInstanceId: number, prefab: PrefabFile, full: InstanceStructure): string[] {
  if (!enclosingLayer(rootInstanceId)) return [];
  const keysOf = (st: InstanceStructure) => new Set([
    ...st.added.map((n) => `+added.${n.guid}`),
    ...st.removed.map((lid) => `-removed.${lid}`),
    ...Object.entries(st.removedTraits).flatMap(([lid, names]) => names.map((t) => `-trait.${lid}.${t}`)),
  ]);
  const own = keysOf(ownInstanceStructure(rootInstanceId, prefab, full));
  return [...keysOf(full)].filter((k) => !own.has(k));
}

/** `prefab` as instance `rootInstanceId` resolves it with no override of its own: its members under the rows
 *  enclosing it ({@link enclosingRowOverrides}). `prefab` itself for a stored root. What every "is this field an
 *  override?" reader diffs a live member against — the override list and the Inspector's highlight (#1492). */
export function instanceBase(rootInstanceId: number, prefab: PrefabFile): PrefabFile {
  const rows = enclosingRowOverrides(rootInstanceId);
  if (!rows || !Object.keys(rows).length) return prefab;
  return {
    ...prefab,
    entities: prefab.entities.map((e) => {
      const over = rows[e.localId];
      if (!over) return e;
      const traits: Record<string, unknown> = { ...e.traits };
      for (const [trait, fields] of Object.entries(over)) {
        const own = traits[trait];
        traits[trait] = getTraitByName(trait)?.category === 'tag' ? true
          : { ...(own && typeof own === 'object' ? own as Record<string, unknown> : {}), ...fields };
      }
      return { ...e, traits } as typeof e;
    }),
  };
}

/** Return a copy of `full` with the selected per-field override keys
 *  (`localId.trait.field` — the localId form `revertOverridesSelective` turned them into) removed.
 *  Structural keys are ignored here. Removing
 *  every field of an added trait empties the trait, which also drops it. Revert subtracts what it
 *  reverts; Apply subtracts what it copied into the template (#1469). */
export function subtractFieldOverrides(
  full: Record<number, Record<string, Record<string, unknown>>>,
  selectedKeys: ReadonlySet<string>,
): Record<number, Record<string, Record<string, unknown>>> {
  const out = cloneOverrides(full);
  for (const key of selectedKeys) {
    // An added tag (#1491) is captured as `{Tag: {}}`: dropping the entry is what reverts it.
    if (key.startsWith('+trait.')) {
      const [, lidStr, tagName] = key.split('.');
      const traitMap = out[Number(lidStr)];
      if (!traitMap?.[tagName]) continue;
      delete traitMap[tagName];
      if (Object.keys(traitMap).length === 0) delete out[Number(lidStr)];
      continue;
    }
    if (key.startsWith('+added.') || key.startsWith('-removed.') || key.startsWith('-trait.')) continue;
    const [localIdStr, traitName, fieldName] = key.split('.');
    const localId = Number(localIdStr);
    const traitMap = out[localId];
    if (!traitMap?.[traitName]) continue;
    delete traitMap[traitName][fieldName];
    if (Object.keys(traitMap[traitName]).length === 0) delete traitMap[traitName];
    if (Object.keys(traitMap).length === 0) delete out[localId];
  }
  return out;
}
