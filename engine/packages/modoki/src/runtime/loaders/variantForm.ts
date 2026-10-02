/** The Prefab Variant form, recognised (#2042). Its own module, importing nothing but the row lookup, because the
 *  validator's Node pass reads it through `prefabOverrides.ts` with no DOM and no trait registry: `prefabRoot.ts` reaches
 *  the loader's types, which pull the whole runtime graph into that project. */

import { rowAt } from '../core/prefabRowAt';

type RootDoc = { id?: string; rootLocalId?: number; entities?: ReadonlyArray<{ localId?: number; prefab?: string }> };

/** A document whose ROOT row is itself a reference to another prefab: the Prefab Variant form (Unity stores a variant as
 *  an instance of its base at the root, prefabs.md U3). Not supported until a variants stage (owner, 2026-10-02, #2028):
 *  it is DAMAGED, so it loads as a Damaged Prefab placeholder and its list round-trips verbatim (rule 9). Expanded, it
 *  built the right tree, but the first save wrote the instance as its base and lost the variant's own nodes (#2042).
 *  The editor never writes the form (a selection root is never collapsed into a reference row); hand or agent JSON can. */
export function rootReferenceRefusal(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as RootDoc).entities)) return null;
  const d = doc as RootDoc & { name?: unknown };
  const root = rowAt(d, d.rootLocalId ?? 1);
  if (!root || typeof root.prefab !== 'string' || !root.prefab) return null;
  return `prefab "${(typeof d.name === 'string' && d.name) || d.id || '(unnamed)'}" has a root that is a reference to another prefab (a prefab variant), which is not supported yet — kept as it is, unexpanded (#2042)`;
}
