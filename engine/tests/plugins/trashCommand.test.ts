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

  it('Windows: routes to the Recycle Bin via VisualBasic, paths as $args', () => {
    const { command, args } = trashCommand(['C:/x/m.glb', 'C:/x/n.png'], 'win32');
    expect(command).toBe('powershell');
    expect(args.join(' ')).toContain('SendToRecycleBin');
    expect(args.join(' ')).toContain('foreach ($p in $args)'); // loops every path in one process
    expect(args.slice(-2)).toEqual(['C:/x/m.glb', 'C:/x/n.png']);
  });

  it('Linux/other: uses trash-put with the whole path list as args', () => {
    expect(trashCommand('/x/m.glb', 'linux')).toEqual({ command: 'trash-put', args: ['/x/m.glb'] });
    expect(trashCommand(['/x/m.glb', '/x/n.png'], 'linux')).toEqual({ command: 'trash-put', args: ['/x/m.glb', '/x/n.png'] });
  });
});
