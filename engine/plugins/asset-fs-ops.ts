/** Core filesystem operations behind the Assets-panel mutation endpoints
 *  (/api/create-folder, /api/duplicate-asset, /api/move-file). Extracted from
 *  the Vite plugin so the disk behavior — GUID regeneration on duplicate,
 *  sidecar handling, the JSON-vs-binary branch — can be integration-tested
 *  against a real temp directory without standing up an HTTP server.
 *
 *  All functions take ABSOLUTE paths; the endpoints resolve + sandbox the URL
 *  path before calling in. */

import fs from 'fs';
import { assetJsonBytes } from './backend/editorBackendRouter';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { writeMetaSidecar, CORRUPT_SIDECAR_SUFFIX } from './meta-sidecar';
// The ONE subtree pre-flight (#883/#990/#989/#1004) — see engine/scripts/deleteBoundary.mjs. Used
// only by the Linux `rmSync` fallback in `moveToTrash`; the darwin/win32 paths hand the delete to
// the OS trash, which moves rather than unlinks and so cannot orphan a link's payload.
import { findDeleteBoundaries } from '../scripts/deleteBoundary.mjs';

/** The sidecars an asset carries, as SUFFIXES. Spelled once: `moveAssetFile` renames them and
 *  `moveToTrash`'s refusal predicate must hold them back, and a second hand-kept copy of the list
 *  is how one of them gets stranded. (`sidecarsFor` in `editor/panels/assetOps.ts` is the editor's
 *  own copy — it lists only two, and the mismatch is noted there.) */
const SIDECAR_SUFFIXES: readonly string[] = ['.meta.json', '.meta.local.json', '.meta.json' + CORRUPT_SIDECAR_SUFFIX];

/** mkdir -p. Throws if the folder already exists (the endpoint maps this to 409). */
export function createFolderAt(absPath: string): void {
  if (fs.existsSync(absPath)) throw new Error('Folder exists');
  fs.mkdirSync(absPath, { recursive: true });
}

/** Move/rename a file (or folder) and carry BOTH halves of its sidecar pair along —
 *  the committed `.meta.json` and the gitignored machine-local `.meta.local.json`
 *  (see `meta-sidecar.ts`). Carrying only the committed half left the local one
 *  stranded under the OLD filename and the moved asset with no byte stats
 *  (QA-CTX-0005, sibling of the delete leak). Creates the destination directory if
 *  needed. Works for directories too (renameSync moves the whole subtree). */
