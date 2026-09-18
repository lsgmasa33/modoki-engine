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
import { durableGuid, deriveMemberGuid, remapGuidValues } from '../packages/modoki/src/runtime/core/assetRefRules';
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

/** Reads a prefab document by its asset guid; `null`/`undefined` when it cannot. */
export type PrefabReader = (prefabGuid: string) => unknown;

/** Bounds on `derivedMemberPaths`, which mirrors the loader exactly — including the shapes the loader
 *  itself recurses on forever (a prefab whose file adds a reference that leads back to it). Predicting
 *  WHICH shapes those are took two wrong structural rules (#1324 review), so the walk does not try: it
 *  stops on size. A walk past either bound describes an entity tree no scene could load, and maps
 *  nothing (a ref into it is left as it was). Plain added levels are finite JSON and do not count
 *  toward the depth; no committed prefab nests an instance past 1 level. */
const MAX_INSTANCE_DEPTH = 64;
const MAX_MEMBER_PATHS = 100_000;
class MemberWalkTooLarge extends Error {}

/** The fields of a scene row or an `added[]` node that decide which members derive under it. */
type AddedNode = { guid?: unknown; prefab?: unknown; added?: unknown; children?: unknown };
type PrefabRow = { localId?: number; prefab?: string; added?: unknown; traits?: { EntityAttributes?: { parentId?: number } } };
type PrefabDoc = { rootLocalId?: number; entities?: PrefabRow[] };

/** Which anchor a derived path hangs off. `self`: the walked node's own guid. `parent`: the guid the
 *  walked node's PARENT derives from — where the loader puts a prefab row whose parent is zero or
 *  unknown, and a guid-less instance root (#1339). `skip`: a path owned by a different walk (a
 *  nested anchor's members, seen from its outer instance), or one no reload can address. */
type AnchorTag = 'self' | 'parent' | 'skip';
/** `path` is the steps below the last anchor; `done` the finished segments before it — one per
 *  guid-less stored root on the way down, each of which derives its own guid and anchors the next
 *  segment (#1349). */
type Base = { tag: AnchorTag; done: number[][]; path: number[] };

/** Every `path` (`deriveInstanceMemberGuids`'s step chain, dot-joined; `|` between segments, see
 *  {@link deriveMemberChain}) a member can derive at below
 *  `node` — a scene instance root or an `added[]` node that carries its own guid — grouped by the
 *  anchor it derives from. Mirrors the loader's parenting, not the prefab's intent:
 *  - a prefab row steps by its `localId` (a nested row too: its root's `parentLocalId` is that
 *    row's localId), a user-added nested instance's root by its prefab's root localId
 *    (`parentLocalId` stays 0), and a plain added node by 0 (it has no `PrefabInstance`);
 *  - a row whose `parentId` is 0, missing, or names no spawned row is parented by
 *    `instantiatePrefabIntoWorld` to the CALLER's parent: the scene parent for a top-level instance
 *    (→ `parent`), the anchor member for a user-added nested instance, and nothing for a nested
 *    prefab ROW, which is expanded under 0 and so is unaddressable;
 *  - an `added` node whose anchor is unknown re-anchors to the root, as `applyStructureCore` does;
 *  - `guidLess`: the node itself carries no guid, so its root derives too (`[rootLocalId]`, `parent`);
 *  - a guid-less instance ROOT the save stores (that `guidLess` root, or a guid-less user-added
 *    nested instance) derives its own guid and then ANCHORS its members, so their paths start a new
 *    segment after it, as the loader does (#1349).
 *  A descendant that stores its own guid is its own anchor: its members are `skip` here and are
 *  enumerated by its own walk, but its orphan rows hang off THIS walk's anchors.
 *
 *  Over-generating is harmless — the caller maps a derived guid only where the document holds it —
 *  so removed members need no special case. */
