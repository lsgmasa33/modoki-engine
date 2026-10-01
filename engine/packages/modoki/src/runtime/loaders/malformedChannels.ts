/** A scene owner's channels in a shape no reader takes, split off at the file boundary (#1938 C-B step 2, #1933 S3; owner
 *  ruling F-CB1 (a), 2026-10-01).
 *
 *  An owner is a scene ENTRY or a scene-added reference NODE: what states overrides, structure and member rows about a
 *  prefab instance. A value of the wrong shape — `removed: "x"`, a `removedTraits` entry that is not a list, a member
 *  row that is a string, `traits: 5` — used to reach a predicate: one crashed the load (S3, `removed` not an array), the
 *  rest were dropped silently and gone at the next save (the battery's E2–E7, B6). Unity rejects a malformed document
 *  rather than crash; I18 says a reader never drops what it could not interpret. So each such value is taken OUT before
 *  anything reads the owner, kept verbatim, warned about once, and written back by the save where the save states
 *  nothing at its place (`restoreMalformed`).
 *
 *  Pure and Node-safe: the loader and the validator share it. The input is never mutated. */

/** One malformed value: its place in the owner, and the value as the file stated it. */
export type MalformedValue = { path: string[]; value: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isNumberList = (v: unknown): boolean => Array.isArray(v) && v.every((n) => typeof n === 'number');
/** A trait's data: a record, or `null` (a stated-empty component some writers emit). */
const isTraitData = (v: unknown): boolean => v === null || isRecord(v);
/** A list of added nodes the spawner can walk (close-out review #2: `added: [3]` and a node with no `traits` crashed it):
 *  each a record whose `traits` is a record — a reference node (`prefab`) may omit it — and whose `children`, when
 *  stated, is such a list too. A reference node's own channels are its own owner, split where it expands. Taken whole
 *  when any node fails: a list is the unit the save states. */
const isNodeList = (v: unknown): boolean => Array.isArray(v) && v.every((n) =>
  isRecord(n)
  && (n.traits === undefined ? typeof n.prefab === 'string' : isRecord(n.traits))
  && (n.children === undefined || isNodeList(n.children)));

type Check = (v: unknown) => boolean;

/** `owner` without its malformed values, and those values. `clean` is `owner` itself when nothing is malformed. */
export function splitMalformedChannels<T extends object>(owner: T): { clean: T; malformed: MalformedValue[] } {
  const malformed: MalformedValue[] = [];
  const src = owner as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  let changed = false;
  const take = (path: string[], value: unknown): void => { malformed.push({ path, value }); changed = true; };

  /** `channel` must pass `whole`; then each of its entries `each` (when given), each failing entry taken alone. */
  const field = (channel: string, whole: Check, each?: (key: string, v: unknown) => unknown): void => {
    if (!(channel in src) || src[channel] === undefined) return;
    const v = src[channel];
    if (!whole(v)) { take([channel], v); delete out[channel]; return; }
    if (!each) return;
    const kept: Record<string, unknown> = {};
    let dropped = false;
    for (const [k, entry] of Object.entries(v as Record<string, unknown>)) {
      const cleanEntry = each(k, entry);
      if (cleanEntry === DROP) dropped = true;
      else { kept[k] = cleanEntry; if (cleanEntry !== entry) dropped = true; }
    }
    if (dropped) { out[channel] = kept; changed = true; }
  };

  // A localId-keyed bag of trait data: an entry that is no record is taken whole, a trait inside one that is no data alone.
  const traitBags = (base: string[]) => (lid: string, bag: unknown): unknown => {
    if (!isRecord(bag)) { take([...base, lid], bag); return DROP; }
    return withoutBad(bag, (name, data) => (isTraitData(data) ? undefined : [...base, lid, name]));
  };
  const withoutBad = (rec: Record<string, unknown>, bad: (k: string, v: unknown) => string[] | undefined): Record<string, unknown> => {
    let copy: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(rec)) {
      const at = bad(k, v);
      if (!at) continue;
      take(at, v);
      (copy ??= { ...rec });
      delete copy[k];
    }
    return copy ?? rec;
  };

  field('overrides', isRecord, traitBags(['overrides']));
  field('removedTraits', isRecord, (lid, names) => (isStringList(names) ? names : (take(['removedTraits', lid], names), DROP)));
  field('removed', isNumberList);
  field('moved', isRecord, (lid, parent) => (typeof parent === 'string' ? parent : (take(['moved', lid], parent), DROP)));
  field('added', isNodeList);
  field('nestedOverrides', isRecord, (key, frame) => {
    if (!isRecord(frame)) { take(['nestedOverrides', key], frame); return DROP; }
    let copy: Record<string, unknown> | undefined;
    for (const [lid, bag] of Object.entries(frame)) {
      const cleanBag = traitBags(['nestedOverrides', key])(lid, bag);
      if (cleanBag === bag) continue;
      copy ??= { ...frame };
      if (cleanBag === DROP) delete copy[lid];
      else copy[lid] = cleanBag;
    }
    return copy ?? frame;
  });
  field('nestedStructure', isRecord, (key, slot) => {
    if (!isRecord(slot)) { take(['nestedStructure', key], slot); return DROP; }
    return withoutBad(slot, (k, v) => {
      const ok = k === 'removed' ? isNumberList(v) : k === 'added' ? isNodeList(v)
        : k === 'removedTraits' || k === 'moved' ? isRecord(v) : true;
      return ok ? undefined : ['nestedStructure', key, k];
    });
  });
  field('members', isRecord, (key, row) => {
    if (!isRecord(row)) { take(['members', key], row); return DROP; }
    const base = ['members', key];
    let r = withoutBad(row, (k, v) => {
      const ok = k === 'traits' || k === 'traitRemovals' ? isRecord(v)
        : k === 'removedTraits' ? isStringList(v)
        : k === 'added' || k === 'own' ? isNodeList(v)
        : k === 'removed' ? typeof v === 'boolean'
        : k === 'parent' || k === 'guid' || k === 'name' ? typeof v === 'string'
        : true;
      return ok ? undefined : [...base, k];
    });
    if (isRecord(r.traits)) {
      const traits = withoutBad(r.traits, (name, data) => (isTraitData(data) ? undefined : [...base, 'traits', name]));
      if (traits !== r.traits) r = { ...r, traits };
    }
    return r;
  });

  return { clean: (changed ? out : owner) as T, malformed };
}

