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
  // `''` is PowerShell's escape inside a single-quoted literal: a temp dir under a user
  // name like O'Brien otherwise breaks the parse and fails the whole file (#1534 review).
  const target = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().replace(/'/g, "''");
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
 *  what identifies the window that opened our fixture: `throwawayHandler` titles it
 *  from `%1`, so a match proves the path arrived, which a process name cannot. */
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
  // § "A GUI launcher's exit status is not the operation's outcome"). Quoted and
  // verbatim for the same reason as `revealInOS`: under a `%TEMP%` with a space, the
  // default quoting sent explorer to Documents and the probe skipped the reveal tests.
  const child = spawn('explorer', [`/select,"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.on('error', () => { /* the poll reports the absence */ });
  child.unref();
  try {
    return (await pollUntil(40, async () => ((await countRevealedWindows(dir)) > 0 ? true : undefined))) === true;
  } finally {
    await closeRevealedWindows(dir);
  }
}

/** Write the one PowerShell script both the open probe and the open test's handler run:
 *  a bare WinForms window titled with its argument, verbatim. Shared so the probe
 *  establishes the capability the test actually needs — a `-File` script is gated by
 *  execution policy and AppLocker where `-Command` is not, so a probe using `-Command`
 *  would pass on a locked-down machine whose handler can never run, and the test would
 *  go red blaming `openInOS` (found in review). `-ExecutionPolicy Bypass` does not beat a
 *  Group Policy setting; there, both skip together. */
function writeWindowScript(dir: string): string {
  const script = path.join(dir, 'window.ps1');
  fs.writeFileSync(
    script,
    'param([string]$p)\r\nAdd-Type -AssemblyName System.Windows.Forms\r\n$f = New-Object System.Windows.Forms.Form\r\n' +
      '$f.Text = $p\r\n[void]$f.ShowDialog()\r\n',
  );
  return script;
}

/** The open test's observable is a top-level window TITLED after something, read
 *  through `MainWindowTitle`. The probe shows a bare WinForms window with a stamp
 *  as its title, owned by a child of this process, through `writeWindowScript`.
 *
 *  ⚠️ **Never Notepad** — for the probe or the test (#1534, `throwawayHandler`).
 *  Windows 11 Notepad restores its previous session on launch, so a probe tab comes
 *  back on the owner's next launch, and a killed "new" Notepad may be holding the
 *  owner's restored unsaved tabs too (found in review). A window this process owns
 *  outright has neither problem: killing it is the whole cleanup.
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
  const script = writeWindowScript(scratch('modoki-probe-open-'));
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, stamp], { stdio: 'ignore' });
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

/** A space AND an apostrophe in every folder the reveal tests show — the shapes a real
 *  project path has ("My Game", "O'Brien") and a scratch dir normally does not. A path
 *  with a space sent explorer to Documents for as long as the fixture had none, and
 *  nothing noticed (#1534's close-out). */
const REVEAL_PREFIX = "modoki reveal o'b,c-";

describe.skipIf(!onWin32)('revealInOS against the real explorer.exe (win32)', () => {
  it('resolves for a file that exists — explorer\'s exit code must not be believed', async () => {
    const dir = scratch(REVEAL_PREFIX);
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
    const dir = scratch(`${REVEAL_PREFIX}window-`);
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

/** A per-user file association that exists only for one run of the `openInOS` test: a
 *  made-up extension whose `open` verb shows a window TITLED with the opened file's
 *  name, owned by a process nobody else uses.
 *
 *  ⚠️ **Why not the machine's real `.txt` handler** (#1534). On Windows 11 that is
 *  Notepad, which saves its tabs and restores them on the next launch — and the tab
 *  survives a kill, a normal close (closing is what SAVES the session) and deleting
 *  the file (measured: 27 of 29 leftover gate tabs pointed at files that were already
 *  gone). So every `verify` left the owner a permanent tab, and cleanup would have
 *  meant driving the owner's own Notepad. The owner chose this instead (2026-09-24):
 *  the test still goes through the real launcher → shell association → app launch,
 *  it just does not end in an app that belongs to the owner's session.
 *
 *  The title IS `%1`, so the test can require the exact path to have reached the app,
 *  not merely that something started. The script lives in its own clean folder: the
 *  shell reads `%` in the registered command as a placeholder, so a script path under
 *  the test's hostile fixture folder (`%OS%`) broke the handler itself (measured). `%1` is QUOTED and handed to a `-File` script as
 *  an argument, never spliced into PowerShell source: an apostrophe in the path would
 *  break a `'%1'` literal, and an unquoted `%1` can arrive as an 8.3 short name
 *  without the stamp (found in review). Unique per run, so a concurrent gate on the
 *  same machine cannot delete this run's keys. HKCU only — no elevation.
 *
 *  ⚠️ **The two `Classes` keys are not the whole footprint.** Resolving the
 *  association makes the SHELL write two more per-user traces of its own —
 *  `Explorer\FileExts\.<ext>` and an `ApplicationAssociationToasts` value — and
 *  those outlived every run until `unregister` learned to delete them too (found in
 *  review: one of each per `verify`, measured). A process killed mid-test still
 *  leaves inert entries for an extension nothing else uses; accepted. */
function throwawayHandler(dir: string, stamp: string): { ext: string; register: () => void; unregister: () => void } {
  const ext = `.${stamp}`;
  const progId = `Modoki.Gate.${stamp}`;
  const hkcu = 'HKCU\\Software';
  const explorer = `${hkcu}\\Microsoft\\Windows\\CurrentVersion`;
  const reg = (...args: string[]) => execFileSync('reg', args, { stdio: 'ignore' });
  /** Every trace a run can leave, as `reg` arguments naming a key or one value. */
  const traces: string[][] = [
    [`${hkcu}\\Classes\\${ext}`],
    [`${hkcu}\\Classes\\${progId}`],
    [`${explorer}\\Explorer\\FileExts\\${ext}`],
    [`${explorer}\\ApplicationAssociationToasts`, '/v', `${progId}_${ext}`],
  ];
  return {
    ext,
    register: () => {
      const script = writeWindowScript(dir);
      // `-WindowStyle Hidden` hides only the handler's OWN console: it was started by the
      // shell, not attached to vitest's, unlike the probe above.
      const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" "%1"`;
      reg('add', `${hkcu}\\Classes\\${ext}`, '/ve', '/d', progId, '/f');
      reg('add', `${hkcu}\\Classes\\${progId}\\shell\\open\\command`, '/ve', '/d', command, '/f');
    },
    unregister: () => {
      for (const t of traces) {
        const [key, ...value] = t;
        try {
          reg('query', key, ...value);
        } catch {
          continue; // never written — a failed register, or the shell never resolved it
        }
        try {
          reg('delete', key, ...value, '/f');
        } catch {
          // Not the assertion, but never silent: a leaked association is state on the owner's machine.
          process.stderr.write(`[osOpenWin32] could not delete ${t.join(' ')} — remove it by hand.\n`);
        }
      }
    },
  };
}

