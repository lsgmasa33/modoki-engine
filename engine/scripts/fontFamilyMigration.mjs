/** The per-document half of `migrate-font-family-refs.mjs` (#231), apart from the script so a test
 *  can drive it on a document: a script that runs on import cannot be imported (#2119 review).
 *
 *  `migrateFontFamilies(json, index)` rewrites, in place, every `UIElement.fontFamily` that holds a
 *  family name `index` (family → font asset GUID) knows, at any depth (`walkObjects`: a scene v20 /
 *  prefab v10 row's `members[key].traits` and the nodes in its `own`, as well as entities, children
 *  and the pre-v20 channels), and retypes the `resources[]` entry of each family it migrated. A
 *  family the index does not know is left alone and returned in `unmatched`. */
import { walkObjects } from './jsonWalk.mjs';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuid = (s) => typeof s === 'string' && GUID_RE.test(s);

export function migrateFontFamilies(json, index) {
  let refs = 0, dirty = false;
  const unmatched = [];
  const migratedFamilies = new Set();
  walkObjects(json, (obj) => {
    const ui = obj?.UIElement;
    if (!ui || typeof ui !== 'object') return;
    const v = ui.fontFamily;
    if (typeof v !== 'string' || !v || isGuid(v)) return;
    const guid = index.get(v);
    if (!guid) { unmatched.push(v); return; }
    ui.fontFamily = guid;
    migratedFamilies.add(v);
    dirty = true; refs++;
  });
  // The scene's resources[] entry for a migrated family: `{type:'font', path:'<name>'}` becomes
  // `{type:'font-family', path:'<guid>'}`. Left alone when its family was not migrated, so a
  // partially-migrated scene stays loadable.
  if (Array.isArray(json.resources)) {
    for (const r of json.resources) {
      if (r?.type === 'font' && typeof r.path === 'string' && migratedFamilies.has(r.path)) {
        r.type = 'font-family';
        r.path = index.get(r.path);
        dirty = true;
      }
    }
    json.resources.sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.path).localeCompare(String(b.path)));
  }
  return { dirty, refs, unmatched };
}
