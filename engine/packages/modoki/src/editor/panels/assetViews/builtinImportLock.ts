/** Whether an asset Inspector may OFFER to change an asset's import settings (#2060).
 *
 *  An engine built-in (`/modoki/assets/…`: the engine fonts, `white.hdr`, `favicon.png`) has its import settings refused
 *  by the backend in the PACKAGED editor (#1959: `/api/write-meta` and `/api/reimport` are dev-only writers there, since
 *  the files sit inside the signed app bundle). The Font, Environment and Texture views used to keep every control and
 *  their Apply button live anyway — an edit was discarded at save with a toast, Apply failed with a "Baking … failed"
 *  toast — and the stats rows still said "re-import to fill them in" over an asset that cannot be re-imported. A
 *  packaged build ships no `.meta.local.json`, so that hint showed on EVERY built-in.
 *
 *  In a dev clone nothing is locked: there the pair stays open on purpose, because an engine developer applying a
 *  built-in's settings is editing the engine repo, which is where a built-in is changed.
 *
 *  A plain `.ts` so the decision is unit-tested without mounting a panel (docs/editor.md § Panels). */
import { useEditorPackaged, isEditorPackaged } from '../../editorHost';

/** The engine's built-in asset root as the renderer spells it — the server's `ENGINE_ASSETS_URL_PREFIX` plus `/`, which
 *  the renderer package cannot import (`engine/plugins`); `builtinImportLock.test.tsx` pins the two together. */
export const ENGINE_BUILTIN_PREFIX = '/modoki/assets/';

/** The reason every locked view shows, naming the route out that DOES work: copying the file into the project. */
export const BUILTIN_IMPORT_LOCKED_REASON =
  "Engine built-in: its import settings are read-only in the packaged editor. To use different settings, copy it into "
  + 'your project (Reveal in Finder, then drop the file into the Assets panel) and select the copy.';

export function isEngineBuiltin(path: string | undefined): boolean {
  return typeof path === 'string' && path.startsWith(ENGINE_BUILTIN_PREFIX);
}

/** The reason `path`'s import settings cannot be changed here, or null when they can. */
export function builtinImportLock(path: string | undefined, packaged: boolean): string | null {
  return packaged && isEngineBuiltin(path) ? BUILTIN_IMPORT_LOCKED_REASON : null;
}

/** The reason a MULTI-selection's shared import settings are locked: one built-in in it locks the batch, because the
 *  batch view applies every edit to every path. Reachable by Cmd-clicking a project asset after an Engine-section one. */
export function batchImportLock(paths: readonly string[], packaged: boolean): string | null {
  return packaged && paths.some(isEngineBuiltin)
    ? `The selection includes an engine built-in, whose import settings are read-only in the packaged editor. Deselect it to edit the others together.`
    : null;
}

/** `builtinImportLock` for the editor this renderer runs in. */
export function useBuiltinImportLock(path: string | undefined): string | null {
  return builtinImportLock(path, useEditorPackaged());
}

export function useBatchImportLock(paths: readonly string[]): string | null {
  return batchImportLock(paths, useEditorPackaged());
}

/** `builtinImportLock` read outside React — the agent ops that open a texture's Sprite / 9-slice editor refuse with it. */
export function currentBuiltinImportLock(path: string | undefined): string | null {
  return builtinImportLock(path, isEditorPackaged());
}
