/** Unit tests for trashCommand — the pure builder behind /api/delete-asset's
 *  "move to OS trash". Two headline assertions:
 *  - the macOS `as alias` coercion: without it Finder rejects a bare
 *    `POSIX file "<path>"` with -1728 on macOS 26+, which silently broke every
 *    asset delete in the editor.
 *  - BATCHING: one builder call for the whole path list emits a single
 *    invocation, so a multi-file delete plays ONE OS trash sound instead of a
 *    burst of one-chime-per-file. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trashCommand, moveToTrash } from '../../plugins/asset-fs-ops';
import { makeDirLink } from '../helpers/linkFixture';

describe('trashCommand', () => {
  it('macOS: coerces each POSIX path to an alias (the -1728 fix)', () => {
    const { command, args } = trashCommand('/abs/Mars.fbx', 'darwin');
    expect(command).toBe('osascript');
    // The path is always the trailing argv item; the AppleScript body is
    // everything before it.
    expect(args[args.length - 1]).toBe('/abs/Mars.fbx');
    const body = args.slice(0, -1).join('\n');
    // Must coerce to alias — a bare `delete POSIX file …` fails with -1728.
    expect(body).toContain('as alias');
    expect(body).not.toMatch(/delete POSIX file[^\n]*(?<!as alias)$/m);
    // One Finder `delete` for the collected list (so a batch = one trash sound).
    expect(body).toContain('tell application "Finder" to delete theItems');
    // Path goes through argv, never interpolated into the script.
    expect(body).not.toContain('/abs/Mars.fbx');
  });

  it('macOS: batches MANY paths into ONE osascript call (one trash sound)', () => {
    const paths = ['/abs/a.glb', '/abs/a.glb.meta.json', '/abs/b.mesh.json'];
    const { command, args } = trashCommand(paths, 'darwin');
    expect(command).toBe('osascript');
    // Every path is a trailing argv item, in order, after the script body.
    expect(args.slice(-paths.length)).toEqual(paths);
    const body = args.slice(0, -paths.length).join('\n');
    // The body loops over argv and deletes the collected list in ONE Finder call.
    expect(body).toContain('repeat with p in argv');
    expect(body).toContain('as alias');
    expect((body.match(/tell application "Finder" to delete/g) || []).length).toBe(1);
    // No path baked into the script.
    for (const p of paths) expect(body).not.toContain(p);
  });

  it('macOS: passes the path as a trailing argv item even with shell metachars', () => {
    const nasty = '/abs/we;ird "name".fbx';
    const { args } = trashCommand(nasty, 'darwin');
    expect(args[args.length - 1]).toBe(nasty);
    expect(args.slice(0, -1).join('\n')).not.toContain(nasty); // not baked into the AppleScript
  });

  /** ⚠️ This block replaces one that asserted the exact shape #875 turned out to be BROKEN —
   *  it pinned `foreach ($p in $args)` and `args.slice(-2)` as correct. It could not fail,
   *  because it checked the string and never ran PowerShell: `-Command` does not bind `$args`,
   *  so the loop iterated zero times and nothing was ever recycled. The assertions below are
   *  the inverse — they pin what must be ABSENT from argv — and `trashCommandLive.test.ts`
   *  runs the real thing on win32, which is the half no string assertion can cover. */
  it('Windows: paths travel on stdin, NEVER on the command line (#875)', () => {
    const paths = ['C:/x/m.glb', 'C:/x/n.png'];
    const { command, args, input } = trashCommand(paths, 'win32');
    expect(command).toBe('powershell');
    expect(args.join(' ')).toContain('SendToRecycleBin');
    // The defect: trailing argv items are re-parsed as SOURCE by `-Command`, so a path with a
    // space targets the wrong file and a path with `;` executes. No path may reach argv.
    for (const p of paths) for (const a of args) expect(a).not.toContain(p);
    // …and every path must reach the script through stdin instead.
    expect(input).toBe('C:/x/m.glb\nC:/x/n.png\n');
    // `$args` is the broken channel — its absence is what stops the old shape coming back.
    expect(args.join(' ')).not.toContain('$args');
    // A directory needs DeleteDirectory; DeleteFile throws "Could not find file" on one.
    expect(args.join(' ')).toContain('DeleteDirectory');
    expect(args.join(' ')).toContain('DeleteFile');
    // Non-ASCII names silently survive unless the input encoding is forced before the read.
    expect(args.join(' ')).toContain('InputEncoding');
    // A user profile must not be able to change what this script sees.
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
  });

  it('Windows: refuses a path containing a newline rather than deleting the wrong thing', () => {
    // The stdin protocol is line-based, so a newline would split one path into two and hand
    // DeleteFile a path the caller never named. Windows forbids control characters in a
    // filename, so this is unreachable in practice — it is a guard on the FAILURE MODE
    // (a wrong delete), not on a reachable input.
    expect(() => trashCommand(['C:\\x\\bad\nname.json'], 'win32')).toThrow(/newline/);
    expect(() => trashCommand(['C:\\x\\bad\rname.json'], 'win32')).toThrow(/newline/);
    // The other platforms pass paths as real argv, so they carry no such constraint.
    expect(() => trashCommand(['/x/bad\nname.json'], 'darwin')).not.toThrow();
  });

  it('Linux/other: uses trash-put with the whole path list as args', () => {
    expect(trashCommand('/x/m.glb', 'linux')).toEqual({ command: 'trash-put', args: ['/x/m.glb'] });
    expect(trashCommand(['/x/m.glb', '/x/n.png'], 'linux')).toEqual({ command: 'trash-put', args: ['/x/m.glb', '/x/n.png'] });
  });
});

