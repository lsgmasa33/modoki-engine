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
import { writeMetaSidecar, copiedSidecarIdentity, CORRUPT_SIDECAR_SUFFIX } from './meta-sidecar';
import { durableGuid, memberRowNodes, remapGuidValues } from '../packages/modoki/src/runtime/core/assetRefRules';
import {
  derivedMemberPathsByAnchor, deriveMemberChain, derivedMemberPaths, sceneMemberAnchors, MAX_INSTANCE_DEPTH, type PrefabReader,
} from '../packages/modoki/src/runtime/loaders/memberPaths';
export { derivedMemberPathsByAnchor, deriveMemberChain, derivedMemberPaths, type PrefabReader };
// The ONE subtree pre-flight (#883/#990/#989/#1004) — see engine/scripts/deleteBoundary.mjs. Used
// only by the Linux `rmSync` fallback in `moveToTrash`; the darwin/win32 paths hand the delete to
// the OS trash, which moves rather than unlinks and so cannot orphan a link's payload.
import { findDeleteBoundaries } from '../scripts/deleteBoundary.mjs';
import { classifyJsonAssetPath, ID_BEARING_TYPES } from './assetTypes';
import { parseJsonText, readJsonFile } from '../scripts/jsonFile.mjs'; // #1799: a BOM is read through
import { assertSceneFormatReadable, unparsableSceneError } from '../packages/modoki/src/runtime/loaders/sceneFormatGate';

/** The sidecars an asset carries, as SUFFIXES. Spelled once: `moveAssetFile` renames them and
 *  `moveToTrash`'s refusal predicate must hold them back, and a second hand-kept copy of the list
 *  is how one of them gets stranded. (`sidecarsFor` in `editor/panels/assetOps.ts` is the editor's
 *  own copy — it lists only two, and the mismatch is noted there.) */
export const SIDECAR_SUFFIXES: readonly string[] = ['.meta.json', '.meta.local.json', '.meta.json' + CORRUPT_SIDECAR_SUFFIX];

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
  //
  // ⚠️ ALL OR NOTHING (#1958): a sidecar rename that throws (a Windows lock is the plausible one) used to leave the asset
  // at its new path and its `.meta.json` at the old one, and the next scan minted the moved asset a fresh GUID, so
  // every ref to it dangled. So a failure puts back what this call already moved, newest first, and rethrows: the
  // route's error then means what it says, that nothing moved. A rollback step that fails too is left as it is; the
  // original error is the one worth reporting.
  const moved: Array<[string, string]> = [[absFrom, absTo]];
  try {
    for (const suffix of SIDECAR_SUFFIXES) {
      const metaFrom = absFrom + suffix;
      if (!fs.existsSync(metaFrom)) continue;
      fs.renameSync(metaFrom, absTo + suffix);
      moved.push([metaFrom, absTo + suffix]);
    }
  } catch (e) {
    for (const [from, to] of moved.reverse()) { try { fs.renameSync(to, from); } catch { /* keep the original error */ } }
    throw e;
  }
}