export function derivedMemberPathsByAnchor(
  node: AddedNode, readPrefab: PrefabReader, opts: { guidLess?: boolean; orphans?: 'parent' | 'skip' } = {},
): { self: string[]; parent: string[] } {
  const out = { self: new Set<string>(), parent: new Set<string>() };
  let size = 0;
  const emit = (b: Base): void => {
    if (b.tag === 'skip' || !b.path.length) return;
    const set = out[b.tag];
    const key = [...b.done, b.path].map((seg) => seg.join('.')).join('|');
    if (set.has(key)) return;
    set.add(key);
    if (++size > MAX_MEMBER_PATHS) throw new MemberWalkTooLarge();
  };
  const under = (b: Base, ...steps: number[]): Base => ({ tag: b.tag, done: b.done, path: [...b.path, ...steps] });
  /** The base a derived stored root at `b` gives its members: its own guid is the next anchor. */
  const anchoredAt = (b: Base): Base => ({ tag: b.tag, done: [...b.done, b.path], path: [] });
  const SKIP: Base = { tag: 'skip', done: [], path: [] };
  const docOf = (guid: unknown): PrefabDoc | null => {
    if (typeof guid !== 'string' || !guid) return null;
    const d = readPrefab(guid);
    return d && typeof d === 'object' && Array.isArray((d as PrefabDoc).entities) ? d as PrefabDoc : null;
  };

  /** Members of `doc` below its root (the root sits at `root`), plus `added` applied to that
   *  instance; a row with no spawned parent hangs at `orphan`. `stack` is the loader's nested-ROW
   *  guard (`instantiatePrefabIntoWorld`'s `_stack`), which a reference node restarts
   *  (`spawnNestedInstance` passes none). */
  const expand = (doc: PrefabDoc, root: Base, orphan: Base, added: unknown, stack: string[], depth: number): void => {
    if (depth > MAX_INSTANCE_DEPTH) throw new MemberWalkTooLarge();
    const rootLocalId = doc.rootLocalId ?? 1;
    // The rows the loader actually spawns and maps: a nested row only when its prefab resolves.
    const rows = new Map<number, PrefabRow>();
    for (const r of doc.entities ?? []) {
      if (!r || typeof r.localId !== 'number' || !r.localId) continue;
      if (r.prefab && (!docOf(r.prefab) || stack.includes(r.prefab))) continue;
      rows.set(r.localId, r);
    }
    const parentOf = (r: PrefabRow): number => r.traits?.EntityAttributes?.parentId ?? 0;
    // Where `localId` sits; `null` for a parent cycle, which the loader leaves detached. A localId
    // that is not a row is the root — the re-anchoring an `added` node gets.
    const baseOf = (localId: number): Base | null => {
      if (localId === rootLocalId || !rows.has(localId)) return root;
      const chain: number[] = [];
      const seen = new Set<number>();
      let cur = localId;
      for (;;) {
        if (seen.has(cur)) return null;
        seen.add(cur);
        chain.unshift(cur);
        const p = parentOf(rows.get(cur)!);
        if (p === rootLocalId) return under(root, ...chain);
        if (!p || !rows.has(p)) return under(orphan, ...chain);
        cur = p;
      }
    };
    for (const [localId, row] of rows) {
      const here = baseOf(localId);
      if (!here) continue;
      if (localId !== rootLocalId) emit(here);
      if (row.prefab) {
        // A nested row expands under parent 0, so ITS orphans are unaddressable.
        expand(docOf(row.prefab)!, here, SKIP, row.added, [...stack, row.prefab], depth + 1);
      }
    }
    if (Array.isArray(added)) {
      for (const n of added as (AddedNode & { parentLocalId?: number })[]) {
        if (!n || typeof n !== 'object') continue;
        const b = baseOf(n.parentLocalId ?? rootLocalId);
        if (b) addedNode(n, b, depth);
      }
    }
  };

  /** One `added[]` node hanging at `base`. */
  const addedNode = (n: AddedNode, base: Base, depth: number): void => {
    const ownGuid = durableGuid(typeof n.guid === 'string' ? n.guid : '');
    if (n.prefab) {
      const child = docOf(n.prefab);
      if (!child) return;
      // With its own guid it is its own anchor: its root and members belong to its own walk. Its
      // orphan rows do not — `spawnNestedInstance` parents them to `base`, which is ours.
      const here = ownGuid ? SKIP : under(base, child.rootLocalId ?? 1);
      emit(here);
      // A FRESH row chain, as `spawnNestedInstance` gives it (#1324 review). Guid-less, the root
      // still anchors its members on the guid it derives (#1349).
      expand(child, ownGuid ? SKIP : anchoredAt(here), base, n.added, [n.prefab as string], depth + 1);
      return;
    }
    // A plain node with its own guid anchors everything below it (its own walk).
    if (ownGuid) return;
    const here = under(base, 0);
    if (Array.isArray(n.children)) for (const c of n.children as AddedNode[]) if (c && typeof c === 'object') addedNode(c, here, depth);
  };

  try {
    if (node.prefab) {
      const doc = docOf(node.prefab);
      if (doc) {
        const orphan: Base = { tag: opts.orphans ?? 'skip', done: [], path: [] };
        const root: Base = opts.guidLess ? under(orphan, doc.rootLocalId ?? 1) : { tag: 'self', done: [], path: [] };
        emit(root);
        expand(doc, opts.guidLess ? anchoredAt(root) : root, orphan, node.added, [node.prefab as string], 0);
      }
    } else if (Array.isArray(node.children)) {
      // A plain added node anchors any guid-less nested instance added beneath it.
      for (const c of node.children as AddedNode[]) if (c && typeof c === 'object') addedNode(c, { tag: 'self', done: [], path: [] }, 0);
    }
  } catch (e) {
    if (e instanceof MemberWalkTooLarge) return { self: [], parent: [] };
    throw e;
  }
  return { self: [...out.self], parent: [...out.parent] };
}

