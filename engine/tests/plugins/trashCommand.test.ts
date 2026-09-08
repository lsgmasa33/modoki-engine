/** Unit tests for trashCommand — the pure builder behind /api/delete-asset's
 *  "move to OS trash". Two headline assertions:
 *  - the macOS `as alias` coercion: without it Finder rejects a bare
 *    `POSIX file "<path>"` with -1728 on macOS 26+, which silently broke every
 *    asset delete in the editor.
 *  - BATCHING: one builder call for the whole path list emits a single
 *    invocation, so a multi-file delete plays ONE OS trash sound instead of a
 *    burst of one-chime-per-file. */

import { describe, it, expect } from 'vitest';
import { trashCommand } from '../../plugins/asset-fs-ops';

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
