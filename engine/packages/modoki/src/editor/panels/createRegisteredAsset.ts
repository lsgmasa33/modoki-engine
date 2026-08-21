/** Create one registered "New X" asset at an EXPLICIT path — the body of the Assets panel's
 *  `runCreate`, extracted so an agent can reach it (#288 gap 5).
 *
 *  WHY IT LIVES HERE. `runCreate` opened the location picker FIRST, and on darwin that picker is
 *  a blocking `osascript "choose file name"` panel (`/api/save-dialog`) — i.e. every clone in this
 *  repo. There is an in-app DOM fallback, but it is reachable only off-darwin or on a backend
 *  network error, so the whole "New X" surface was agent-unreachable. `modoki_create_asset` covers
 *  five fixed `ASSET_TYPES`; this registry is dynamic and game-extensible (`'<gameId>.<name>'` —
 *  sling registers level/wave), which is exactly the part an agent cannot know a priori.
 *
 *  The owner's decision was to route AROUND the dialog rather than change it: the agent supplies
 *  the path, and the human's native dialog is untouched. `runCreate` still calls this, so there is
 *  one create path and not two.
 */

import { newGuid, registerAsset, type AssetType } from '../../runtime/loaders/assetManifest';
import { getCreatableAssets, type CreatableAssetDef } from './creatableAssets';
import { writeAssetFile } from './assetOps';
import { backendFetch } from '../backend/editorBackend';

/** Strip the def's extension off a path to get the display name (mirrors `assetDisplayName`). */
function displayName(path: string, ext: string): string {
  const base = path.split('/').pop() ?? path;
  return base.endsWith(ext) ? base.slice(0, -ext.length) : base.replace(/\.[^.]+$/, '');
}

/** Append the def's extension if the caller left it off. The panel gets this for free from the
 *  save dialog's `ext`; an explicit path has to be normalized the same way, or `def.assetType`
 *  would be registered against a file the manifest classifies as something else. */
export function ensureExt(path: string, ext: string): string {
  return path.endsWith(ext) ? path : `${path}${ext}`;
}

export type CreateRegisteredResult =
  | { ok: true; path: string; name: string; guid: string; def: CreatableAssetDef; manifestRebuilt: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'REFUSED_BY_OP'; error: string; options?: string[] };

/** Force the BACKEND to re-scan, and report whether it did.
 *
 *  ⚠️ Registering the guid is a RENDERER-side act, and `modoki_list_assets` — the read this
 *  function's callers name as their verification — reads the BACKEND's scanned manifest. Those are
 *  two different maps. The file also goes out through `/api/write-file`, which deliberately
 *  SUPPRESSES the watcher for the editor's own saves, so nothing rebuilds the backend map on its
 *  own for a second or more. Measured: a `list_assets` issued straight after a create came back
 *  `count:0` while the file was already on disk.
 *
 *  This is the same defect `/api/delete-asset` had (#288 Phase 1) reached from the other side, and
 *  the sibling create route `/api/create-asset` avoids it by calling `ctx.rebuildManifest()`
 *  inline. A renderer cannot call that, so it asks for the rescan instead. A failure is reported,
 *  not thrown: the file IS written, and a 500 here would read as "nothing was created". */
async function rebuildBackendManifest(): Promise<boolean> {
  try { return (await backendFetch('/api/rescan-assets')).ok; } catch { return false; }
}

/**
 * ⚠️ **A `create`-override def is REFUSED, and that refusal is the most important line in this
 * file.** The built-in `scene` entry's override is
 * `newScene(); selectEntity(null); setCurrentScenePath(path); await saveScene()` — it DISCARDS the
 * live world. Its own source comment reads *"Dialog first so a cancel leaves the current world
 * untouched"*: **the dialog WAS the guard**, and the explicit-`path` route this function exists to
 * provide is precisely what removes it. So a naive `create_registered_asset {kind:'scene'}` would
 * throw away a human's unsaved scene with no `REQUIRES_SAVE` check and report success — the §0
 * rank-1 false success, on the most expensive thing in the editor to lose.
 *
 * `modoki_new_scene` already implements that guard. Adding a second, weaker way to do what it
 * already does is the §2/§7 failure, so this refuses and points at it instead. The refusal is
 * structural — keyed off `def.create` existing, not off the id `'scene'` — because the registry is
 * game-extensible and the next override will not be called "scene".
 */
export async function createRegisteredAsset(kind: string, path: string): Promise<CreateRegisteredResult> {
  const defs = getCreatableAssets();
  const def = defs.find((d) => d.id === kind);
  if (!def) {
    return {
      ok: false, code: 'NOT_FOUND',
      error: `no creatable-asset kind '${kind}' is registered`,
      // The registry comes and goes with the open PROJECT, so the live list is the only true
      // answer — a catalog cannot carry it.
      options: defs.map((d) => d.id),
    };
  }
  if (def.create) {
    return {
      ok: false, code: 'REFUSED_BY_OP',
      error: `the '${kind}' kind is a full create OVERRIDE that runs editor code rather than writing a document, and is refused here. For '${kind}' this would DISCARD the live world with no unsaved-changes check — the save dialog it normally goes through is what made a cancel safe, and passing an explicit path removes exactly that guard.`,
      options: kind === 'scene'
        ? ['modoki_new_scene — same job, and it refuses with REQUIRES_SAVE when the live world has unsaved work']
        : ['create it through the Assets panel, which runs the override behind the human\'s own dialog'],
    };
  }

  const full = ensureExt(path, def.ext);
  const guid = newGuid();
  const name = displayName(full, def.ext);
  const body = def.body ? def.body(guid, name) : { id: guid };

  // ⚠️ REGISTER THE GUID THE DOCUMENT ACTUALLY CARRIES, and stamp one in if it carries none.
  //
  // `def.body` is supplied by the def — including a GAME's def, which this registry exists to
  // support — and nothing forces it to put `guid` in the document. A body with no `id` written to
  // disk is then healed by the backend's own scan (`buildManifest(..., heal=true)` mints a fresh
  // random id and writes it into the file), so the guid this function returned to the caller would
  // name nothing: a ref written with it resolves through the backend manifest to undefined. That
  // is the "an asset ref the build cannot see" class, arriving through a door the def-author never
  // looks at. Every built-in def happens to include `id` today — `builtinCreatableAssets.ts` even
  // comments "`id` first so a fresh guid is stamped" — which is exactly why this must be enforced
  // here rather than trusted per def.
  const doc = body as Record<string, unknown>;
  const docId = typeof doc.id === 'string' && doc.id ? doc.id : undefined;
  if (!docId) doc.id = guid;
  // A def that mints its OWN id wins — the document is the truth, and registering our unused one
  // against it would recreate the same mismatch from the other side.
  const registeredGuid = docId ?? guid;

  const ok = await writeAssetFile(full, JSON.stringify(body, null, 2));
  if (!ok) {
    // A failed write that registered the guid anyway would leave the manifest pointing at a file
    // that is not there — resolvable, and dangling.
    return { ok: false, code: 'REFUSED_BY_OP', error: `failed to write ${full} (path outside the asset roots, or the folder does not exist)` };
  }
  registerAsset(registeredGuid, full, def.assetType as AssetType);
  const manifestRebuilt = await rebuildBackendManifest();
  return { ok: true, path: full, name, guid: registeredGuid, def, manifestRebuilt };
}
