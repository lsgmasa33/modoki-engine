/** Per-project scoping for the editor's localStorage "what was I last editing" memories.
 *
 *  WHY (#473, the root cause behind #460). localStorage is keyed by ORIGIN, and a clone serves
 *  EVERY project it opens from the same origin — the Vite port is derived from the clone
 *  directory, not from the project (`engine/scripts/editorPorts.mjs`). Asset URLs are flat: a rig
 *  in `games/skin-test` is served at `/assets/rigs/zombie.rig2d.json`, with no project segment
 *  (`findAssetRoots` maps a flat project's `runtime/assets` → `/assets`). So a path remembered
 *  under project A is a VALID-LOOKING url in project B, where it addresses B's asset root and
 *  finds nothing — the dev server answers with its SPA fallback (`200 index.html`) and the panel
 *  reports the human's file as broken.
 *
 *  `modoki-last-scene` was already fixed exactly this way (`lastSceneKey` in `scene/serialize.ts`,
 *  whose comment names the same leak); the rig and clip memories never were. This is that fix
 *  made SHARED, so the next remembered-path key does not have to rediscover it.
 *
 *  Scoping is necessary but NOT sufficient: a remembered path also goes stale WITHIN a project
 *  when the asset is deleted, renamed or moved (the branch-switch-under-a-live-editor hazard
 *  CLAUDE.md names). Restore sites therefore validate the path against the asset manifest too —
 *  the same check the `open-skin-editor` agent op already refuses on. */

/** The open project's name. Undefined until `setEditorProjectScope` runs at editor init — the
 *  `'default'` fallback below keeps a pre-init read from writing to an un-suffixed key that would
 *  reintroduce the very leak this module exists to close. */
let _project: string | undefined;

/** Inject the open project's name at editor init. Mirrors `setScenePersistenceProject`. */
export function setEditorProjectScope(name: string | undefined): void {
  _project = name;
}

/** `<base>:<project>` — the key a per-project memory reads and writes. Always call this at
 *  read/write time rather than caching the result: a module registered before
 *  `setEditorProjectScope` would otherwise bake in `default` for the session. */
export function projectScopedKey(base: string): string {
  return `${base}:${_project || 'default'}`;
}

/** Drop a pre-#473 UNSCOPED value for `base`. That value belongs to whichever project happened to
 *  write it last and cannot be attributed now (the manifest isn't loaded this early), so it can
 *  never be restored correctly — dropping it costs one "last opened" memory, once. */
export function clearUnscopedLegacyKey(base: string): void {
  try { localStorage.removeItem(base); } catch { /* quota/private mode */ }
}
