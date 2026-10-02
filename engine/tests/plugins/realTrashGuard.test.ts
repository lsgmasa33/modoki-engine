/** #2033: the setup's OS-trash guard (`tests/realTrashGuard.ts`). Its predicate is held to the commands `trashCommand`
 *  really builds, and `moveToTrash` with its real exec is driven through it: the trash is blocked and recorded. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { moveToTrash, trashCommand } from '../../plugins/asset-fs-ops';
import { isRealTrashCall, takeRealTrashCalls } from '../realTrashGuard';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

describe('#2033 realTrashGuard', () => {
  it('names the trash command of every platform, as trashCommand builds it', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const { command, args } = trashCommand(['/tmp/x/a.json', '/tmp/x/a.json.meta.json'], platform);
      expect(isRealTrashCall(command, args), platform).toBe(true);
    }
  });

  it('…and nothing else: another osascript, another PowerShell, an ordinary tool', () => {
    expect(isRealTrashCall('osascript', ['-e', 'tell application "Finder" to activate'])).toBe(false);
    expect(isRealTrashCall('osascript', ['-e', 'display notification "x"'])).toBe(false);
    expect(isRealTrashCall('powershell', ['-NoProfile', '-Command', 'Get-ChildItem'])).toBe(false);
    expect(isRealTrashCall('git', ['rm', 'a'])).toBe(false);
    expect(isRealTrashCall('/usr/bin/osascript', ['-e', 'tell application "Finder" to delete theItems'])).toBe(true);
    expect(isRealTrashCall('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-Command', "DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')"])).toBe(true);
  });

  it('the real moveToTrash is blocked and recorded: the file stays, no trash is reached', () => {
    const dir = makeScratchDir('real-trash-guard');
    const p = path.join(dir, 'a.json');
    fs.writeFileSync(p, '{}');
    // darwin: the blocked exec reads as Finder refusing, so the path is reported failed and stays on disk.
    expect(moveToTrash(p, 'darwin')).toMatchObject({ failed: [p] });
    expect(fs.existsSync(p)).toBe(true);
    // win32: a failed exec naming no path is the command itself failing, so the call throws.
    expect(() => moveToTrash(p, 'win32')).toThrow();
    expect(fs.existsSync(p)).toBe(true);
    // Taken here, or the setup's afterEach would fail this test as the trash's caller.
    expect(takeRealTrashCalls()).toHaveLength(2);
  });
});