/** #1006/#883 — the Linux fallback is a REAL `rmSync`, not a trash: nothing it removes is
 *  recoverable afterwards, and `rmSync(recursive)` acts on the NAME. A linked asset folder (a
 *  shared texture library is the plausible shape) was unlinked, its payload orphaned, and the
 *  unconditional `return { failed: [] }` reported a clean success — the same reporting failure
 *  #884 fixed in this file through a different cause.
 *
 *  ⚠️ Driven through `platform: 'linux'` with an `exec` that throws, which is exactly what an
 *  absent `trash-put` produces (CI/headless). Both parameters are injectable precisely so this
 *  branch is reachable from a Mac. */
describe('moveToTrash — the Linux rmSync fallback reports what it could not safely delete (#1006)', () => {
  let root: string;
  const noTrashPut = () => { throw new Error('trash-put: command not found'); };
  beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-'))); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* fixture */ } });

  it('reports a LINKED folder in `failed` and leaves both the link and its payload alone', () => {
    const payload = path.join(root, 'shared-textures');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'rock.png'), 'bytes');
    const linked = path.join(root, 'project', 'assets', 'textures');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    makeDirLink(payload, linked);

    expect(moveToTrash(linked, 'linux', noTrashPut)).toEqual({ failed: [linked] });
    // The link is still there AND the payload behind it is intact — the two halves of "severed".
    expect(fs.existsSync(linked)).toBe(true);
    expect(fs.readFileSync(path.join(payload, 'rock.png'), 'utf8')).toBe('bytes');
  });

  it("holds back the CHILDREN of a refused directory — deleting one severs through the link", () => {
    // ⚠️ The case a narrower prefix rule dropped for one commit, and it is data loss, not a
    // false report. `findDeleteBoundaries` refuses DIRECTORIES (a junction is `kind:'link'` at
    // depth 0), so a list holding both the folder and a file inside it held the folder back and
    // then `rmSync`'d the child THROUGH the junction — destroying the real file in the shared
    // library it points at, and reporting success. The guard's own refusal produced exactly the
    // severing it exists to prevent.
    const shared = path.join(root, 'shared-lib');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'mesh.glb'), 'the real bytes');
    const linkedDir = path.join(root, 'robot');
    makeDirLink(shared, linkedDir);

    const r = moveToTrash([linkedDir, path.join(linkedDir, 'mesh.glb')], 'linux', noTrashPut);
    expect(r.failed.sort()).toEqual([linkedDir, path.join(linkedDir, 'mesh.glb')].sort());
    // THIS is the assertion that matters — the payload behind the junction is untouched.
    expect(fs.readFileSync(path.join(shared, 'mesh.glb'), 'utf8')).toBe('the real bytes');
    expect(fs.existsSync(linkedDir)).toBe(true);
  });

  it('still DELETES the self-contained paths in the same batch — the accept side', () => {
    // ⚠️ Without this the guard above is indistinguishable from one that fails every path. It
    // also pins the per-path granularity: one unsafe path must not cost the others their delete,
    // which is what a throw would have done.
    const ok1 = path.join(root, 'a'); fs.mkdirSync(ok1); fs.writeFileSync(path.join(ok1, 'x'), 'x');
    const ok2 = path.join(root, 'b.png'); fs.writeFileSync(ok2, 'x');
    const payload = path.join(root, 'elsewhere'); fs.mkdirSync(payload);
    const linked = path.join(root, 'linked'); makeDirLink(payload, linked);

    expect(moveToTrash([ok1, linked, ok2], 'linux', noTrashPut)).toEqual({ failed: [linked] });
    expect(fs.existsSync(ok1)).toBe(false);
    expect(fs.existsSync(ok2)).toBe(false);
    expect(fs.existsSync(linked)).toBe(true);
  });

  it("holds back a refused asset's SIDECARS too — splitting the group destroys its GUID", () => {
    // ⚠️ The defect per-path granularity introduces if it is applied naively, and it is WORSE than
    // the severing this guard exists to stop. `deletionPathsFor` sends the asset and its
    // `.meta.json` / `.meta.local.json` as ONE flat list. Refuse only the asset and the sidecar is
    // deleted out from under a file that is still on disk; the next manifest rebuild mints it a
    // NEW guid, and every scene/prefab reference to the old one resolves to `undefined` — the
    // asset vanishes from every scene, permanently, reported as ok with one refused path.
    const payload = path.join(root, 'shared-lib');
    fs.mkdirSync(payload, { recursive: true });
    const asset = path.join(root, 'textures');
    makeDirLink(payload, asset);
    const meta = asset + '.meta.json';
    const localMeta = asset + '.meta.local.json';
    fs.writeFileSync(meta, '{"id":"keep-this-guid"}');
    fs.writeFileSync(localMeta, '{}');
    // An UNRELATED asset in the same batch must still go — the group rule must not become
    // "refuse the whole request", which is the failure mode on the other side.
    const other = path.join(root, 'other.png');
    fs.writeFileSync(other, 'x');
    // ⚠️ And a NAME-SIBLING must still go too. `textures-old.png` shares the refused path as a
    // raw string prefix but is not its sidecar, and a bare `startsWith` would hold it back —
    // reporting a file nothing was wrong with as failed. The Assets panel flattens a whole
    // multi-selection into ONE call, so this really is how the two arrive together.
    const nameSibling = path.join(root, 'textures-old.png');
    fs.writeFileSync(nameSibling, 'x');

    const r = moveToTrash([asset, meta, localMeta, other, nameSibling], 'linux', noTrashPut);
    expect(r.failed.sort()).toEqual([asset, localMeta, meta].sort());
    expect(fs.existsSync(nameSibling), 'a name-sibling is not a sidecar — it must be deleted').toBe(false);
    expect(fs.existsSync(asset)).toBe(true);
    expect(fs.readFileSync(meta, 'utf8')).toContain('keep-this-guid');  // the GUID survives
    expect(fs.existsSync(localMeta)).toBe(true);
    expect(fs.existsSync(other)).toBe(false);                            // ...and the rest went
  });

  it('DELETES a name-sibling whose next character is a DOT — `robot.glb` beside a refused `robot`', () => {
    // ⚠️ The exact sibling the `startsWith(r + '.')` rule was written for, which that rule did NOT
    // fix: `'robot.glb'.startsWith('robot' + '.')` is TRUE, because every asset filename has an
    // extension. The `textures-old.png` sibling in the test above CANNOT discriminate the two
    // rules — its next character is `-`, so the broken rule deletes it too — which is why this
    // case is spelled out separately rather than added to that batch.
    const payload = path.join(root, 'shared-lib');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'inside.txt'), 'the real bytes');
    const refusedDir = path.join(root, 'robot');
    makeDirLink(payload, refusedDir);
    const sibling = path.join(root, 'robot.glb');
    fs.writeFileSync(sibling, 'x');

    const r = moveToTrash([refusedDir, sibling], 'linux', noTrashPut);
    expect(r.failed).toEqual([refusedDir]);
    expect(fs.existsSync(sibling), '`robot.glb` is not a sidecar of `robot` — it must be deleted').toBe(false);
    // …and the refusal itself still stands, so this cannot pass by refusing nothing.
    expect(fs.existsSync(refusedDir)).toBe(true);
    expect(fs.readFileSync(path.join(payload, 'inside.txt'), 'utf8')).toBe('the real bytes');
  });

  it('ALLOWS a nested link pointing INSIDE the folder — the npm .bin shim shape', () => {
    // The blunt "refuse on any nested link" rule #990 ruled out would fail this, and a
    // node_modules under an asset folder is not exotic.
    const dir = path.join(root, 'pkgdir');
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg', 'cli.js'), 'x');
    fs.mkdirSync(path.join(dir, 'bin'));
    makeDirLink(path.join(dir, 'pkg'), path.join(dir, 'bin', 'shim'));

    expect(moveToTrash(dir, 'linux', noTrashPut)).toEqual({ failed: [] });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('holds back the PARENT of a refused child — refusal has to propagate UPWARD, not only down', () => {
    // The converse of the children case, and the shim exemption above is what creates it: because
    // `findDeleteBoundaries` ALLOWS a link pointing inside the subtree, `pkgdir` scans clean while
    // `pkgdir/bin/shim` — a link at depth 0 of its own scan — is refused. A rule that only walks
    // downward from a refused path never sees that, so `rmSync(pkgdir, {recursive:true})` takes the
    // refused shim with it while the reply still lists the shim as `failed`. That is the guard
    // reporting it saved something it had just destroyed, which is worse than not guarding: the
    // Assets panel shows the row as kept, and the next thing to read it finds nothing.
    const dir = path.join(root, 'pkgdir');
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg', 'cli.js'), 'x');
    fs.mkdirSync(path.join(dir, 'bin'));
    const shim = path.join(dir, 'bin', 'shim');
    makeDirLink(path.join(dir, 'pkg'), shim);

    const r = moveToTrash([dir, shim], 'linux', noTrashPut);
    expect(r.failed.sort()).toEqual([dir, shim].sort());
    // Both must still be on disk — `failed` and "still there" are the same claim.
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.lstatSync(shim).isSymbolicLink()).toBe(true);
  });

  it('does NOT pre-flight the darwin/win32 paths — the OS trash MOVES, it does not unlink', () => {
    // Stated as a test because the obvious "complete the sweep" edit is to apply the pre-flight to
    // every platform, and that would start refusing deletes that were never at risk.
    const payload = path.join(root, 'target'); fs.mkdirSync(payload);
    const linked = path.join(root, 'ln'); makeDirLink(payload, linked);
    expect(moveToTrash(linked, 'darwin', () => ({ failed: [] }))).toEqual({ failed: [] });
    expect(moveToTrash(linked, 'win32', () => ({ failed: [] }))).toEqual({ failed: [] });
  });
});