/** The guid a member at `key` (a {@link derivedMemberPathsByAnchor} path) derives from `anchor`:
 *  one `deriveMemberGuid` per `|`-separated segment, each result anchoring the next. */
export function deriveMemberChain(anchor: string, key: string): string {
  return key.split('|').reduce((a, seg) => deriveMemberGuid(a, seg.split('.').map(Number)), anchor);
}

/** The member paths that derive from `node`'s own guid — {@link derivedMemberPathsByAnchor}'s `self`. */
export function derivedMemberPaths(node: AddedNode, readPrefab: PrefabReader): string[] {
  return derivedMemberPathsByAnchor(node, readPrefab).self;
}

/** A top-level scene entry's field shape, as far as its parent chain is concerned. */
type SceneEntry = AddedNode & { id?: unknown; traits?: { EntityAttributes?: { guid?: unknown; parentId?: unknown } } };

/** The guid a top-level scene entry's PARENT position derives from, and the steps from just below
 *  that anchor down to the parent — `null` when no reload can be relied on to address it. Mirrors
 *  `resolveParentRef` (a guid names an entry, a positive number an entry id, anything else the
 *  root). Only a parent with a durable guid is followed:
 *  - a guid-less INSTANCE parent can only be named by its numeric entry id. Since #1353 the loader
 *    parents the child to the re-instantiated root, and that root derives a guid from ITS scene
 *    parent (`deriveInstanceMemberGuids`), so a chain below a durable parent could be followed.
 *    Not following it is a conservative choice for legacy, never-re-saved files, not a necessity;
 *  - a guid-less PLAIN parent gets a guid seeded from the scene PATH (`deriveAuthoredEntityGuids`),
 *    which a copy at another path does not share.
 *  Either way nothing below it can be predicted, so its refs are left as they were. */
function sceneAnchorOf(entry: SceneEntry, entries: SceneEntry[]): string | null {
  const ownGuid = (e: SceneEntry): string => durableGuid(String((e.prefab ? e.guid : e.traits?.EntityAttributes?.guid) ?? ''));
  const raw = entry.traits?.EntityAttributes?.parentId;
  const parent = typeof raw === 'string'
    ? (raw ? entries.find((x) => ownGuid(x) === raw) : undefined)
    : typeof raw === 'number' && raw > 0 ? entries.find((x) => x.id === raw) : undefined;
  return parent ? ownGuid(parent) || null : null;
}

/** Give every entity a scene file DEFINES a fresh guid, and carry every reference to it along
 *  (#1293). The file-level counterpart of `regenerateSnapshotGuids`, which mints fresh guids for a
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
 *  **Prefab MEMBERS follow too (#1324), given `readPrefab`.** A member's guid is not stored —
 *  `deriveInstanceMemberGuids` derives it on load as `deriveMemberGuid(anchor, path)` — so the members
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
 *  its original by guid, so `filterPersistentDuplicates` stops treating the two as one. */
