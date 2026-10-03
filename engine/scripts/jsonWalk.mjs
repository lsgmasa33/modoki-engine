/** Visit every plain object in a parsed scene / prefab document, at any depth (#2119).
 *
 *  A raw-JSON reader that names the containers it descends into (`entities`, `overrides`,
 *  `added`, `children`, …) goes blind the day the format gains a new one: scene v20 and prefab
 *  v10 state an instance's records on `members[key].traits` and its user nodes in
 *  `members[key].own`, and `show-refs.mjs` and `migrate-font-family-refs.mjs` read neither,
 *  without failing. Walking EVERY object is the form that cannot fall behind: a trait bag is
 *  recognised by what it holds (a key naming the trait), wherever it sits.
 *
 *  `visit(obj, at)` gets each object once, parents before children; `at` is a breadcrumb
 *  (`root.entities[3].members["/a"].traits`). */
export function walkObjects(json, visit, at = 'root') {
  if (Array.isArray(json)) {
    for (let i = 0; i < json.length; i++) walkObjects(json[i], visit, `${at}[${i}]`);
    return;
  }
  if (!json || typeof json !== 'object') return;
  visit(json, at);
  for (const [key, value] of Object.entries(json)) {
    if (value && typeof value === 'object') {
      walkObjects(value, visit, /^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`);
    }
  }
}