export function moveAssetFile(absFrom: string, absTo: string): void {
  const destDir = path.dirname(absTo);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(absFrom, absTo);
  // ⚠️ `.meta.json.corrupt` rides along too (#778). It is the QUARANTINED copy of a sidecar that
  // did not parse, and it holds the only surviving copy of that asset's authored fields — the
  // exact thing this loop exists to stop being stranded under the old filename (QA-CTX-0005, for
  // `.meta.local.json`). It is gitignored, so a stranding is invisible to `git status` and would
  // only surface when someone went looking for data they had already lost.
  for (const suffix of SIDECAR_SUFFIXES) {
    const metaFrom = absFrom + suffix;
    if (fs.existsSync(metaFrom)) fs.renameSync(metaFrom, absTo + suffix);
  }
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
 *  - **No shell interpolation:** every path travels as DATA, never baked into the
 *    script string, so a filename with quotes/semicolons can't inject.
 *
 *  ⚠️ That second invariant held on macOS and was FALSE on Windows until #875, and the
 *  distinction is the whole trap: `osascript -e … p1 p2` binds real argv (`on run argv`),
 *  but **`powershell -Command "<script>" p1 p2` does not bind `$args`** — it appends the
 *  trailing items to the command line as further SOURCE. Measured on `win`:
 *    • `foreach ($p in $args)` iterated zero times, so nothing was ever recycled;
 *    • `…\a file.json` re-parsed into two arguments, so a bound version would have
 *      deleted `…\a` — a path the user never selected;
 *    • a filename containing `; <statement>` EXECUTED that statement.
 *  Wrapping in `& { }` binds `$args` and fixes none of the last two. The paths must
 *  leave the command line entirely — hence stdin, returned as `input` below.
 *
 *  ⚠️ **Naive stdin is not enough either**, and the reason is NOT reproducible on a dev box
 *  whose console is already UTF-8 (65001) — which is how it nearly shipped unproven. On a
 *  console still using a legacy code page (en-US 437, ja-JP 932) the UTF-8 bytes are decoded
 *  wrong, the path matches nothing, and the file SILENTLY survives — exit 0, nothing thrown.
 *  `にほんご.json` is an ordinary asset name here. Measured under a forced CP437: without the
 *  reset the non-ASCII path survived, with it the file was recycled.
 *
 *  ⚠️ The script reads `[Console]::In`, and the encoding reset is what makes that correct —
 *  **the two go together.** Do not switch it to the `$input` pipeline variable: that reads
 *  through PowerShell's own stdin decoder, which the reset does not reach, so the non-ASCII
 *  bug returns and `trashCommandLive.test.ts`'s CP437 case would be pinning a script that no
 *  longer exists in that form.
 *
 *  ⚠️ **A per-path failure must be COUNTED and reported** — see the script below. PowerShell
 *  treats a .NET exception there as non-terminating and still exits 0, which made a failed
 *  delete report success. */
export function trashCommand(
  absPaths: string | string[],
  platform: NodeJS.Platform,
): { command: string; args: string[]; input?: string } {
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
    // Paths arrive on STDIN, one per line — never on the command line (#875, see above).
    // `DeleteFile` throws "Could not find file" on a directory, so branch on what the path
    // IS: `DeleteDirectory` is the folder API. Both recycle rather than hard-delete.
    for (const p of paths) {
      if (/[\r\n]/.test(p)) {
        // A newline would split one path into two lines and delete something else. Windows
        // does not permit control characters in a filename, so this is unreachable in
        // practice — it is here because the line protocol's failure mode is a WRONG delete.
        throw new Error(`trashCommand: path contains a newline, refusing to build a delete for it: ${JSON.stringify(p)}`);
      }
    }
    return {
      command: 'powershell',
      args: [
        '-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName Microsoft.VisualBasic; '
        // Force UTF-8 BEFORE the read. `[Console]::In` decodes through the console's code
        // page, and a default en-US (437) / ja-JP (932) box is not UTF-8 — there the bytes
        // written to stdin are mangled, the path matches nothing, and the file SILENTLY
        // survives (exit 0, nothing thrown). ⚠️ A dev box on 65001 CANNOT exercise this, so
        // it reads like dead code and a mutation check on this machine says it is. Pinned by
        // the "legacy console code page" case in trashCommandLive.test.ts, which forces 437.
        + '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false; '
        // …and OUTPUT too. The `FAILED <path>` line below is the ONLY place a failing path is
        // named (the thrown execFileSync error carries the script, not the path), and without
        // this it encodes through the OEM code page: `にほんご.json` was measured arriving as
        // `????.json`. Same code-page class as the line above, on the other direction — and the
        // one that makes the diagnostic useless for exactly the names the docblock says are
        // ordinary here.
        + '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; '
        // ⚠️ COUNT failures and exit non-zero, or a per-path error is SILENT. A .NET exception
        // from the Delete* call does not stop the script: PowerShell writes it to stderr,
        // carries on, and **exits 0** — so `execFileSync` does not throw, `/api/delete-asset`
        // returns `{ok:true}`, unbinds the asset in the renderer and rebuilds the manifest, for
        // a file still sitting on disk (a handle held by a watcher or an image tool, a denied
        // ACL, a >260-char path). Measured: one bad path among two good ones exited 0.
        // ⚠️ Do NOT reach for `$ErrorActionPreference='Stop'` instead — that abandons every
        // remaining path, turning one failure into a batch that half-happened. try/catch per
        // path keeps the batch going AND reports; the good paths are still deleted (measured).
        + '$failed = 0; '
        + 'foreach ($p in ([Console]::In.ReadToEnd() -split "`n")) { '
        + '$p = $p.TrimEnd("`r"); if ($p -eq \'\') { continue } '
        + 'try { '
        + 'if (Test-Path -LiteralPath $p -PathType Container) '
        + "{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } "
        + "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } "
        + "} catch { $failed++; [Console]::Error.WriteLine('modoki-trash: FAILED ' + $p + ' :: ' + $_.Exception.Message) } } "
        + 'if ($failed -gt 0) { exit $failed }',
      ],
      input: `${paths.join('\n')}\n`,
    };
  }
  // Linux + anything else: the `trash-cli` tool (commonly present on desktops)
  // takes a list of paths in a single invocation.
  return { command: 'trash-put', args: [...paths] };
}

/** The per-path failure marker the win32 script writes to stderr. Parsed rather than inferred,
 *  because the thrown `execFileSync` error carries the SCRIPT, never the path. */
const TRASH_FAILED_PREFIX = 'modoki-trash: FAILED ';

