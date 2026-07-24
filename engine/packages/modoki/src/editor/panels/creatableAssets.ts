/** Creatable-asset registry — lets the engine's built-in asset kinds AND a game's own
 *  asset kinds contribute a "Create X" entry to the Assets panel's folder context menu
 *  (Assets.tsx). Before this registry the menu was a flat hardcoded array + one
 *  near-identical `useCallback` per kind, and a game had no way to add its own (a sling
 *  Level/Wave chart had to be hand-authored via a raw `/api/write-file`).
 *
 *  Built-ins register once via `registerBuiltinCreatableAssets()` (called from
 *  `createEditor()`); a game adds its own from `GameDefinition.registerEditorBindings`
 *  (editor-only, never called in the game runtime). Registration is idempotent by `id`
 *  (a re-register — e.g. HMR, or a second editor init — replaces rather than duplicates),
 *  and `getCreatableAssets()` is meant to be read live at menu-open time (not memoized at
 *  mount) so a late-registering game's entries still show up. */

/** One "Create X" menu entry + how to build it. Assets.tsx's generic `runCreate` drives
 *  the shared flow: save dialog → mint guid → write body (or run a full `create`
 *  override) → registerAsset → refresh → `onCreated`. */
export interface CreatableAssetDef {
  /** Unique key, e.g. 'material', 'sling.level'. Namespace a game-contributed id with the
   *  game id (`'<gameId>.<name>'`) so two games' entries can't collide. */
  id: string;
  /** Context-menu label, e.g. 'Create Material'. */
  label: string;
  /** File extension enforced by the save dialog, e.g. '.mat.json'. */
  ext: string;
  /** Save-dialog default filename WITHOUT the extension, e.g. 'New Material'. */
  defaultName: string;
  /** The asset-type string passed to `registerAsset()` for the written file (kept as a
   *  plain string, not the engine's `AssetType` union, so a game can register a kind the
   *  engine doesn't know about — e.g. sling's 'level'/'wave'). */
  assetType: string;
  /** Save-dialog prompt; defaults to `label`. */
  prompt?: string;
  /** Save-dialog starting folder override, e.g. '/assets/scenes'. Ignored when the caller
   *  passes an explicit target folder (right-clicking a specific folder always wins). */
  defaultFolder?: string;
  /** Menu sort key (ascending, ties broken by label). Built-ins keep today's create-menu
   *  order (0..7, matching the order the hardcoded menu used to list them); a
   *  game-contributed entry with no explicit order sorts after every built-in. */
  order?: number;
  /** Build the JSON body written to disk. Receives the fresh guid + the display name
   *  derived from the chosen path. Omit only when `create` fully owns the write. */
  body?: (guid: string, name: string) => unknown;
  /** Full create-flow override — bypasses body/writeFile/registerAsset entirely. Use for a
   *  create that isn't "write one JSON file with an id" (Scene: `newScene()` +
   *  `setCurrentScenePath()` + `saveScene()`, which registers its own asset). */
  create?: (path: string) => Promise<void> | void;
  /** Called once the asset exists (after write + registerAsset + refresh, or after a
   *  custom `create`) — open an editor panel / select the new asset. */
  onCreated?: (a: { path: string; name: string; guid: string }) => void;
}

const registry = new Map<string, CreatableAssetDef>();

/** Register (or replace, by `id`) a creatable-asset menu entry. */
export function registerCreatableAsset(def: CreatableAssetDef): void {
  registry.set(def.id, def);
}

export function unregisterCreatableAsset(id: string): void {
  registry.delete(id);
}

/** All registered entries, sorted by `order` (ties broken by label). Reads the live
 *  registry — call this at menu-open time, not once at mount. */
export function getCreatableAssets(): CreatableAssetDef[] {
  return [...registry.values()].sort((a, b) => {
    const oa = a.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.order ?? Number.MAX_SAFE_INTEGER;
    return oa !== ob ? oa - ob : a.label.localeCompare(b.label);
  });
}