export function remintSceneEntityGuids(
  scene: Record<string, unknown>,
  genGuid: () => string = randomUUID,
  readPrefab?: PrefabReader,
): Record<string, unknown> {
  const remap = new Map<string, string>();
  const define = (g: unknown): void => {
    // durableGuid: a stale RUNTIME guid (#1210) is no identity — the loader derives a distinct one
    // per row. Minting one durable guid for it would turn two such rows into a same-file collision.
    const d = typeof g === 'string' ? durableGuid(g) : '';
    if (d && !remap.has(d)) remap.set(d, genGuid());
  };
  type Row = AddedNode & { traits?: { EntityAttributes?: { guid?: unknown } } };
  // Each nested anchor this file defines (an `added[]` node or a legacy `children` row with its own
  // guid), with the node its derived members hang off. Top-level entries are walked separately.
  const anchors: [string, AddedNode][] = [];
  const visit = (rows: unknown, topLevel: boolean): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows as Row[]) {
      if (!row || typeof row !== 'object') continue;
      define(row.guid);
      define(row.traits?.EntityAttributes?.guid);
      const anchor = durableGuid(typeof row.guid === 'string' ? row.guid : '');
      if (anchor && !topLevel) anchors.push([anchor, row]);
      visit(row.children, false);
      visit(row.added, false);
      // A `nestedStructure` slot — on an entry (#1358) or on a reference node (#1369) — holds added
      // nodes with their own guids too; missed here, the copy kept them and two files shared them.
      const slot = (row as { nestedStructure?: unknown }).nestedStructure;
      if (slot && typeof slot === 'object') {
        for (const delta of Object.values(slot as Record<string, { added?: unknown } | null>)) visit(delta?.added, false);
      }
    }
  };
  visit(scene.entities, true);
  if (remap.size === 0) return scene;
  if (readPrefab) {
    const memberRemap = new Map<string, string>();
    const carry = (oldAnchor: string, paths: string[]): void => {
      const newAnchor = remap.get(oldAnchor);
      if (!newAnchor) return;
      for (const p of paths) memberRemap.set(deriveMemberChain(oldAnchor, p), deriveMemberChain(newAnchor, p));
    };
    for (const [anchor, node] of anchors) carry(anchor, derivedMemberPaths(node, readPrefab));
    // A top-level instance's members derive from its own guid — and, for a row the loader parents to
    // the SCENE parent or for a guid-less (pre-#1248) root, from that parent's anchor (#1339).
    const entries = (Array.isArray(scene.entities) ? scene.entities : []).filter((e): e is Row => !!e && typeof e === 'object');
    for (const entry of entries) {
      if (!entry.prefab && !Array.isArray(entry.children)) continue;
      const ownGuid = durableGuid(typeof entry.guid === 'string' ? entry.guid : '');
      const byAnchor = derivedMemberPathsByAnchor(entry, readPrefab, { guidLess: !!entry.prefab && !ownGuid, orphans: 'parent' });
      if (ownGuid) carry(ownGuid, byAnchor.self);
      if (!byAnchor.parent.length) continue;
      const up = sceneAnchorOf(entry, entries);
      if (up) carry(up, byAnchor.parent);
    }
    // A defined guid wins over a derived one — the two cannot coincide, but a stored identity is
    // the one thing this function must never re-point.
    for (const [k, v] of memberRemap) if (!remap.has(k)) remap.set(k, v);
  }
  return remapGuidValues(scene, remap) as Record<string, unknown>;
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
  readPrefab?: PrefabReader,
): string | null {
  const destDir = path.dirname(absTo);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const newGuid = genGuid();
  const ext = path.extname(absFrom).toLowerCase();
  if (ext === '.json') {
    // JSON asset: copy + rewrite top-level id
    // A UTF-8 BOM makes JSON.parse throw, and the verbatim fallback below then leaves the copy with
    // the ORIGINAL's asset id — two assets claiming one guid (#1293 review). Parse past it.
    const txt = fs.readFileSync(absFrom, 'utf-8').replace(/^\uFEFF/, '');
    let json: Record<string, unknown>;
    try { json = JSON.parse(txt); } catch { fs.copyFileSync(absFrom, absTo); return null; }
    json.id = newGuid;
    if (absFrom.toLowerCase().endsWith('.scene.json')) json = remintSceneEntityGuids(json, genGuid, readPrefab);
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
