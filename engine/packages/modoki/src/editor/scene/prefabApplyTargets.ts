/** prefabApplyTargets — WHERE an Apply on a nested instance may write each edit (#1693, owner ruling C, U12–U14).
 *
 *  Unity's rule (docs/prefabs.md § "Unity parity" U12): an override on a nested instance can be applied to ANY prefab
 *  on its chain — "Apply to Prefab '<inner>'" writes the frame's own template, "Apply as override in Prefab '<outer>'"
 *  writes it as an override on the reference row that outer prefab holds for the frame. {@link chainSlots} lists those
 *  outer places for a frame, one per level of {@link frameBase}'s chain, and the functions below read, set and drop a
 *  member's statement at one of them.
 *
 *  A level states a member's edits in three places, and every reader here asks all three, in the fold's order: the
 *  row's `overrides` (the frame the row expands), its `nestedOverrides[path]` (a frame deeper down), and a member row
 *  in its `members` (v6 rows, folded over both — `foldStructureLayers`). */

import type { FrameBase } from './prefabBase';
import type { PrefabFile, PrefabEntity } from './prefab';
import type { SceneMemberRow } from '../../runtime/loaders/loadSceneFile';

/** One outer place an edit of the frame can be written: level `level` of the chain, as its row `rowLid`. */
export interface LevelSlot {
  level: number;
  source: string;
  name: string;
  /** The row of `levels[level].doc` whose expansion leads down to the frame. */
  rowLid: number;
  /** Row localIds below that row, down to the frame — the `nestedOverrides` key; empty when the row expands the frame. */
  path: number[];
  /** The `nodeGuid` of each row on `path` (a member row's key components), or null when one has none (pre-v5). */
  pathGuids: string[] | null;
}

/** The outer places of `base`'s frame, outermost first (`level` 0 … n−1; the frame's own template is level n). */
export function chainSlots(base: FrameBase): LevelSlot[] {
  const { levels } = base;
  const n = levels.length - 1;
  const out: LevelSlot[] = [];
  for (let j = 0; j < n; j++) {
    const next = levels[j + 1]!;
    if (next.step.kind !== 'row') continue;
    const path: number[] = [];
    let guids: string[] | null = [];
    for (let i = j + 2; i <= n; i++) {
      const step = levels[i]!.step;
      if (step.kind !== 'row') { guids = null; break; }
      path.push(step.row);
      const g = levels[i - 1]!.doc?.entities.find((e) => e.localId === step.row)?.nodeGuid;
      if (g && guids) guids.push(g);
      else guids = null;
    }
    out.push({ level: j, source: levels[j]!.source, name: levels[j]!.doc?.name ?? levels[j]!.source, rowLid: next.step.row, path, pathGuids: guids });
  }
  return out;
}

/** The member-row key for member `lid` of the frame (document `frameDoc`) at `slot`, or null when none can name it: a
 *  row on the path or the member itself has no `nodeGuid`. The frame's own ROOT is named by the path alone — the row a
 *  level states about a nested root is forwarded to it (`foldMemberRowChannels`' `forwardRoot`) — and has none where the
 *  slot's row expands the frame (its statements are the row's own `overrides`). */
export function memberKeyAt(slot: LevelSlot, frameDoc: PrefabFile, lid: number): string | null {
  if (!slot.pathGuids) return null;
  if (lid === (frameDoc.rootLocalId ?? 1)) return slot.pathGuids.length ? `/${slot.pathGuids.join('/')}` : null;
  const g = frameDoc.entities.find((e) => e.localId === lid)?.nodeGuid;
  return g ? `/${[...slot.pathGuids, g].join('/')}` : null;
}

type Bag = Record<string, unknown>;
type Carrier = Pick<PrefabEntity, 'overrides' | 'nestedOverrides' | 'members' | 'removedTraits'>;

const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v);

/** Everything `c` states about `lid`'s trait `trait` at `path` (member key `key`), folded as the loader folds it: the
 *  row's channel, then its member row over it. Undefined when it states nothing. */
export function statedFields(c: Carrier, path: readonly number[], key: string | null, lid: number, trait: string): Bag | undefined {
  const channel = path.length ? c.nestedOverrides?.[path.join('.')]?.[lid]?.[trait] : c.overrides?.[lid]?.[trait];
  const row = key ? (c.members?.[key] as SceneMemberRow | undefined)?.traits?.[trait] : undefined;
  if (!isBag(channel) && !isBag(row)) return undefined;
  return { ...(isBag(channel) ? channel : {}), ...(isBag(row) ? row : {}) };
}

