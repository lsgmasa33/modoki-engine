/** #2030: #2025's file forms, derived from a scene the fuzzer saved. The editor writes only the current form (a member
 *  row's v17 `own`), so no op reaches the older forms that state the same user nodes; this rewrites each user node a
 *  saved instance hangs AT a Missing Prefab placeholder into each of them, one form per scene, for the oracle
 *  (`foldInstanceOracleFuzz.test.ts`) to load and judge (`foldOracle.ts` `placementDiverge`). The rulings: design
 *  § 10.4b (AT a placeholder a user node shows "in every file form"; hub rulings Q3 and Q4 on #2025).
 *
 *  The forms, each a shape some writer produced and today's loader still reads at the current version:
 *  - `v16RowAtPlaceholder`: the node in a v16 row's whole `added` at a NESTED placeholder row — shows there;
 *  - `v16RootAdded`: the same at a missing ROOT (`/`) — shows at `/`;
 *  - `v17RootOwn` / `legacyRootAdded`: a `/` row's `own`, and the entry-level legacy `added` at the root's localId,
 *    under a missing root — each shows at `/` (the legacy form needs the entry to state that localId: none is guessed,
 *    rule 5). Today's own save writes the legacy one there, so each is generated from the other;
 *  - `slotAtMissingNested`: a `nestedStructure` slot's `added` naming the placeholder's reference row — waits
 *    `unresolved` at the placeholder, since AT and INSIDE cannot be told apart without the document (Q4).
 *  Of the root forms, the one the saved scene states is returned as the scene itself, so every form counts as judged. */

import type { SceneEntityEntry } from '../../../packages/modoki/src/runtime/loaders/loadSceneFile';
import type { PrefabReader } from '../../../packages/modoki/src/runtime/prefab/instanceRecord';
import { frameOf, componentOf } from '../../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { isUserNode } from '../foldOracle';

export const FILE_FORMS = ['v16RowAtPlaceholder', 'v16RootAdded', 'v17RootOwn', 'legacyRootAdded', 'slotAtMissingNested'] as const;
export type FileForm = (typeof FILE_FORMS)[number];

type Bag = Record<string, unknown>;
type Scene = { entities?: SceneEntityEntry[] } & Bag;
export interface FormVariant { form: FileForm; entry: number; scene: Scene }

const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v);

/** The slot path (`'5'`, `'5.3'`) naming placeholder row `key` of the instance of `source`, frame by frame, or null when a
 *  step is not a document row (a template-added `a+` node) or a frame on the way does not load. */
function slotPath(source: string, key: string, read: PrefabReader): string | null {
  const top = read(source);
  if (!('doc' in top)) return null;
  let f = frameOf('', top.doc, source);
  const lids: number[] = [];
  const comps = key.split('/').filter(Boolean);
  for (let i = 0; i < comps.length; i++) {
    const lid = [...f.byLid.keys()].find((l) => componentOf(f, l) === comps[i]);
    const row = lid === undefined ? undefined : f.byLid.get(lid);
    if (lid === undefined || !row?.prefab) return null;
    lids.push(lid);
    if (i === comps.length - 1) return lids.join('.');
    const got = read(row.prefab);
    if (!('doc' in got)) return null;
    f = frameOf(`${f.prefix}/${comps[i]}`, got.doc, row.prefab);
  }
  return null;
}

/** Every form of every user node `scene`'s instances hang AT a placeholder, one variant scene per (entry, form): each node
 *  is taken out of the form the scene states it in and put back in another. `placeholdersOf` gives an entry's placeholder
 *  keys (the fold's). */
