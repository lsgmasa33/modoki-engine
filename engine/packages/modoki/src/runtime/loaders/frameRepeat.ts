/** The repeat a seat cannot see (#1933 L5, hub ruling 2026-10-01): a template key two prefab FILES give one frame. Kept
 *  out of `documentIdentity.ts` on purpose: that module is Node-safe and the backend's write guard imports it, while the
 *  derive walk this asks (`memberPaths.ts`) pulls the runtime graph. */

import { repeatedTemplateKeys } from './memberPaths';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A template key `doc`'s expansion gives two nodes at ONE derived path (#1933 L5, hub ruling 2026-10-01: refused as a
 *  repeat inside one document is, F-A (1)). Across documents: `doc` adds a node AT a nested row under a key the nested
 *  document's own row declares there (one copied by hand between files). Within `doc`: two of its lists anchored at
 *  different members of ONE nested frame — admission groups by anchor, since it sees `doc` alone and not which of the
 *  nested prefab's rows are frames. No seat can see either; both nodes derive one guid, and an untouched save rewrote one as the other (measured: Dup1 lost, Dup9
 *  twice). The walk is the validator's (`repeatedTemplateKeys`, the derive's file twin), with `read` giving the nested
 *  documents — one it cannot give is not checked, as the validator says. Null when every derived path is single. */
export function frameRepeatRefusal(doc: unknown, read: (guid: string) => unknown): string | null {
  const { repeats } = repeatedTemplateKeys(doc, read as never);
  if (!repeats.length) return null;
  const d = doc as { name?: unknown; id?: unknown };
  const label = `prefab "${str(d.name) || str(d.id) || '(unnamed)'}"`;
  return `${label} gives template key ${repeats[0]!.key} to two nodes in one frame (in its own lists, or in its and a prefab it nests — a key copied by hand) — they derive the same guid, so a save turns one into the other; give one a new key in its prefab file`;
}

/** Every prefab `doc` nests (rows and reference nodes, at any depth, transitively), fetched through `fetch`, as a sync
 *  reader for {@link frameRepeatRefusal}. */
export async function nestedDocReader(doc: unknown, fetch: (guid: string) => Promise<unknown>): Promise<(guid: string) => unknown> {
  const docs = new Map<string, unknown>();
  const visit = async (v: unknown): Promise<void> => {
    if (Array.isArray(v)) { for (const x of v) await visit(x); return; }
    if (!isObj(v)) return;
    if (typeof v.prefab === 'string' && !docs.has(v.prefab)) { // a `children` reference node states no parentLocalId (#1948 close-out R2)
      docs.set(v.prefab, null);
      const nested = await fetch(v.prefab);
      docs.set(v.prefab, nested ?? null);
      if (nested) await visit((nested as { entities?: unknown }).entities);
    }
    for (const [k, x] of Object.entries(v)) if (k !== 'traits' && k !== 'overrides' && k !== 'nestedOverrides') await visit(x);
  };
  await visit((doc as { entities?: unknown } | null)?.entities);
  return (g) => docs.get(g) ?? null;
}