/** Write `fields` of `lid`'s `trait` as `c`'s statement. A field its member row already states is written THERE — the
 *  member row folds over the channel, so a value written under it would not show; every other field goes on the
 *  channel. An empty `fields` states the trait with no field (an added tag, `{Tag: {}}`). */
export function writeStated(c: Carrier, path: readonly number[], key: string | null, lid: number, trait: string, fields: Bag): void {
  const row = key ? (c.members?.[key] as SceneMemberRow | undefined) : undefined;
  const rowBag = isBag(row?.traits?.[trait]) ? row!.traits![trait] as Bag : undefined;
  const channel: Bag = {};
  for (const [f, v] of Object.entries(fields)) {
    if (rowBag && f in rowBag) rowBag[f] = v;
    else channel[f] = v;
  }
  if (!Object.keys(channel).length && Object.keys(fields).length) return;
  const at = path.length ? ((c.nestedOverrides ??= {})[path.join('.')] ??= {}) : (c.overrides ??= {});
  const byTrait = (at[lid] ??= {});
  byTrait[trait] = { ...(isBag(byTrait[trait]) ? byTrait[trait] : {}), ...channel };
}

/** Drop `c`'s statement of `lid`'s `trait` — the fields `fields` (every one when undefined) — from all three places.
 *  Returns whether anything went. U13: applying a value to an inner prefab reverts the enclosing overrides of it. */
export function dropStated(c: Carrier, path: readonly number[], key: string | null, lid: number, trait: string, fields?: readonly string[]): boolean {
  let changed = false;
  const dropIn = (byLid: Record<number, Record<string, Bag>> | undefined): void => {
    const bag = byLid?.[lid]?.[trait];
    if (!isBag(bag)) return;
    if (!fields) { delete byLid![lid]![trait]; changed = true; }
    else for (const f of fields) if (f in bag) { delete bag[f]; changed = true; }
    if (fields && !Object.keys(bag).length) delete byLid![lid]![trait];
    if (!Object.keys(byLid![lid]!).length) delete byLid![lid];
  };
  if (path.length) {
    const k = path.join('.');
    dropIn(c.nestedOverrides?.[k]);
    if (c.nestedOverrides?.[k] && !Object.keys(c.nestedOverrides[k]!).length) delete c.nestedOverrides[k];
    if (c.nestedOverrides && !Object.keys(c.nestedOverrides).length) delete c.nestedOverrides;
  } else {
    dropIn(c.overrides);
    if (c.overrides && !Object.keys(c.overrides).length) delete c.overrides;
  }
  const row = key ? (c.members?.[key] as SceneMemberRow | undefined) : undefined;
  const rowBag = row?.traits?.[trait];
  if (row && isBag(rowBag)) {
    if (!fields) { delete row.traits![trait]; changed = true; }
    else for (const f of fields) if (f in rowBag) { delete rowBag[f]; changed = true; }
    if (fields && !Object.keys(rowBag).length) delete row.traits![trait];
    if (!Object.keys(row.traits!).length) delete row.traits;
    if (!Object.keys(row).length) delete c.members![key!];
    if (c.members && !Object.keys(c.members).length) delete c.members;
  }
  return changed;
}

/** State that `c` removes member `lid` of the frame: the row's own `removed` where the row expands the frame, a member
 *  row's `removed: true` deeper down. False when no row can say it (a row on the path, or the member, has no nodeGuid). */
export function writeMemberRemoval(c: Carrier & Pick<PrefabEntity, 'removed'>, path: readonly number[], key: string | null, lid: number): boolean {
  if (!path.length) {
    const list = (c.removed ??= []);
    if (!list.includes(lid)) list.push(lid);
    return true;
  }
  if (!key) return false;
  ((c.members ??= {})[key] ??= {} as SceneMemberRow).removed = true;
  return true;
}

/** State that `c` removes `lid`'s `trait`: the row's own `removedTraits` where the row expands the frame, a member row's
 *  `traitRemovals` deeper down (a `nestedStructure` slot would own — and pin — the whole interior). False when no row
 *  can say it: deeper down, and a row on the path or the member has no `nodeGuid`. */
export function writeRemoval(c: Carrier, path: readonly number[], key: string | null, lid: number, trait: string): boolean {
  if (!path.length) {
    const list = (c.removedTraits ??= {})[lid] ??= [];
    if (!list.includes(trait)) list.push(trait);
    return true;
  }
  if (!key) return false;
  const row = ((c.members ??= {})[key] ??= {}) as SceneMemberRow;
  row.traitRemovals = { ...row.traitRemovals, [trait]: true };
  return true;
}