const DROP = Symbol('drop');

/** Put each kept malformed value back into `target` (an owner the save is writing) where the save states nothing at its
 *  place. Where it does, the save's own statement wins — a user act superseded the value — and that value is returned,
 *  for the caller to report. `target` is mutated. */
export function restoreMalformed(target: Record<string, unknown>, kept: readonly MalformedValue[]): MalformedValue[] {
  const superseded: MalformedValue[] = [];
  for (const m of kept) {
    let at: Record<string, unknown> = target;
    let blocked = false;
    for (const step of m.path.slice(0, -1)) {
      const next = at[step];
      if (next === undefined) { const fresh: Record<string, unknown> = {}; at[step] = fresh; at = fresh; continue; }
      if (!isRecord(next)) { blocked = true; break; }
      // Copy on the way down: the writer's objects may be shared with the live world's records.
      const copy = { ...next };
      at[step] = copy;
      at = copy;
    }
    const last = m.path[m.path.length - 1]!;
    if (blocked || at[last] !== undefined) superseded.push(m);
    else at[last] = structuredClone(m.value);
  }
  return superseded;
}

/** The places `malformed` names, for a warning. */
export function malformedPaths(malformed: readonly MalformedValue[]): string {
  return malformed.map((m) => m.path.join('.')).join(', ');
}
