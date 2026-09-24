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
 *  2026-09-24). It costs a few short-lived windows (two for the tests, two for
 *  the probes that decide whether they can run — see `probeRevealObservable`)
 *  on the machine running the gate — the alternative is the gap #968 and #1054 already describe, where the
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
import { execFile, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { openInOS, revealInOS } from '../../plugins/backend/osOpen';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const execFileAsync = promisify(execFile);
const onWin32 = process.platform === 'win32';

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

interface WindowedProc { id: number; name: string; title: string }

/** Every process that currently owns a top-level window, with its title. The title is
 *  what identifies the app that opened our fixture — see the tab caveat on the
 *  `openInOS` test below for why the PROCESS alone is not enough. */
async function windowedProcesses(): Promise<WindowedProc[]> {
  const ps = 'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "{0}|{1}|{2}" -f $_.Id, $_.ProcessName, $_.MainWindowTitle }';
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, name, ...rest] = l.split('|');
      return { id: Number(id), name, title: rest.join('|') };
    });
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

async function pollUntil<T>(tries: number, read: () => Promise<T | undefined>): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

/** Why a probe saw nothing: the facts that separate the candidate causes in #1528
 *  (a different session from explorer, a non-interactive process, an empty
 *  `Shell.Application`). Printed on a skip so a CI log records the answer. */