/** **A sidecar's identity belongs to exactly one live file.** This is the CREATE half (#1975). The COPY half is
 *  `freshSidecarIdentity` (#1974), and the DELETE half is `/api/delete-asset` taking a file's sidecars with it (#1956).
 *
 *  A file's GUID, import settings and slices live in its `.meta.json`. When the file is deleted outside the editor
 *  (Finder, Explorer, a git checkout), the sidecar stays behind. Without this, the next file created at that path
 *  silently INHERITS the dead asset's GUID, settings and slices, and every ref to the deleted asset shows the new one.
 *  Unity "deletes the old 'orphaned' .meta file" and mints a new GUID in the same case.
 *
 *  So a route about to create a file where NONE exists calls this first, and it removes every sidecar at that path.
 *  Removed outright (Unity's rule), not trashed: what an orphan holds is a dead asset's identity, and handing it to a
 *  new file is the defect. A path where a file DOES exist is left alone: that file owns its sidecars, and `existsSync`
 *  folds case where the disk does, so `Hero.png` keeps its sidecar from a request for `hero.png`.
 *
 *  ⚠️ Deliberately NOT a sweep at rescan time: a move done in Finder renames the file and its sidecar as two separate
 *  events, and a rescan between them would delete a LIVE asset's identity. Only a create, which is about to put a new
 *  file at that exact path, can tell an orphan from a sidecar whose file is still on its way.
 *
 *  Synchronous, so a caller can keep its check-then-write span free of awaits. Returns the paths it removed.
 *
 *  ⚠️ `keep` names a sidecar that is NOT an orphan although its file is absent: one written AHEAD of its file (#1992).
 *  The Assets panel's OS drop writes each dropped file in drop order, sidecars included, so a `.meta.json` dropped before
 *  its png sat at the path when the png was created, and this deleted the GUID, settings and slices just dropped. The
 *  router answers it from what it wrote itself (`sidecarWrittenAheadOfFile`), since only the writer knows. */
export function removeOrphanSidecars(absTarget: string, keep: (sidecarAbs: string) => boolean = () => false): string[] {
  if (fs.existsSync(absTarget)) return [];
  const removed: string[] = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const side = absTarget + suffix;
    if (!fs.existsSync(side) || keep(side)) continue;
    fs.rmSync(side, { force: true });
    removed.push(side);
  }
  return removed;
}

/** A copied binary's sidecar: every GUID the sidecar DEFINES, re-minted. This is the COPY half of "a sidecar's identity
 *  belongs to exactly one live file" (#1974; the create half is `removeOrphanSidecars`). Which GUIDs those are is
 *  `copiedSidecarIdentity`'s rule, shared with the scan's heal of a copy made outside the editor (#1996). Before #1974
 *  the slices were kept: two textures then defined every slice GUID, and slice refs drew whichever registered last. */
export function freshSidecarIdentity(meta: Record<string, unknown>, id: string, genGuid: () => string): Record<string, unknown> {
  return copiedSidecarIdentity(meta, id, genGuid).meta;
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
      if (/[\r\n\t]/.test(p)) {
        // A newline would split one path into two lines and delete something else, and a tab would split a line into a
        // path and a group base (see `trashGroups`). Windows does not permit control characters in a filename, so this
        // is unreachable in practice — it is here because the line protocol's failure mode is a WRONG delete.
        throw new Error(`trashCommand: path contains a newline or tab, refusing to build a delete for it: ${JSON.stringify(p)}`);
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
        // ⚠️ A GROUP is never split (#1977): a line `<sidecar>\t<its file>` is held back, and reported, when its file was
        // refused earlier in this run. win32 recycles per path, so without this a locked file kept its place on disk
        // while its `.meta.json` went to the bin, and the route's own rebuild minted the file a new GUID. `trashGroups`
        // orders every file before its sidecars. `$bad` is a PowerShell hashtable, whose keys compare ignoring case, as
        // NTFS does.
        + '$failed = 0; $bad = @{}; '
        + 'foreach ($line in ([Console]::In.ReadToEnd() -split "`n")) { '
        + '$line = $line.TrimEnd("`r"); if ($line -eq \'\') { continue } '
        + '$parts = $line -split "`t", 2; $p = $parts[0]; '
        + 'if ($parts.Count -gt 1 -and $bad.ContainsKey($parts[1])) '
        + "{ $failed++; [Console]::Error.WriteLine('modoki-trash: FAILED ' + $p + ' :: its file was not trashed, so it stays with it'); continue } "
        + 'try { '
        + 'if (Test-Path -LiteralPath $p -PathType Container) '
        + "{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } "
        + "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } "
        + "} catch { $failed++; $bad[$p] = $true; [Console]::Error.WriteLine('modoki-trash: FAILED ' + $p + ' :: ' + $_.Exception.Message) } } "
        + 'if ($failed -gt 0) { exit $failed }',
      ],
      input: `${trashGroups(paths).map((g) => (g.base === undefined ? g.path : `${g.path}\t${g.base}`)).join('\n')}\n`,
    };
  }
  // Linux + anything else: the `trash-cli` tool (commonly present on desktops)
  // takes a list of paths in a single invocation.
  return { command: 'trash-put', args: [...paths] };
}