export interface TrashExecResult { failed: string[] }
export interface TrashResult {
  /** Paths that did NOT go. Empty on the happy path.
   *
   *  ⚠️ **NOT win32-only since #1006.** It was, and that sentence stood here while it stopped being
   *  true. The Linux `rmSync` FALLBACK (no `trash-put`) now reports any path whose subtree is not
   *  self-contained — a link out of the tree, a mount point — because deleting it would sever the
   *  link, orphan the payload and report success (#883). darwin and win32 hand the delete to the OS
   *  trash, which MOVES rather than unlinks, so they still report only what the OS itself refused.
   *
   *  A refused path holds back its SIDECARS too (`<path>.meta.json` &c), so a group is never split
   *  — see `moveToTrash`'s fallback for why splitting it is worse than the bug it guards. */
  failed: string[];
}

/** Pull the failing paths out of the script's stderr.
 *
 *  ⚠️ The path is everything between the prefix and the ` :: ` that introduces the exception
 *  message — split on the FIRST ` :: `, not the last, because a Windows path cannot contain
 *  `:` outside the drive spec but an exception message frequently can. */
export function parseTrashFailures(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split('\n')) {
    const i = line.indexOf(TRASH_FAILED_PREFIX);
    if (i < 0) continue;
    const rest = line.slice(i + TRASH_FAILED_PREFIX.length);
    const sep = rest.indexOf(' :: ');
    const p = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
    if (p) out.push(p);
  }
  return out;
}

/** Move one OR MANY files/folders to the OS trash in a single command. On
 *  Linux/other, `trash-put` may be absent (CI/headless), so fall back to a
 *  recursive remove of each path rather than failing the delete outright.
 *  `platform` + `exec` are injectable for tests. */