/** Where an Apply writes each key: a default for every key, and per-key choices (#1693). A value is a prefab on the
 *  key's chain — its guid or its path — or `'instance'` / `'frame'`: the prefab of the instance Apply was opened on. */
export interface ApplyTargets {
  default?: string;
  perKey?: Readonly<Record<string, string>>;
}

/** The kinds of key an ENCLOSING level can take today (the rest are written to the frame's own template only). */
const OUTER_KINDS = (key: string): 'field' | 'tag' | 'removedTrait' | 'removedMember' | null =>
  key.startsWith('+trait.') ? 'tag' : key.startsWith('-trait.') ? 'removedTrait' : key.startsWith('-removed.') ? 'removedMember'
    : /^[+\-~]/.test(key) ? null : 'field';

/** Does the frame's member `lid` get `trait` from inside level `level` — its own template, or a level below `level`
 *  (and, `inclusive`, level `level` itself)? A field written at a level that already gives the member the component is an
 *  edit of it; one written where nothing does ADDS it, whole. */
export function traitInside(slots: readonly LevelSlot[], base: FrameBase, frameDoc: PrefabFile, level: number, lid: number, trait: string, inclusive = false): boolean {
  const row = frameDoc.entities.find((e) => e.localId === lid);
  if (row && row.traits[trait] !== undefined) return true;
  return slots.some((s) => (inclusive ? s.level >= level : s.level > level) && !!statedFields(carrierOf(base, s)!, s.path, memberKeyAt(s, frameDoc, lid), lid, trait));
}

/** The row slot `s` names, read from the chain's documents (never written through). */
export function carrierOf(base: FrameBase, s: LevelSlot): PrefabEntity | undefined {
  return base.levels[s.level]?.doc?.entities.find((e) => e.localId === s.rowLid && e.prefab);
}

/** The level a key goes to when the caller names none (owner ruling (a), 2026-09-28): the frame's own template —
 *  except a field or removal of a component an ENCLOSING row added to the member, which goes back to where it came
 *  from, "Apply as override in Prefab '<that one>'": the innermost level that adds it. "Apply to Prefab '<inner>'"
 *  stays on offer for a field (it adds the component to every instance of the inner prefab); a removal has no inner
 *  target, the inner template never had the component. */
export function defaultKeyLevel(base: FrameBase, slots: readonly LevelSlot[], frameDoc: PrefabFile, key: string): number {
  const n = base.levels.length - 1;
  const kind = OUTER_KINDS(key);
  if (kind !== 'field' && kind !== 'removedTrait') return n;
  const parts = key.split('.');
  const [lid, trait] = kind === 'field' ? [Number(parts[0]), parts[1]!] : [Number(parts[1]), parts[2]!];
  if (frameDoc.entities.find((e) => e.localId === lid)?.traits[trait] !== undefined) return n;
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i]!;
    if (statedFields(carrierOf(base, s)!, s.path, memberKeyAt(s, frameDoc, lid), lid, trait)) return s.level;
  }
  return n;
}

/** The level `asked` names for `key` (a canonical, localId-form key), or why it cannot be written there. */
export function resolveKeyLevel(
  base: FrameBase, slots: readonly LevelSlot[], frameDoc: PrefabFile, key: string, asked: string | undefined, sameSource: (a: string, b: string) => boolean,
): number | { skip: string } {
  const n = base.levels.length - 1;
  if (!asked) return defaultKeyLevel(base, slots, frameDoc, key);
  const level = asked === 'instance' || asked === 'frame' ? n : base.levels.findIndex((l) => sameSource(l.source, asked));
  if (level < 0) return { skip: `its target "${asked}" is not a prefab this instance is part of` };
  if (level === n) {
    if (key.startsWith('-trait.')) {
      const [, lidStr, trait] = key.split('.');
      const row = frameDoc.entities.find((e) => e.localId === Number(lidStr));
      if (row && row.traits[trait!] === undefined) return { skip: `Prefab '${frameDoc.name}' has no ${trait} on that member to remove — the prefab that adds it can stop adding it` };
    }
    return n;
  }
  if (!slots.some((s) => s.level === level)) return { skip: `Prefab '${base.levels[level]!.doc?.name ?? asked}' holds this instance through a template node, which an Apply cannot write` };
  if (!OUTER_KINDS(key)) return { skip: `an added node or a move can be applied to Prefab '${frameDoc.name}' only, not yet to an enclosing prefab` };
  return level;
}
