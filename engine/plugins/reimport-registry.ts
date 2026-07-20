/** Generic asset reimport dispatch.
 *
 *  "Re-import" turns a source asset into its derived runtime files. Each asset
 *  type registers a handler; the dev-server `/api/reimport` endpoint walks a
 *  file or folder (recursively) and dispatches per type. Textures are the first
 *  handler — models/audio/etc. plug in later without touching the recursion.
 */

export interface ReimportContext {
  projectRoot: string;
  /** Resolve a URL path to an absolute file path (null if outside asset roots). */
  resolveAssetPath: (urlPath: string) => string | null;
  /** SSR-load a module via Vite's `server.ssrLoadModule`. Only available
   *  inside the dev server — the build path leaves this undefined, in which
   *  case loader-dependent steps (e.g. model fixup baking) fall back to a
   *  passthrough copy of the source. */
  ssrLoadModule?: (url: string) => Promise<Record<string, unknown>>;
  /** Absolute path to the engine package source (engine/packages/modoki/src).
   *  Set by the BUILD-time Stage A bake so the postprocessor registry is loaded
   *  by absolute path — the build's SSR server is rooted at the project, where the
   *  dev path's root-relative `/packages/modoki/...` would resolve to a nonexistent
   *  project subdir. Unset in dev (its SSR root IS engine/, so the relative path
   *  works and shares the registry singleton with the postprocessor's import). */
  enginePkgSrc?: string;
  /** Snapshot of every scanned project asset (guid/type/path/absPath + sprite block).
   *  The atlas handler is the first reimport that resolves OTHER assets' GUIDs (member
   *  sprites → their parent texture + slice rect), so it needs the project-wide index.
   *  Both the dev server and the build supply it via `scanAllAssets`. */
  listAssets?: () => ReimportAsset[];
}

/** Minimal view of a scanned asset the reimport layer needs — structurally a subset of
 *  the asset scanner's `AssetEntry`, declared here so `ReimportContext` doesn't import
 *  the (heavy) scanner module. */
export interface ReimportAsset {
  guid?: string;
  type: string;
  path: string;
  absPath?: string;
  sprite?: {
    texture: string;
    name?: string;
    rect: { x: number; y: number; w: number; h: number };
    pivot: { x: number; y: number };
    sheetW?: number;
    sheetH?: number;
  };
}

/** Reimport one asset. `sourceUrlPath` is the asset's URL path, `absPath` its
 *  resolved filesystem path. */
export type ReimportHandler = (sourceUrlPath: string, absPath: string, ctx: ReimportContext) => Promise<void>;

const handlers = new Map<string, ReimportHandler>();

export function registerReimportHandler(type: string, handler: ReimportHandler): void {
  handlers.set(type, handler);
}

export function getReimportHandler(type: string): ReimportHandler | undefined {
  return handlers.get(type);
}

export function hasReimportHandler(type: string): boolean {
  return handlers.has(type);
}

/** All asset types with a registered re-import handler. The editor derives its
 *  "what can be re-imported" set from this (via GET /api/reimport-types) instead
 *  of a hardcoded client constant, so a newly-registered server handler (e.g.
 *  audio) surfaces in the per-row menu + recursive re-import without a client
 *  edit. (editor-panels F9.) */
export function getReimportTypes(): string[] {
  return [...handlers.keys()];
}