export function moveToTrash(
  absPaths: string | string[],
  platform: NodeJS.Platform = process.platform,
  // ⚠️ `input` is not optional decoration: on win32 it carries the PATHS (#875). An `exec`
  // that drops it reads an empty stdin and deletes NOTHING, while still exiting 0 — so a test
  // stub that ignores it is modelling a process that cannot exist, and one that asserts only
  // on `args` cannot tell a working delete from a no-op.
  exec: (command: string, args: string[], input?: string) => TrashExecResult | void =
    (command, args, input) => {
      // stderr is CAPTURED, not inherited: it carries the per-path `modoki-trash: FAILED …`
      // lines, which are the only place a failing path is named.
      try {
        execFileSync(command, args, { ...(input === undefined ? {} : { input }), stdio: ['pipe', 'pipe', 'pipe'] });
        return { failed: [] };
      } catch (e) {
        const stderr = String((e as { stderr?: unknown })?.stderr ?? '');
        const failed = parseTrashFailures(stderr);
        // A non-zero exit with no FAILED line is the command itself failing (no `powershell`,
        // no `trash-put`) — a different thing from "these three paths did not go", and the
        // caller must not read it as a partial success. Rethrow.
        if (failed.length === 0) throw e;
        return { failed };
      }
    },
): TrashResult {
  const paths = Array.isArray(absPaths) ? absPaths : [absPaths];
  if (paths.length === 0) return { failed: [] };
  const { command, args, input } = trashCommand(paths, platform);
  if (platform === 'darwin' || platform === 'win32') {
    return (exec(command, args, input) as TrashExecResult | undefined) ?? { failed: [] };
  }
  try { exec(command, args, input); return { failed: [] }; }
  catch {
    // ⚠️ **The fallback is a REAL DELETE, not a trash** — nothing here is recoverable from a
    // Recycle Bin afterwards — and `rmSync(recursive)` acts on the NAME, not the data (#883). A
    // linked asset folder (a shared texture library is the plausible shape) would be unlinked, its
    // payload orphaned, and the `return { failed: [] }` below would report a clean success.
    //
    // ⚠️ **This REPORTS rather than refusing, and the asymmetry with `addNativeTarget` is
    // deliberate** (#1006). `deleteBoundary.mjs` supplies the detection and explicitly leaves the
    // policy to the caller — and this caller already HAS a channel for "this path did not go":
    // `failed`, which the Assets panel surfaces. The defect here was never a missing throw, it was
    // the unconditional `{ failed: [] }` claiming success for paths that were destroyed; #884 fixed
    // the same reporting failure in this file through a different cause. Throwing instead would
    // also lose the paths that CAN safely go, for the sake of one that cannot.
    // ⚠️ **A REFUSED PATH TAKES ITS SIDECARS WITH IT** (#1006 close-out). Per-path granularity is
    // right for the asset itself and WRONG across a group: `deletionPathsFor` (assetOps.ts) sends
    // one flat list holding the asset AND `<asset>.meta.json` / `.meta.local.json`, so refusing
    // only the asset would delete the sidecar of a file that is still on disk. The next
    // `rebuildManifest` then mints that asset a NEW GUID and every scene/prefab reference to the
    // old one resolves to `undefined` — the asset silently vanishes from every scene, permanently.
    // That is worse than the severing this guard exists to stop, and it would have been reported
    // as `ok:true` with one refused path.
    //
    // ⚠️ **Four cases, and this predicate has now been wrong in three different ways. Read the
    // history before changing it.**
    //
    //   `p === r`                      the refused path itself.
    //   `p === r + <sidecar suffix>`   its sidecars — matched EXACTLY, against the one list.
    //   `p.startsWith(r + sep)`        its children, when `r` is a refused DIRECTORY.
    //   `r.startsWith(p + sep)`        the converse: a refused path INSIDE `p`.
    //
    // What each version got wrong, because the failures are not symmetric:
    //
    //   `p === r` alone  — split an asset from its sidecars. The sidecar of a file still on disk
    //     was deleted, the next manifest rebuild minted a new GUID, and every scene reference to
    //     the old one broke. Permanent, silent.
    //   `+ startsWith(r)` — over-matched name-siblings: a refused folder `robot` held back
    //     `robot.glb` selected beside it. Harmless, but a lie in the toast.
    //   `+ startsWith(r + '.')` — DROPPED the children of a refused directory, and that is real
    //     data loss: `findDeleteBoundaries` refuses directories (a junction is `kind:'link'` at
    //     depth 0), so a list holding `robot` and `robot/mesh.glb` held the folder back and then
    //     `rmSync`'d the child THROUGH the junction, destroying the file in the shared library it
    //     points at. ⚠️ And it did NOT fix the name-sibling it was written for —
    //     `'robot.glb'.startsWith('robot' + '.')` is TRUE, because every asset name has an
    //     extension. The comment here claimed otherwise for a commit.
    //
    // Hence exact sidecar matching (the set is closed and already spelled once, above) rather
    // than any prefix rule. The fourth case exists because refusal has to propagate BOTH ways:
    // `findDeleteBoundaries` deliberately exempts a link pointing INSIDE the subtree (the npm
    // `.bin` shim shape) and a dangling one, so a child can be refused while its parent is not —
    // and `rmSync`-ing the parent recursively then takes the refused child with it while the reply
    // still reports it as `failed`.
    //
    // `path.sep` and not `'/'`: every path here comes from `resolveAssetPath` -> `path.resolve`,
    // so they are native and have no trailing separator; and on POSIX a backslash is a legal
    // filename character, so matching one there would re-open the over-match above.
    //
    // ⚠️ **Known residual, not fixed here: these are RAW string compares in a path-identity
    // position.** Two spellings of one path (case, or NFC vs NFD) defeat them, and
    // `/api/delete-asset` takes an arbitrary list from MCP. It is not reachable in practice
    // today — this branch is linux/other only (darwin and win32 return above), where the
    // filesystem is case- and normalisation-sensitive, so two spellings do not resolve to one
    // file. It becomes live on a case-insensitive mount under Linux (CIFS/exFAT, or an ext4
    // casefold dir) — which is awkwardly the "shared library on another volume" story this guard
    // exists for. The route one layer up uses `samePath` for exactly this reason;
    // `pathIdentityIsShared.test.ts` cannot see this because it bans `resolve(x) === y`, not
    // `startsWith`.
    const refused = paths.filter((p) => findDeleteBoundaries(p).length > 0);
    const isHeldBack = (p: string): boolean => refused.some((r) =>
      p === r
      || SIDECAR_SUFFIXES.some((suffix) => p === r + suffix)
      || p.startsWith(r + path.sep)      // `p` is INSIDE a refused directory
      || r.startsWith(p + path.sep));    // a refused path is inside `p` — deleting `p` takes it too
    const failed: string[] = [];
    for (const p of paths) {
      if (isHeldBack(p)) { failed.push(p); continue; }
      fs.rmSync(p, { recursive: true, force: true });
    }
    return { failed };
  }
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
    // Bytes from the one definition (#831) — a copied asset must not be born without the trailing
    // newline every committed asset doc has, or its first edit shows a spurious
    // `\ No newline at end of file` on a line nobody touched.
    // ⚠️ This duplicates ANY `.json`, including `.scene.json` and `.prefab.json` — those used to
    // keep the CLIENT writer's newline-less bytes (`editor/scene/serialize.ts` emitted none, so a
    // duplicated scene would otherwise churn on its very first save). #835 moved that client
    // writer onto this same byte shape, so the scene/prefab special case is gone: every JSON
    // duplicate uses `assetJsonBytes`.
    fs.writeFileSync(absTo, assetJsonBytes(json));
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
        writeMetaSidecar(absTo, { id: newGuid });
      }
    } else {
      writeMetaSidecar(absTo, { id: newGuid });
    }
  }
  return newGuid;
}