export function fileForms(scene: Scene, read: PrefabReader, placeholdersOf: (entry: SceneEntityEntry) => readonly string[]): FormVariant[] {
  const out: FormVariant[] = [];
  (scene.entities ?? []).forEach((entry, i) => {
    if (!entry.prefab || !entry.guid) return;
    const e0 = entry as unknown as Bag;
    const pi = isBag(e0.traits) && isBag(e0.traits.PrefabInstance) ? e0.traits.PrefabInstance : undefined;
    const rootLid = typeof pi?.localId === 'number' ? pi.localId : null;
    /** A copy of the scene and of its entry `i`, `take`n from and `put` into; kept when both report a change. */
    const variant = (form: FileForm, take: (e: Bag) => boolean, put: (e: Bag) => boolean) => {
      const s = structuredClone(scene) as Scene;
      const e = s.entities![i] as unknown as Bag;
      if (take(e) && put(e)) out.push({ form, entry: i, scene: s });
    };
    /** Takes `guids` out of `list` of `holder`, deleting it when that empties it. */
    const takeOut = (holder: Bag | undefined, list: string, guids: ReadonlySet<string>): boolean => {
      if (!holder || !Array.isArray(holder[list])) return false;
      holder[list] = (holder[list] as unknown[]).filter((n) => !(isUserNode(n) && guids.has(n.guid)));
      if (!(holder[list] as unknown[]).length) delete holder[list];
      return true;
    };
    const rowOf = (e: Bag, key: string, make = false): Bag | undefined => {
      if (!isBag(e.members)) { if (!make) return undefined; e.members = {}; }
      const m = e.members as Bag;
      if (!isBag(m[key]) && make) m[key] = {};
      return isBag(m[key]) ? m[key] : undefined;
    };
    for (const key of placeholdersOf(entry)) {
      const row = rowOf(e0, key);
      if (key === '/') {
        // AT a missing root the editor's own save states the nodes in the legacy `added`, at the root localId; a `/` row's
        // `own` is the v17 form. Whichever states them, each other form is generated (a whole `/` list is left alone).
        if (Array.isArray(row?.added)) continue;
        const fromOwn = Array.isArray(row?.own) ? (row!.own as unknown[]).filter(isUserNode) : [];
        const fromLegacy = rootLid !== null && Array.isArray(e0.added) ? (e0.added as unknown[]).filter((n): n is Bag & { guid: string } => isUserNode(n) && n.parentLocalId === rootLid) : [];
        const source = fromOwn.length ? 'own' : fromLegacy.length ? 'legacy' : undefined;
        if (!source) continue;
        const nodes = source === 'own' ? fromOwn : fromLegacy;
        const guids = new Set(nodes.map((n) => n.guid));
        const take = (e: Bag) => (source === 'own' ? takeOut(rowOf(e, '/'), 'own', guids) : takeOut(e, 'added', guids));
        const asRow = () => nodes.map((n) => { const c = structuredClone(n) as Bag; delete c.parentLocalId; return { parentLocalId: 0, ...c }; });
        // The form it is stated in is judged as the scene is (counted under that form).
        out.push({ form: source === 'own' ? 'v17RootOwn' : 'legacyRootAdded', entry: i, scene });
        variant('v16RootAdded', take, (e) => { rowOf(e, '/', true)!.added = asRow(); return true; });
        if (source === 'legacy') variant('v17RootOwn', take, (e) => { const r = rowOf(e, '/', true)!; r.own = [...(Array.isArray(r.own) ? r.own : []), ...asRow()]; return true; });
        // The legacy channel names its anchor by the root localId the entry states (none is guessed, rule 5).
        if (source === 'own' && rootLid !== null) variant('legacyRootAdded', take, (e) => { e.added = [...(Array.isArray(e.added) ? e.added : []), ...nodes.map((n) => ({ ...structuredClone(n), parentLocalId: rootLid }))]; return true; });
        continue;
      }
      if (!row || !Array.isArray(row.own) || Array.isArray(row.added)) continue;
      const nodes = (row.own as unknown[]).filter(isUserNode);
      if (!nodes.length) continue;
      const guids = new Set(nodes.map((n) => n.guid));
      const take = (e: Bag) => takeOut(rowOf(e, key), 'own', guids);
      variant('v16RowAtPlaceholder', take, (e) => { rowOf(e, key, true)!.added = structuredClone(nodes); return true; });
      const slot = slotPath(entry.prefab, key, read);
      if (slot === null) continue;
      variant('slotAtMissingNested', take, (e) => {
        const ns = isBag(e.nestedStructure) ? e.nestedStructure : (e.nestedStructure = {});
        if (ns[slot] !== undefined) return false;
        // The missing document's root localId is not known; 1 is what a writer of the slot form would have stated.
        ns[slot] = { added: nodes.map((n) => ({ ...structuredClone(n), parentLocalId: 1 })) };
        return true;
      });
    }
  });
  return out;
}
