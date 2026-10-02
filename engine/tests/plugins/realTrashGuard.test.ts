/** #2033: the setup's OS-trash guard (`tests/realTrashGuard.ts`). Its predicate is held to the commands `trashCommand`
 *  really builds, and `moveToTrash` with its real exec is driven through it: the trash is blocked and recorded. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { moveToTrash, trashCommand } from '../../plugins/asset-fs-ops';
import { isRealTrashCall, realGcloudTarget, takeRealGcloudCalls, takeRealTrashCalls } from '../realTrashGuard';
import { gcloudSync } from '../../scripts/ota/gcloud.mjs';
import { toSpawn } from '../../scripts/winSpawn.mjs';
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

/** #2068: the same wrapper blocks a REAL gcloud — one outside the OS temp dir. A fake in a scratch dir is a test's own
 *  and runs. "Outside" is staged by pointing `os.tmpdir()` elsewhere, so no file is written outside the temp dir.
 *  Mutations, each checked red: `realGcloudTarget` drops the temp-dir allowance — "a gcloud in a scratch dir…" and the six
 *  `otaStatusRoute.test.ts` cases that run its fake; the wrapper skips the gcloud check — "the real gcloudSync is blocked…", and
 *  `sseRouteRejection.test.ts` with its `execGcloudSync` stub removed runs the real one again; no `spawn` wrapper — "a build
 *  step that spawns gcloud…"; every caret stripped — "a caret in the path…". The no-PATH-key default dirs can only red
 *  where a gcloud sits in `/usr/bin` or `/bin` (the ubuntu runner); on a Mac that assertion holds either way. */
describe('#2068 realGcloudGuard', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const fakeGcloud = () => {
    const dir = makeScratchDir('real-gcloud-guard-');
    const name = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
    fs.writeFileSync(path.join(dir, name), process.platform === 'win32' ? '@echo fake\r\n' : '#!/bin/sh\necho fake\n', { mode: 0o755 });
    return { dir, file: path.join(dir, name) };
  };
  const outsideTmp = () => vi.spyOn(os, 'tmpdir').mockReturnValue(makeScratchDir('real-gcloud-guard-elsewhere-'));

  it('a gcloud in a scratch dir is a fake: allowed, and it runs', () => {
    const { dir } = fakeGcloud();
    expect(realGcloudTarget('gcloud', ['storage', 'ls'], { PATH: dir })).toBeNull();
    expect(String(gcloudSync(['storage', 'ls'], { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } }))).toContain('fake');
    expect(takeRealGcloudCalls()).toEqual([]);
  });

  it('a gcloud outside it is real: named, as the bare POSIX command and as the cmd.exe line toSpawn builds', () => {
    const { dir, file } = fakeGcloud();
    outsideTmp();
    expect(realGcloudTarget('gcloud', ['storage', 'ls'], { PATH: dir })).toEqual({ bin: path.join(dir, path.basename(file)), argv: ['storage', 'ls'] });
    const cmd = path.join(dir, 'gcloud.cmd');
    if (!fs.existsSync(cmd)) fs.writeFileSync(cmd, '@echo fake\r\n');
    const win = toSpawn(cmd, ['storage', 'ls'], { platform: 'win32', comspec: 'cmd.exe' });
    expect(win.command).toBe('cmd.exe'); // the premise: the line, not the binary, names gcloud
    expect(realGcloudTarget(win.command, win.args, {})).toEqual({ bin: cmd, argv: ['storage', 'ls'] });
    expect(realGcloudTarget('git', ['status'], { PATH: dir })).toBeNull();
    expect(realGcloudTarget('gcloud', ['storage', 'ls'], { PATH: path.join(dir, 'nowhere') })).toBeNull(); // ENOENT reaches nothing
  });

  it('the real gcloudSync is blocked and recorded', () => {
    const { dir } = fakeGcloud();
    outsideTmp();
    expect(() => gcloudSync(['storage', 'buckets', 'update', 'gs://x'], { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } })).toThrow(/realGcloudGuard/);
    expect(takeRealGcloudCalls()).toEqual([`${path.join(dir, process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud')} storage buckets update`]);
  });

  it('a build step that spawns gcloud is blocked and recorded too', () => {
    const { dir } = fakeGcloud();
    outsideTmp();
    const s = toSpawn('gcloud', ['storage', 'rsync', 'a', 'gs://x'], { env: { PATH: dir } });
    expect(() => spawn(s.command, s.args, { ...s.options, env: { ...process.env, PATH: dir } })).toThrow(/realGcloudGuard/);
    expect(takeRealGcloudCalls()).toEqual([`${path.join(dir, process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud')} storage rsync a`]);
  });

  it('a caret in the path survives the unescape, and an env with no PATH key searches the default dirs', () => {
    const { dir } = fakeGcloud();
    const odd = path.join(dir, 'a^b');
    fs.mkdirSync(odd);
    fs.writeFileSync(path.join(odd, 'gcloud.cmd'), '@echo fake\r\n');
    outsideTmp();
    const win = toSpawn(path.join(odd, 'gcloud.cmd'), ['storage', 'ls'], { platform: 'win32', comspec: 'cmd.exe' });
    expect(realGcloudTarget(win.command, win.args, {})?.bin).toBe(path.join(odd, 'gcloud.cmd'));
    if (process.platform !== 'win32') {
      const onDefault = ['/usr/bin', '/bin'].some((d) => fs.existsSync(path.join(d, 'gcloud')));
      expect(realGcloudTarget('gcloud', ['ls'], {}) !== null).toBe(onDefault);
    }
  });
});
