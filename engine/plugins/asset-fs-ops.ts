/** Core filesystem operations behind the Assets-panel mutation endpoints
 *  (/api/create-folder, /api/duplicate-asset, /api/move-file). Extracted from
 *  the Vite plugin so the disk behavior — GUID regeneration on duplicate,
 *  sidecar handling, the JSON-vs-binary branch — can be integration-tested
 *  against a real temp directory without standing up an HTTP server.
 *
 *  All functions take ABSOLUTE paths; the endpoints resolve + sandbox the URL
 *  path before calling in. */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { writeMetaSidecar } from './meta-sidecar';

/** mkdir -p. Throws if the folder already exists (the endpoint maps this to 409). */
export function createFolderAt(absPath: string): void {
  if (fs.existsSync(absPath)) throw new Error('Folder exists');
  fs.mkdirSync(absPath, { recursive: true });
}

/** Move/rename a file (or folder) and carry its `.meta.json` sidecar along.
 *  Creates the destination directory if needed. Works for directories too
 *  (renameSync moves the whole subtree). */
export function moveAssetFile(absFrom: string, absTo: string): void {
  const destDir = path.dirname(absTo);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(absFrom, absTo);
  const metaFrom = absFrom + '.meta.json';
  const metaTo = absTo + '.meta.json';
  if (fs.existsSync(metaFrom)) fs.renameSync(metaFrom, metaTo);
}

/** Build the platform-specific command + argv that moves one OR MANY files/folders
 *  to the OS trash in a SINGLE invocation. Pure (no side effects) so the argv can
 *  be asserted directly. Batching the whole set into one call is what stops the
 *  editor from playing a *burst* of macOS trash chimes (one per file) on a
 *  multi-select / model delete — Finder/the recycle bin sound once per call.
 *
 *  Two invariants carried from the single-path version:
 *  - **macOS `as alias` coercion:** a bare `POSIX file "<path>"` specifier makes
 *    Finder fail with -1728 ("Can't get POSIX file …") on macOS 26+; coercing
 *    each to `alias` resolves it to a real FS object Finder can trash. We build a
 *    list of aliases from argv and delete the list in one `tell` (one sound).
 *  - **No shell interpolation:** every path is a separate trailing argv item
 *    (`item N of argv`), never baked into the script string, so a filename with
 *    quotes/semicolons can't inject. */
export function trashCommand(absPaths: string | string[], platform: NodeJS.Platform): { command: string; args: string[] } {
  const paths = Array.isArray(absPaths) ? absPaths : [absPaths];
  if (platform === 'darwin') {
    // Coerce every argv item to an alias, collect into a list, delete the list
    // in one Finder call → one trash sound for the whole batch.
    return {
      command: 'osascript',
      args: [
        '-e', 'on run argv',
        '-e', 'set theItems to {}',
        '-e', 'repeat with p in argv',
        '-e', 'set end of theItems to (POSIX file (contents of p) as alias)',
        '-e', 'end repeat',
        '-e', 'tell application "Finder" to delete theItems',
        '-e', 'end run',
        ...paths,
      ],
    };
  }
  if (platform === 'win32') {
    // Loop over every argv path through the VisualBasic recycler in one process.
    return {
      command: 'powershell',
      args: [
        '-Command',
        "Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($p in $args) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
        ...paths,
      ],
    };
  }
  // Linux + anything else: the `trash-cli` tool (commonly present on desktops)
  // takes a list of paths in a single invocation.
  return { command: 'trash-put', args: [...paths] };
}

/** Move one OR MANY files/folders to the OS trash in a single command. On
 *  Linux/other, `trash-put` may be absent (CI/headless), so fall back to a
 *  recursive remove of each path rather than failing the delete outright.
 *  `platform` + `exec` are injectable for tests. */
export function moveToTrash(
  absPaths: string | string[],
  platform: NodeJS.Platform = process.platform,
  exec: (command: string, args: string[]) => void = (command, args) => { execFileSync(command, args); },
): void {
  const paths = Array.isArray(absPaths) ? absPaths : [absPaths];
  if (paths.length === 0) return;
  const { command, args } = trashCommand(paths, platform);
  if (platform === 'darwin' || platform === 'win32') {
    exec(command, args);
    return;
  }
  try { exec(command, args); }
  catch { for (const p of paths) fs.rmSync(p, { recursive: true, force: true }); }
}

/** Copy an asset to a new path with a freshly-generated GUID so the duplicate
 *  doesn't collide with the original in the manifest. JSON assets carry their
 *  id inline (rewritten); binary assets get a copied `.meta.json` sidecar with
 *  the new id and the parent's `generated` list stripped. `genGuid` is
 *  injectable so tests can assert deterministically.
 *
 *  Returns the new GUID, or `null` when the source is JSON that failed to parse
 *  (copied verbatim — the original endpoint's fallback). */
export function duplicateAssetFile(
  absFrom: string,
  absTo: string,
  genGuid: () => string = randomUUID,
): string | null {
  const destDir = path.dirname(absTo);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const newGuid = genGuid();
  const ext = path.extname(absFrom).toLowerCase();
  if (ext === '.json') {
    // JSON asset: copy + rewrite top-level id
    const txt = fs.readFileSync(absFrom, 'utf-8');
    let json: Record<string, unknown>;
    try { json = JSON.parse(txt); } catch { fs.copyFileSync(absFrom, absTo); return null; }
    json.id = newGuid;
    fs.writeFileSync(absTo, JSON.stringify(json, null, 2));
  } else {
    // Binary asset: copy file + duplicate sidecar with fresh id
    fs.copyFileSync(absFrom, absTo);
    const metaFrom = absFrom + '.meta.json';
    if (fs.existsSync(metaFrom)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFrom, 'utf-8'));
        meta.id = newGuid;
        // Don't carry the parent's `generated` list — derived files belong to
        // the original, not the copy.
        delete meta.generated;
        writeMetaSidecar(absTo, meta);
      } catch {
        writeMetaSidecar(absTo, { id: newGuid, version: 2 });
      }
    } else {
      writeMetaSidecar(absTo, { id: newGuid, version: 2 });
    }
  }
  return newGuid;
}
