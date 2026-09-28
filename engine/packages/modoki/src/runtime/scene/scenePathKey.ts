/** One KEY per scene file, whichever form its path arrives in (#1750: the scene-file debt is keyed by it, and a change
 *  must reach the scene whether or not it is open).
 *
 *  Two path forms name the same scene:
 *   - the dev-server broadcast / asset manifest: `/assets/scenes/x.json`
 *   - the editor "open scene": Vite's absolute `/@fs/<abspath>/…/runtime/assets/scenes/x.json`
 *
 *  Separators become `/` first (a Windows path can carry `\`), then `runtime/assets` collapses to `assets`, the query
 *  goes, and the key is the suffix from the last `/assets/` — so an absolute `/@fs/C:/…` path, the same path with a
 *  lower-case drive letter, and a clean `/assets/…` broadcast all resolve to one key. Only one project is open at a
 *  time, so the `/assets/…` suffix uniquely identifies a scene (no cross-project collision). A path with no `/assets/`
 *  segment (a synthetic prefab-edit key, a test's bare path) is returned with only its separators normalised. */
export function normScenePath(p: string): string {
  const s = p.replace(/\\/g, '/').split('?')[0].replace('/runtime/assets/', '/assets/');
  const i = s.lastIndexOf('/assets/');
  return i >= 0 ? s.slice(i) : s;
}
