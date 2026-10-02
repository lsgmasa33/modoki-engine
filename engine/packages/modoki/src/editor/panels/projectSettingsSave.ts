/** What the Project Settings dialog's Apply posts, and how it recovers from a refused one (#2053) — the dialog's save
 *  DECISIONS, kept out of the `.tsx` so they carry a unit test rather than a jsdom mount (CLAUDE.md § Editor).
 *
 *  ## The defect this replaces
 *
 *  The dialog reads `GET /api/project-settings` when it opens, and Apply used to post that WHOLE object back. The route
 *  deep-merges a post onto the file, so every field went back as the value read on OPEN unless the human edited it — a
 *  setting an agent wrote (`modoki_project_settings action=set`) while the dialog was open was silently reverted by the
 *  next Apply of an unrelated field. #2049 closed it for `readonly-text` fields only.
 *
 *  ## The rule (hub ruling on #2053)
 *
 *  Apply posts ONLY what this dialog changed — every leaf where the draft differs from the open-time read — and sends
 *  each such leaf's open-time value as the route's `expected` precondition (#2049). So a field only someone else changed
 *  is kept; a field both changed is refused 409 with nothing written, and the dialog names it and offers to re-read;
 *  nothing else is posted.
 *
 *  The route compares a `WHOLESALE` subtree's `expected` whole (so a tier ADDED meanwhile refuses a tiers edit rather
 *  than being deleted by it), and accepts a leaf that already holds the posted value (a retry after a half-landed write).
 *
 *  ⚠️ **Known bound.** A leaf ABSENT from the open-time read carries no `expected` (JSON cannot say "absent"), so a
 *  write racing it is not detected. */

import type { ProjectSettingsSchema } from '../createEditor';

type Values = Record<string, unknown>;

/** Paths the route REPLACES rather than merges (`REPLACE_WHOLESALE`, `engine/project-config.ts`). A change anywhere
 *  under one posts the whole subtree, because a partial one would lose every member it does not name — and an omitted
 *  tier is how the "Remove tier" button deletes one. ⚠️ A second copy of the route's set (the package cannot import
 *  `engine/project-config.ts`); `projectSettingsSave.test.ts` pins the two equal. */
export const WHOLESALE_PATHS: readonly string[] = ['rendering.three.tiers'];

const isPlainObject = (v: unknown): v is Values => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function getAt(obj: unknown, keys: readonly string[]): unknown {
  let node = obj;
  for (const k of keys) node = isPlainObject(node) ? node[k] : undefined;
  return node;
}

function setAt(obj: Values, keys: readonly string[], value: unknown): void {
  let node = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(node[k])) node[k] = {};
    node = node[k] as Values;
  }
  node[keys[keys.length - 1]!] = structuredClone(value);
}

/** The dotted paths of the `readonly-text` fields — never posted, whatever the draft holds (#2049): the flow that
 *  derives such a value (OTA Keys → Sync) is its only writer. */
function readonlyKeys(schema: Pick<ProjectSettingsSchema, 'tabs'>): Set<string> {
  const out = new Set<string>();
  for (const tab of schema.tabs) for (const group of tab.groups) for (const field of group.fields) {
    if (field.type === 'readonly-text') out.add(field.key);
  }
  return out;
}

/** Every unit of change between `base` and `draft`, as a dotted path: a leaf, an array, or a `WHOLESALE` subtree.
 *  A key the draft DROPPED outside a wholesale subtree is not reported — the route's patch cannot express a deletion
 *  there, and the old whole-object post could not either. */
function changedUnits(base: unknown, draft: unknown, prefix: string[], out: string[][]): void {
  if (!isPlainObject(draft)) return;
  for (const [k, want] of Object.entries(draft)) {
    const at = [...prefix, k];
    const had = isPlainObject(base) ? base[k] : undefined;
    if (isPlainObject(want) && !WHOLESALE_PATHS.includes(at.join('.')) && (had === undefined || isPlainObject(had))) {
      changedUnits(had, want, at, out);
    } else if (!same(want, had)) out.push(at); // a wholesale subtree lands here whole, so a removed tier is a change
  }
}

export interface SettingsSavePlan {
  /** What Apply posts: only the changed units. Empty means there is nothing to save. */
  patch: Values;
  /** The route's precondition: each changed unit's OPEN-TIME value, where it had one. */
  expected: Values;
  /** The dotted paths in `patch`, for the dialog and for `rebaseSettingsDraft`. */
  changed: string[];
}

/** Diff the draft against the open-time read (`base`, the GET reply the dialog loaded). */
export function planSettingsSave(base: Values, draft: Values, schema: Pick<ProjectSettingsSchema, 'tabs'>): SettingsSavePlan {
  const readonly = readonlyKeys(schema);
  const units: string[][] = [];
  changedUnits(base, draft, [], units);
  const patch: Values = {};
  const expected: Values = {};
  const changed: string[] = [];
  for (const keys of units) {
    const path = keys.join('.');
    if ([...readonly].some((r) => path === r || path.startsWith(`${r}.`))) continue;
    setAt(patch, keys, getAt(draft, keys));
    const was = getAt(base, keys);
    if (was !== undefined) setAt(expected, keys, was);
    changed.push(path);
  }
  return { patch, expected, changed };
}

/** True when a path the route reported as changed on disk touches a unit this dialog changed (either contains the
 *  other — the route reports leaves, a unit can be a whole subtree). */
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/** After a 409, the draft to show against a FRESH read: `fresh` with this dialog's edits laid back over it — except
 *  any whose value moved on disk since `base` was read, which show the value now on disk so the human decides against
 *  it. Returns the new draft and the edits it dropped, which the dialog names.
 *
 *  ⚠️ "Moved since `base`", not just "named by the 409": a write can land AFTER the refusal and before the Re-read, and
 *  an edit kept over it would then post with `expected` = the FRESH value — which the route accepts, replacing that
 *  write unasked (close-out review). An edit the disk already agrees with is kept; there is nothing to decide. */
export function rebaseSettingsDraft(
  fresh: Values, base: Values, draft: Values, schema: Pick<ProjectSettingsSchema, 'tabs'>, changedOnDisk: readonly string[],
): { draft: Values; dropped: string[] } {
  const plan = planSettingsSave(base, draft, schema);
  const next = structuredClone(fresh);
  const dropped: string[] = [];
  for (const path of plan.changed) {
    const keys = path.split('.');
    const moved = !same(getAt(fresh, keys), getAt(base, keys)) && !same(getAt(fresh, keys), getAt(draft, keys));
    if (moved || changedOnDisk.some((c) => overlaps(c, path))) { dropped.push(path); continue; }
    setAt(next, keys, getAt(draft, keys));
  }
  return { draft: next, dropped };
}