function desktopDiagnostics(): string {
  try {
    return execFileSync(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        '"mySession=$((Get-Process -Id $PID).SessionId) interactive=$([Environment]::UserInteractive) ' +
          'explorerSessions=$((@(Get-Process -Name explorer -ErrorAction SilentlyContinue) | ForEach-Object { $_.SessionId }) -join \',\') ' +
          'shellWindows=$(@((New-Object -ComObject Shell.Application).Windows()).Count)"',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch (e) {
    return `diagnostics failed: ${(e as Error).message}`;
  }
}

/** Can a window opened from THIS process be seen by the observable each test
 *  asserts on? Asked by doing it — once per observable, before the tests.
 *
 *  ⚠️ **A running `explorer.exe` is NOT the answer** (#1528). The probe this
 *  replaced asked exactly that, and the OSS mirror's `windows-latest` runner said
 *  yes — explorer IS running there — yet no window the test opened ever showed up
 *  in `Shell.Application`, so every public CI run went red. It was then excluded
 *  by NAME (`GITHUB_ACTIONS`), which hid the question instead of answering it.
 *  A capability is only established by exercising it.
 *
 *  ⚠️ **Each probe opens its window ITSELF, never through `osOpen.ts`** — that is
 *  what keeps the tests falsifiable. If `revealInOS`/`openInOS` stop opening
 *  anything, the probe still sees its own window and the test goes red; only a
 *  machine where NO window can be observed skips.
 *
 *  ⚠️ **Each probe cleans up INLINE, before it returns.** The probes run at import,
 *  and vitest skips `afterAll` when a `-t` filter leaves no test in the file to run
 *  — so a probe window left for `afterAll` leaked onto the desktop on every
 *  filtered run (found in review).
 *
 *  ⚠️ **A probe that THROWS is not caught.** Only a window that never appears means
 *  "not observable"; a broken observation helper (`windowedProcesses`,
 *  `countRevealedWindows`) must fail the file, not turn into a green skip whose
 *  message blames the environment (a catch-all wrapper did exactly that — found
 *  in review). A failed SPAWN is already absorbed by the child's `error` handler.
 *
 *  A skip prints `desktopDiagnostics()`, so the first CI run that skips records why. */
async function probeRevealObservable(): Promise<boolean> {
  const dir = scratch('modoki-probe-reveal-');
  const file = path.join(dir, 'probe.txt');
  fs.writeFileSync(file, 'probe');
  // Detached and let go: explorer's exit code means nothing (docs/windows.md
  // § "A GUI launcher's exit status is not the operation's outcome").
  const child = spawn('explorer', [`/select,${file}`], { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* the poll reports the absence */ });
  child.unref();
  try {
    return (await pollUntil(40, async () => ((await countRevealedWindows(dir)) > 0 ? true : undefined))) === true;
  } finally {
    await closeRevealedWindows(dir);
  }
}

/** The open test's observable is a top-level window TITLED after something, read
 *  through `MainWindowTitle`. The probe shows a bare WinForms window with a stamp
 *  as its title, owned by a child of this process.
 *
 *  ⚠️ **Not Notepad, though that is what the test ends up opening.** Windows 11
 *  Notepad restores its previous session on launch, so killing a Notepad the probe
 *  started does not remove the probe's tab — it comes back on the owner's next
 *  launch, and a killed "new" Notepad may be holding the owner's restored unsaved
 *  tabs too (found in review). A window this process owns outright has neither
 *  problem: killing it is the whole cleanup.
 *
 *  ⚠️ **Not `detached`**, unlike the launchers: a detached PowerShell's form never
 *  appeared in `MainWindowTitle` here (measured on the win clone, 2026-09-24),
 *  while the same command attached showed it on the first poll.
 *
 *  ⚠️ **No `-WindowStyle Hidden`, and no `windowsHide`.** Attached, powershell
 *  SHARES the console vitest inherited, so `-WindowStyle Hidden` hid the owner's
 *  own terminal (a classic console host; Windows Terminal was unaffected) and the
 *  kill left it hidden. `windowsHide` hides the form as well, so the probe never
 *  sees it (both found in review). Nothing to hide: an attached child adds no
 *  window of its own. */
async function probeOpenObservable(): Promise<boolean> {
  const stamp = `modokiprobe${Date.now()}`;
  const child = spawn(
    'powershell',
    [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = '${stamp}'; [void]$f.ShowDialog()`,
    ],
    { stdio: 'ignore' },
  );
  child.on('error', () => { /* the poll reports the absence */ });
  try {
    const hit = await pollUntil(40, async () => (await windowedProcesses()).find((p) => p.title.includes(stamp)));
    return hit !== undefined;
  } finally {
    child.kill();
  }
}

// Top-level so `it.skipIf` can read the answers at collection time.
const revealObservable = onWin32 ? await probeRevealObservable() : false;
const openObservable = onWin32 ? await probeOpenObservable() : false;
if (onWin32 && !(revealObservable && openObservable)) {
  // Straight to stderr, not console.warn: the default reporter swallows a passing
  // file's console output, and this line is the only record of WHY a CI run skipped.
  process.stderr.write(
    `[osOpenWin32] window test(s) skipped — reveal observable: ${revealObservable}, open observable: ${openObservable}; ` +
      `a probe window opened from this process was never seen (#1528). ${desktopDiagnostics()}\n`,
  );
}

describe.skipIf(!onWin32)('revealInOS against the real explorer.exe (win32)', () => {
  it('resolves for a file that exists — explorer\'s exit code must not be believed', async () => {
    const dir = scratch('modoki-reveal-');
    const file = path.join(dir, 'revealed.txt');
    fs.writeFileSync(file, 'hello');

    // Half the claim of #1508's fix: this must not reject. Awaiting explorer's exit
    // — what the code did before — rejects here every time, because explorer returns
    // 1 whether or not it did what was asked.
    await expect(revealInOS(file)).resolves.toBeUndefined();

    // Not an assertion — this test's window must not outlive the file. afterAll's
    // close can run before explorer has CREATED it, which left a stray window on
    // the desktop (found in review). Wait for it where it can be seen, then close it.
    if (revealObservable) {
      await pollUntil(20, async () => ((await countRevealedWindows(dir)) > 0 ? true : undefined));
      await closeRevealedWindows(dir);
    }
  }, 30_000);

  it.skipIf(!revealObservable)('actually opens a window showing the file\'s folder', async () => {
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

describe.skipIf(!onWin32)('openInOS against the real cmd /c start (win32)', () => {
  /** ⚠️ Cleanup here is deliberately ASYMMETRIC, and the asymmetry is measured, not
   *  cautious. Windows 11's Notepad is tabbed and single-instance: opening a file with
   *  NO Notepad running starts a new process, but opening one while Notepad is ALREADY
   *  running is absorbed as a TAB into the existing process and creates no new pid
   *  (both observed on the win clone, 2026-09-24). So killing "the app that has our
   *  title" would close the owner's other documents along with our fixture.
   *
   *  Hence: assert by TITLE, which holds in both cases — and kill ONLY a pid that did
   *  not exist before the call. When the fixture is absorbed into an app the owner was
   *  already using, it is left alone and reported, and the fixture's own text says what
   *  it is so a stray tab explains itself. Losing a second of the owner's work is much
   *  worse than leaving a tab they can close.
   *
   *  ⚠️ **Even the new-pid kill does not clean up on Windows 11 Notepad**, which
   *  restores its previous session on launch — the fixture's tab comes back the
   *  next time the owner opens Notepad. Open as #1534. */
  it.skipIf(!openObservable)('actually opens the file in its default app', async () => {
    const dir = scratch('modoki-open-');
    // No dot in the stamp: some apps title the window without the extension.
    const stamp = `modokigate${Date.now()}`;
    const file = path.join(dir, `${stamp}.txt`);
    fs.writeFileSync(file, "Opened by Modoki's test gate (engine/tests/plugins/osOpenWin32.test.ts).\nNothing is wrong — this window can be closed.\n");

    const before = await windowedProcesses();
    const beforeIds = new Set(before.map((p) => p.id));

    await openInOS(file);

    let hit: WindowedProc | undefined;
    for (let i = 0; i < 24 && !hit; i++) {
      hit = (await windowedProcesses()).find((p) => p.title.toLowerCase().includes(stamp));
      if (!hit) await new Promise((r) => setTimeout(r, 250));
    }

    // The claim a mock cannot reach: something really opened our file. `openInOS`
    // resolving proves only that a process was spawned — #1508's shape exactly.
    expect(hit, 'no window appeared titled for the opened file').toBeTruthy();

    if (hit && !beforeIds.has(hit.id)) {
      try { process.kill(hit.id); } catch { /* it closed itself; tidying is not the assertion */ }
    } else if (hit) {
      console.warn(`[osOpenWin32] the fixture opened as a tab in ${hit.name} (pid ${hit.id}), which was already running — left alone on purpose; close the tab by hand.`);
    }
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
 *  - **A `.txt` handler that is not Notepad.** The `openInOS` test above identifies
 *    what opened the fixture by WINDOW TITLE, so it holds for any app that titles its
 *    window after the file — which Notepad, VS Code and every editor tried here do. An
 *    association pointing at something that does not would fail it; that is a machine
 *    configuration question, not a defect in the code under test, and the message says
 *    so. Where no window can be observed it skips (the probes above) rather than pretending. */
