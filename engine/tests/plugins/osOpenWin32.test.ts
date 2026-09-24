/** The one test in the repo that drives Windows' REAL file-manager launcher.
 *
 *  #1508 shipped a `revealInOS` that answered 500 on every single reveal on
 *  Windows — the Assets panel, the script tree, and the gameplay recorder's
 *  "Reveal in Finder" card — while the Explorer window opened perfectly well
 *  behind the error. It stayed green for months because the only test that
 *  touched the module replaced the launcher with a stand-in that always
 *  succeeds. No amount of mocking can catch this class: the defect IS the gap
 *  between what the real `explorer.exe` does and what a stand-in pretends it
 *  does, so the only falsifiable test is one that spawns the real thing.
 *
 *  That is also why this runs in `verify` rather than behind a flag (owner,
 *  2026-09-24). It costs an Explorer window opening on the machine running the
 *  gate — the alternative is the gap #968 and #1054 already describe, where the
 *  Windows bug class is guarded by discipline instead of by a gate, and five
 *  such defects in six months were all invisible from a Mac.
 *
 *  ⚠️ **Do not replace the window check with a timing bound.** An earlier draft
 *  asserted "resolves in under 2s" to mean "we are not waiting for the exit".
 *  It proved nothing: measured on this hardware the fix resolves in ~6ms but the
 *  BUGGY await-the-exit shape resolves in ~300ms, because `explorer.exe` returns
 *  almost immediately (with its useless exit code 1). Both sail under any bound
 *  loose enough not to flake under the six-clone load this box carries. The
 *  window is the only observable that separates "the reveal happened" from "a
 *  process was spawned".
 *
 *  Skipped off win32: `explorer` exists nowhere else. */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { revealInOS } from '../../plugins/backend/osOpen';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const execFileAsync = promisify(execFile);
const onWin32 = process.platform === 'win32';

/** Is there an interactive desktop shell to open a window ON?
 *
 *  A CI runner (the OSS mirror's free `windows-latest` leg) runs in a service
 *  session with no `explorer.exe` shell, where `Shell.Application` enumerates
 *  nothing however well the reveal worked. Without this probe a desktop-less
 *  runner could not be told apart from a broken reveal, and the honest options
 *  are "skip loudly" or "assert something vacuous" — this picks the first. */
const shellRunning: boolean = (() => {
  if (!onWin32) return false;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '[bool](Get-Process -Name explorer -ErrorAction SilentlyContinue)'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
})();

/** PowerShell that enumerates Explorer windows currently showing `dir`. Shared by
 *  the assertion and the teardown so they cannot disagree about what "the window
 *  this test opened" means. */
function windowMatcher(dir: string, action: 'count' | 'quit'): string {
  const target = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return [
    '$n = 0;',
    '$shell = New-Object -ComObject Shell.Application;',
    'foreach ($w in @($shell.Windows())) {',
    '  try {',
    '    $u = [uri]::UnescapeDataString($w.LocationURL) -replace "^file:///", "";',
    `    if ($u.TrimEnd('/').ToLower() -eq '${target}') { $n = $n + 1;${action === 'quit' ? ' $w.Quit();' : ''} }`,
    '  } catch { }',
    '}',
    'Write-Output $n',
  ].join(' ');
}

async function countRevealedWindows(dir: string): Promise<number> {
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', windowMatcher(dir, 'count')]);
  return Number(stdout.trim()) || 0;
}

/** Close the window(s) the reveal opened, so a `verify` run does not pile windows
 *  up on the owner's desktop. Matched by LOCATION — only the scratch dir this test
 *  made — so a window the owner had open is never touched. Best-effort by design:
 *  a failure to tidy up must not redden the gate. */
async function closeRevealedWindows(dir: string): Promise<void> {
  try {
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', windowMatcher(dir, 'quit')]);
  } catch {
    /* tidying is not the assertion */
  }
}

const dirs: string[] = [];
function scratch(prefix: string): string {
  const d = makeScratchDir(prefix);
  dirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of dirs) {
    if (onWin32) await closeRevealedWindows(d);
  }
});

describe.skipIf(!onWin32)('revealInOS against the real explorer.exe (win32)', () => {
  it('resolves for a file that exists — explorer\'s exit code must not be believed', async () => {
    const dir = scratch('modoki-reveal-');
    const file = path.join(dir, 'revealed.txt');
    fs.writeFileSync(file, 'hello');

    // Half the claim of #1508's fix: this must not reject. Awaiting explorer's exit
    // — what the code did before — rejects here every time, because explorer returns
    // 1 whether or not it did what was asked.
    await expect(revealInOS(file)).resolves.toBeUndefined();
  }, 30_000);

  it.skipIf(!shellRunning)('actually opens a window showing the file\'s folder', async () => {
    const dir = scratch('modoki-reveal-window-');
    const file = path.join(dir, 'revealed.txt');
    fs.writeFileSync(file, 'hello');

    expect(await countRevealedWindows(dir)).toBe(0); // nothing is showing it yet

    await revealInOS(file);

    // The other half, and the one a mock can never reach: a window really appeared.
    // Explorer takes a moment to create it, so poll rather than sleeping a guess.
    let seen = 0;
    for (let i = 0; i < 20 && seen === 0; i++) {
      seen = await countRevealedWindows(dir);
      if (seen === 0) await new Promise((r) => setTimeout(r, 250));
    }
    expect(seen).toBeGreaterThan(0);
  }, 60_000);
});

/* Deliberately NOT covered here:
 *
 *  - **A path the shell cannot open.** On win32 the missing-file half is answered
 *    upstream (the routes 404 before the launcher is reached, #1515), and driving
 *    the other half — a file that exists behind a dangling association — on purpose
 *    would raise the very modal dialog this change exists to keep off the desktop.
 *  - **The "opener could not be STARTED" branch**, which is the mocked case in
 *    `osOpen.test.ts`; there is no way to make the real explorer.exe vanish for one
 *    test.
 *  - **`openInOS` against the real `cmd /c start`.** It is the branch #1515 was
 *    about, and it has no real-binary coverage: asserting it would launch whatever
 *    app is associated with the fixture's extension on the machine running the
 *    gate, which is a bigger intrusion than the Explorer window the owner signed
 *    off on. The gate would therefore not notice a later options change that
 *    suppressed the opened window — the #1508 shape exactly (resolves fine,
 *    feature dead). Raising this needs the owner's call on what `verify` may
 *    launch. */