/** Every per-user registry entry still naming `stamp`, found by SEARCHING rather than by
 *  re-reading `unregister`'s list — a check driven by that list could never notice a
 *  trace the list does not know about, which is how the shell's own two went unseen.
 *  Covers where the shell keeps association state (`Classes`, and all of
 *  `CurrentVersion`: FileExts, the toasts, and anything not yet found). ~5s here. */
async function registryTracesOf(stamp: string): Promise<string[]> {
  const roots = ['HKCU\\Software\\Classes', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion'];
  const found: string[] = [];
  for (const root of roots) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', root, '/f', stamp, '/s']);
      found.push(...stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.toLowerCase().includes(stamp)));
    } catch (e) {
      // `reg query /f` exits 1 with an EMPTY stderr when nothing matches — the answer we
      // want. Any other failure (reg missing, key unreadable) writes stderr and must not
      // read as "clean" (found in review). Not the stdout text: that is localized.
      const { code, stderr } = e as { code?: unknown; stderr?: string };
      if (code !== 1 || String(stderr ?? '').trim() !== '') throw e;
    }
  }
  return found;
}

/** Kill every process whose command line carries `stamp` — the handler, and a launcher
 *  still behind it. By command line rather than by window, so a handler whose window
 *  appeared only after the poll gave up is not left orphaned on the desktop (found in
 *  review). The querying PowerShell carries the stamp too, so it excludes itself. */
function killByStamp(stamp: string): void {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${stamp}*' } | ` +
          'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ],
      { stdio: 'ignore' },
    );
  } catch {
    /* tidying is not the assertion */
  }
}

describe.skipIf(!onWin32)('openInOS against the real launcher (win32)', () => {
  it.skipIf(!openObservable)('actually opens the file through its shell association, the path intact', async () => {
    // Every character a shell would read: `&` (a second command), `%OS%` (expansion),
    // `^` (escape), plus an apostrophe and explorer's own separator `,`. `cmd /c start`
    // opened NOTHING for this folder, having run part of the path as a command —
    // injection from a file name (#1534's close-out). NO SPACE, deliberately: Node
    // quotes an argument only when it holds one, so a space hid the `,` bug — bare,
    // explorer split the path and opened nothing (measured). A real project path can
    // hold any of these.
    const dir = scratch("modoki-open-R&D%OS%^x-o'b,c-");
    const stamp = `modokigate${Date.now()}`;
    const handler = throwawayHandler(scratch('modoki-open-handler-'), stamp);
    const file = path.join(dir, `${stamp}${handler.ext}`);
    let hit: WindowedProc | undefined;
    let beforeIds: Set<number> | undefined;
    try {
      // Inside the try: a register that fails half-way still reaches `unregister`.
      handler.register();
      fs.writeFileSync(file, "Opened by Modoki's test gate (engine/tests/plugins/osOpenWin32.test.ts).\n");
      beforeIds = new Set((await windowedProcesses()).map((p) => p.id));

      await openInOS(file);

      hit = await pollUntil(24, async () => (await windowedProcesses()).find((p) => p.title.toLowerCase().includes(stamp)));
    } finally {
      killByStamp(stamp);
      handler.unregister();
    }

    // The claim a mock cannot reach: something really opened our file. `openInOS`
    // resolving proves only that a process was spawned — #1508's shape exactly.
    expect(hit, 'no window appeared titled for the opened file').toBeTruthy();
    expect(hit!.title, 'the app received a different path than the one opened').toBe(file);
    expect(beforeIds!.has(hit!.id), 'the handler window belongs to a process that was already running').toBe(false);

    // #1534's whole defect was residue nobody looked for. A run must leave NOTHING that
    // names it behind — asserted, not tidied, so a new trace goes red instead of piling up.
    expect(await registryTracesOf(stamp), 'the run left per-user registry entries behind').toEqual([]);
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
 *  - **The machine's REAL default apps.** The `openInOS` test opens its fixture through
 *    a throwaway association it registers itself, never `.txt` → Notepad (#1534): which
 *    app a type opens in is machine configuration, not the code under test, and the real
 *    one keeps state the gate cannot clean up. Where no window can be observed it skips
 *    (the probes above) rather than pretending. */