/** The win32 trash's line order and grouping (#1977): each path, with `base` set when it is a sidecar (`SIDECAR_SUFFIXES`)
 *  of a file in the SAME batch. Every path without a base comes first, in request order, then the sidecars, so the
 *  script has already tried a sidecar's file when it reaches the sidecar. A sidecar whose file is not in the batch (the
 *  route sends an orphan's sidecar alone, its file already gone) has no base and is trashed on its own, as before.
 *  Matched by exact string: the route spells a sidecar as its file's path plus the suffix. Pure, so it is unit-tested. */
export function trashGroups(paths: readonly string[]): Array<{ path: string; base?: string }> {
  const inBatch = new Set(paths);
  const lines = paths.map((p) => {
    const suffix = SIDECAR_SUFFIXES.find((s) => p.endsWith(s));
    const base = suffix === undefined ? undefined : p.slice(0, -suffix.length);
    return base !== undefined && inBatch.has(base) ? { path: p, base } : { path: p };
  });
  return [...lines.filter((l) => l.base === undefined), ...lines.filter((l) => l.base !== undefined)];
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
   *  — see `moveToTrash`'s fallback for why splitting it is worse than the bug it guards. That holds on every platform:
   *  darwin's Finder delete is all-or-nothing (measured), the Linux fallback holds them back, and the win32 script holds
   *  back a sidecar whose file it could not recycle (`trashGroups`, #1977). */
  failed: string[];
  /** What the OS said, when it refused something and said anything (darwin: Finder's AppleScript
   *  error). A short first line, for the refusal's prose — never a path list; `failed` is that. */
  reason?: string;
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
  if (platform === 'darwin') {
    // #1212 A-8: Finder's `delete` names no path when it refuses (a locked file, a denied volume,
    // Finder not answering), so the exec rethrew and the route answered 500 → "relaunch the editor"
    // about a file that was simply locked, with `failed` — which the tool documents — never set.
    // The DISK is the witness instead: whatever is still there did not go. `lstat`, not `exists`,
    // because a dangling symlink is still an entry Finder failed to move.
    try {
      return (exec(command, args, input) as TrashExecResult | undefined) ?? { failed: [] };
    } catch (e) {
      const said = String((e as { stderr?: unknown })?.stderr ?? '').trim() || (e instanceof Error ? e.message : String(e));
      // -1712 is the AppleEvent TIMEOUT: osascript gave up while Finder may still be moving the
      // files, so "still on disk" is not yet an answer. Could-not-tell stays a thrown failure.
      if (/\(-1712\)/.test(said)) throw e;
      // Measured on macOS 26 (2026-09-17, a locked file via `chflags uchg`): Finder's `delete` of a
      // list is ALL-OR-NOTHING — one refused item and NOTHING moves, in either list order — so an
      // asset and its sidecar are not split by this path.
      const stillThere = paths.filter((p) => { try { fs.lstatSync(p); return true; } catch { return false; } });
      // Everything went despite the error exit — the delete happened, and saying otherwise would
      // send the caller to retry a delete of files that are already in the Trash.
      if (stillThere.length === 0) return { failed: [] };
      return { failed: stillThere, reason: said.split('\n')[0].slice(0, 300) };
    }
  }
  if (platform === 'win32') {
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

/** Give every entity a scene file DEFINES a fresh guid, and carry every reference to it along
 *  (#1293). The file-level counterpart of `copySnapshot`, which mints fresh guids for a
 *  subtree duplicated inside one scene and carries the refs inside it the same way (#1338). A
 *  copied scene is its own content, so it gets its own identities.
 *
 *  **What "defines" means — three places, not one.** An ordinary row keeps its guid in
 *  `traits.EntityAttributes.guid`, but a prefab-instance ROOT keeps it on the row itself
 *  (`entry.guid`), and an instance's structural adds keep theirs on each `added[]` node (recursing
 *  through `children` and a nested reference node's `added`). Collecting only the first is what
 *  the scaffolder does, and on a scene with instances it would leave every root shared.
 *
 *  **What follows the remap: every string VALUE equal to a defined guid**, wherever it sits —
 *  `parentId`, `PrefabInstance.rootInstanceId`, every registry `entityRef` field (including a
 *  game's own) and `UIAction.bindings[].target`. A walk rather than a field list, so a newly
 *  registered entityRef field is covered with nothing to keep in sync; the scaffolder's whole-text
 *  substitution is the same idea (`remapGuidValues`). Every committed entity guid is a UUID, so an exact-value match
 *  cannot hit a name.
 *
 *  **What deliberately does NOT follow:** a guid the file references but does not define — a
 *  level's ref into its BASE scene keeps pointing at the base. Override keys are localIds, never
 *  guids.
 *
 *  **Prefab MEMBERS follow too (#1324), given `readPrefab`.** Before scene v16 a member's guid was not
 *  stored at all — `deriveInstanceMemberGuids` derives it on load as `deriveMemberGuid(anchor, path)` — so the members
 *  re-derive from the new anchor on their own, but a stored REFERENCE to one (a `UIAction` target,
 *  an `entityRef` into an instance) would keep the old anchor's value and dangle. So for every
 *  reminted anchor the member paths are enumerated from its prefab file(s) (`derivedMemberPaths`)
 *  and `old|p` → `new|p` joins the remap. The anchor is the one the LOADER picks, which is not
 *  always the instance root (#1339): a prefab row with a zero or unknown parent hangs off the
 *  instance's scene parent, and a guid-less (pre-#1248) root derives from that parent too —
 *  `sceneAnchorOf` finds it. Without `readPrefab`, for a prefab it cannot read, or under a parent
 *  without a durable guid (see `sceneAnchorOf`), those refs are left as before. See
 *  docs/scene-loading.md.
 *
 *  ⚠️ **Accepted cost (owner ruling, #1293):** a `Persistent` entity in the copy no longer matches
 *  its original by guid. (Nothing deduplicates a carried Persistent root against a file since #1863, so
 *  the guid no longer decides anything there.)
 *
 *  ⚠️ **Refuses a scene this build cannot read** (`assertSceneFormatReadable` throws
 *  `SceneFormatRefusedError`, before anything is minted). The walk below knows where THIS build's
 *  format defines a guid, and nowhere else: on a too-new file it re-minted the places it knew and
 *  left the rest, so the copy was half-rewritten and still shared those entities with its original;
 *  on a too-old or versionless one it rewrote shapes the loader will refuse anyway. Unity's line —
 *  never re-mint what you cannot read. */
export function remintSceneEntityGuids(
  scene: Record<string, unknown>,
  genGuid: () => string = randomUUID,
  readPrefab?: PrefabReader,
): Record<string, unknown> {
  assertSceneFormatReadable(scene);
  const remap = new Map<string, string>();
  const define = (g: unknown): void => {
    // durableGuid: a stale RUNTIME guid (#1210) is no identity — the loader derives a distinct one
    // per row. Minting one durable guid for it would turn two such rows into a same-file collision.
    const d = typeof g === 'string' ? durableGuid(g) : '';
    if (d && !remap.has(d)) remap.set(d, genGuid());
  };
  type Row = { guid?: unknown; added?: unknown; children?: unknown; traits?: { EntityAttributes?: { guid?: unknown } } };
  const visit = (rows: unknown): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows as Row[]) {
      if (!row || typeof row !== 'object') continue;
      define(row.guid);
      define(row.traits?.EntityAttributes?.guid);
      // Every MEMBER ROW's guid (scene v16, #1468) — UNCONDITIONALLY, which is D3/R6. A stored row
      // makes a member's guid something the file states rather than something the copy re-derives,
      // so without this the copy and the original name one entity (#1293).
      //
      // Minting here and letting the carry pass below OVERWRITE it is what makes "unconditionally"
      // true without a classifier. A row whose guid still equals its derivation is re-pointed by the
      // carry to the NEW anchor's derivation, so the row and the fallback agree. A row whose guid has
      // DIVERGED — the template changed after the scene was saved, which is the whole reason rows
      // exist — matches no carry and keeps this fresh mint. Both cases end up unshared and with every
      // reference following; neither asks what the value IS, which is the live-value classifier
      // `planCopyGuids`' docblock rejects (`runtime/core/copyIdentity.ts`).
      //
      // ⚠️ The row's KEY is NOT remapped, and must not be: it is the TEMPLATE's node identity, and
      // both copies legitimately instantiate the same template. `remapGuidValues` rewrites string
      // VALUES only, so this is by construction rather than by a rule someone has to remember.
      const members = (row as { members?: unknown }).members;
      if (members && typeof members === 'object' && !Array.isArray(members)) {
        for (const m of Object.values(members as Record<string, { guid?: unknown; added?: unknown } | null>)) {
          define(m?.guid);
          // A row's `added` (Phase 4) and `own` (v17, #1516) hold scene-authored nodes with their own guids,
          // like `added` below.
          visit(memberRowNodes(m));
        }
      }
      visit(row.children);
      visit(row.added);
      // A `nestedStructure` slot — on an entry (#1358) or on a reference node (#1369) — holds added
      // nodes with their own guids too; missed here, the copy kept them and two files shared them.
      const slot = (row as { nestedStructure?: unknown }).nestedStructure;
      if (slot && typeof slot === 'object') {
        for (const delta of Object.values(slot as Record<string, { added?: unknown } | null>)) visit(delta?.added);
      }
    }
  };
  visit(scene.entities);
  if (remap.size === 0) return scene;
  if (readPrefab) {
    // Every (anchor, member paths) pair: each anchor this file defines, and each top-level instance — whose
    // members derive from its own guid and, for a row the loader parents to the SCENE parent or a guid-less
    // (pre-#1248) root, from that parent's anchor (#1339).
    const carries: [string, string[]][] = [];
    for (const a of sceneMemberAnchors(scene)) {
      const byAnchor = derivedMemberPathsByAnchor(a.node, readPrefab, a.opts);
      if (a.self) carries.push([a.self, byAnchor.self]);
      if (a.parent && byAnchor.parent.length) carries.push([a.parent, byAnchor.parent]);
    }
    // A derived guid wins where a node DEFINES it. The walk emits no path for a node that carries its
    // own guid, so a defined guid meets a derivation only where a save stored the derived one: a
    // template-keyed node in scene form, its key dropped. The load heal restores that key only while
    // the guid still matches its derivation, so a random remint left the copy's node unkeyed for good
    // (#1430). Such a node can itself be an ANCHOR (a keyed reference node, or a keyed plain node the
    // scene hung a reference under), and re-pointing it moves every member below it — so carry until
    // nothing moves, each pass against the anchors' guids as the last one left them. A pass settles at
    // least one more level of that nesting; the bound only stops a pathological file.
    // The OLD side of every carry never changes between passes — derive it once.
    const froms = carries.map(([oldAnchor, paths]) => paths.map((p) => deriveMemberChain(oldAnchor, p)));
    for (let pass = 0; pass <= MAX_INSTANCE_DEPTH; pass++) {
      const next = new Map<string, string>();
      carries.forEach(([oldAnchor, paths], i) => {
        const newAnchor = remap.get(oldAnchor);
        if (newAnchor) paths.forEach((p, j) => next.set(froms[i]![j]!, deriveMemberChain(newAnchor, p)));
      });
      let moved = false;
      for (const [k, v] of next) if (remap.get(k) !== v) { remap.set(k, v); moved = true; }
      if (!moved) break;
    }
  }
  return remapGuidValues(scene, remap) as Record<string, unknown>;
}

/** A JSON asset's document with its own identity replaced: `id` set to `guid`, and for a scene every entity guid
 *  reminted too (`remintSceneEntityGuids`). Null when `text` is not a JSON object — the caller then copies verbatim.
 *
 *  THE way a copy of a JSON asset gets an identity of its own — Duplicate (`duplicateAssetFile`) and both imports on a
 *  collision (`importedAssetBytes`) go through it, so a copy is never born sharing its original's guid by one path and not
 *  another. (`/api/scene-save-as` stamps the same identity on a serialized scene that never was a file.)
 *
 *  A UTF-8 BOM makes JSON.parse throw, and the verbatim fallback then leaves the copy with the ORIGINAL's asset id —
 *  two assets claiming one guid (#1293 review). Parsed past it.
 *
 *  ⚠️ **A scene gets no verbatim fallback: one this build cannot read THROWS `SceneFormatRefusedError`** — unparsable
 *  here, too new / too old / versionless / a non-object in `remintSceneEntityGuids`. Copied verbatim, a merge-conflicted
 *  scene kept its original's asset id and every entity guid; there is no identity of its own to give a file nobody can
 *  parse, so the copy is refused instead. (A non-scene JSON asset keeps the fallback.) */
export function withFreshJsonIdentity(
  text: string,
  guid: string,
  isScene: boolean,
  genGuid: () => string = randomUUID,
  readPrefab?: PrefabReader,
): Record<string, unknown> | null {
  let json: unknown;
  try { json = parseJsonText(text); } catch (e) {
    if (isScene) throw unparsableSceneError(e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    // A non-object scene is refused `unreadable` (not-an-object) HERE: the reminter never sees it, and the verbatim
    // fallback is the shared-identity copy this refusal exists to prevent. Every version verdict is the reminter's.
    if (isScene) assertSceneFormatReadable(json);
    return null;
  }
  const doc = { ...(json as Record<string, unknown>), id: guid };
  return isScene ? remintSceneEntityGuids(doc, genGuid, readPrefab) : doc;
}

/** Whether an import at `destUrl` decides the file's identity (`importedAssetBytes`), i.e. whether its bytes need
 *  reading at all: the scanner's own classification, and only the kinds whose guid lives IN the file
 *  (`ID_BEARING_TYPES`) — a `.layout.json` carries none, a plain `.json` the scanner indexes as nothing is no asset,
 *  and a binary's guid is in a sidecar the scan mints. */
export function importDecidesIdentity(destUrl: string): boolean {
  const type = classifyJsonAssetPath(destUrl);
  return !!type && ID_BEARING_TYPES.has(type);
}

/** The bytes an import writes to `destUrl` (#1713). **A JSON asset keeps its own id unless the project already has an
 *  asset under it** (owner ruling, 2026-09-28: copy Unity — an asset moved between projects with its GUID keeps every
 *  ref to it); only on a collision does it get a fresh one, with a scene's entity guids reminted too
 *  (`withFreshJsonIdentity`, as Duplicate does). A file with no id gets one. `guidTaken` answers whether the project
 *  already has an asset under a guid.
 *
 *  ⚠️ Decided HERE, before the bytes reach disk, never left to the scanner: a colliding copy written as it came meets
 *  the scanner's heal, which keeps the id for whichever path sorts FIRST — re-minting the ORIGINAL when the import
 *  sorts first, and re-pointing every ref to it at the import.
 *
 *  Anything else — a binary (the scan mints its sidecar), a JSON file the scanner types as no asset or as a kind whose
 *  guid is not in the file, JSON that does not parse — is written exactly as it came. Except a SCENE this build cannot
 *  read, whenever the import would re-mint it or cannot tell whether it must (unparsable): that throws
 *  `SceneFormatRefusedError`. A readable-id scene that collides with nothing is kept as it came, whatever its version. Returns the guid it stamped,
 *  when it stamped one, and `id`: the id the written file carries, kept or stamped (absent when it decided nothing). */
export function importedAssetBytes(
  bytes: Buffer,
  destUrl: string,
  opts: { guidTaken: (guid: string) => boolean; genGuid?: () => string; readPrefab?: PrefabReader },
): { bytes: Buffer; guid?: string; id?: string } {
  if (!importDecidesIdentity(destUrl)) return { bytes };
  const type = classifyJsonAssetPath(destUrl);
  const { guidTaken, genGuid = randomUUID, readPrefab } = opts;
  const text = bytes.toString('utf-8');
  let own: unknown;
  try { own = (parseJsonText(text) as { id?: unknown } | null)?.id; } catch (e) {
    // An unparsable SCENE is refused, not written as it came: whether it collides cannot be decided, and a
    // merge-conflicted copy of a project scene lands under the original's asset id and entity guids — the copy
    // `withFreshJsonIdentity` refuses for Duplicate. Any other kind keeps the as-it-came write.
    if (type === 'scene') throw unparsableSceneError(e instanceof Error ? e.message : String(e));
    return { bytes };
  }
  if (typeof own === 'string' && own && !guidTaken(own)) return { bytes, id: own };
  const guid = genGuid();
  const json = withFreshJsonIdentity(text, guid, type === 'scene', genGuid, readPrefab);
  return json ? { bytes: assetJsonBytes(json), guid, id: guid } : { bytes };
}

/** Copy an asset to a new path with a freshly-generated GUID so the duplicate
 *  doesn't collide with the original in the manifest. JSON assets carry their
 *  id inline (rewritten); binary assets get a copied `.meta.json` sidecar with
 *  the new id and the parent's `generated` list stripped. `genGuid` is
 *  injectable so tests can assert deterministically.
 *
 *  Returns the new GUID, or `null` when the source is JSON that failed to parse
 *  (copied verbatim — the original endpoint's fallback). Throws `SceneFormatRefusedError`, writing
 *  nothing, for a scene this build cannot read (`withFreshJsonIdentity`). */
export function duplicateAssetFile(
  absFrom: string,
  absTo: string,
  genGuid: () => string = randomUUID,
  readPrefab?: PrefabReader,
): string | null {
  const newGuid = genGuid();
  const ext = path.extname(absFrom).toLowerCase();
  // JSON asset: copy + rewrite top-level id (`withFreshJsonIdentity`, shared with import — #1713). Decided BEFORE the
  // destination folder is made: a scene this build cannot read throws here, and a refused copy leaves nothing behind.
  const json = ext === '.json'
    ? withFreshJsonIdentity(fs.readFileSync(absFrom, 'utf-8'), newGuid, absFrom.toLowerCase().endsWith('.scene.json'), genGuid, readPrefab)
    : undefined;
  const destDir = path.dirname(absTo);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  if (ext === '.json') {
    if (!json) { fs.copyFileSync(absFrom, absTo); return null; }
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
        writeMetaSidecar(absTo, freshSidecarIdentity(readJsonFile(metaFrom), newGuid, genGuid));
      } catch {
        writeMetaSidecar(absTo, { id: newGuid });
      }
    } else {
      writeMetaSidecar(absTo, { id: newGuid });
    }
  }
  return newGuid;
}
