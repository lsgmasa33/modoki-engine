/** LIVE win32 test for `moveToTrash` — the one that actually runs PowerShell (#875).
 *
 *  ⚠️ This file exists because its sibling `trashCommand.test.ts` could not fail. That one
 *  asserts the built argv, which is a claim about a STRING; whether Windows then does the
 *  thing is a claim about BEHAVIOUR, and behaviour has to be run. For months the argv was
 *  asserted green while `powershell -Command "<script>" p1 p2` bound `$args` to nothing and
 *  recycled precisely zero files. No amount of string assertion could have seen that.
 *
 *  The fixture names are not decoration — each one is a defect that was measured on `win`
 *  before this landed:
 *    • `a file.json`        — `-Command` re-parses appended argv as a command LINE, so a space
 *                             split this into two paths and the delete targeted `…\a`.
 *    • `it's [weird].json`  — quoting/globbing metacharacters in a name.
 *    • `にほんご.json`        — stdin without a forced UTF-8 input encoding mangles the bytes and
 *                             the file SILENTLY survives (exit 0, no error).
 *    • `anim dir/sub/…`     — `DeleteFile` throws "Could not find file" on a directory;
 *                             folders need `DeleteDirectory`.
 *
 *  Skipped off win32: the mechanism under test is a Windows one, and macOS/Linux use argv,
 *  which the pure tests already cover. It really does recycle its fixtures — a handful of
 *  small temp files per run, which is the cost of testing the actual API rather than a mock.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { moveToTrash, trashCommand } from '../../plugins/asset-fs-ops';

const onWin = process.platform === 'win32';
const roots: string[] = [];

function fixture(): { root: string; files: string[]; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-trash-live-'));
  roots.push(root);
  const files = ['a file.json', "it's [weird].json", 'にほんご.json', 'Grüße.json'].map((n) => {
    const p = path.join(root, n);
    fs.writeFileSync(p, '{}');
    return p;
  });
  const dir = path.join(root, 'anim dir');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'run.json'), '{}');
  return { root, files, dir };
}

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe.skipIf(!onWin)('moveToTrash on real Windows', () => {
  it('recycles every path — spaces, metacharacters, non-ASCII, and a nested folder', () => {
    const { files, dir } = fixture();
    moveToTrash([...files, dir]);
    for (const f of files) expect({ name: path.basename(f), gone: fs.existsSync(f) }).toEqual({ name: path.basename(f), gone: false });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('deletes ONLY what it was given — a sibling of a spaced path survives', () => {
    // The precise shape of the old defect: `…\a file.json` re-parsed into `…\a` + `file.json`,
    // so the delete aimed at a path the caller never named. If that regresses, `a` disappears.
    const { root } = fixture();
    const target = path.join(root, 'a file.json');
    const bystander = path.join(root, 'a');
    fs.mkdirSync(bystander);
    fs.writeFileSync(path.join(bystander, 'keep.json'), '{}');

    moveToTrash([target]);

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(bystander, 'keep.json'))).toBe(true);
  });

  it('treats a filename carrying PowerShell syntax as DATA, not source', () => {
    // A legal NTFS name (no `:` `\` `/` `*` `?` `"` `<` `>` `|`) carrying a statement
    // separator and an inert payload. Under the old command-line channel an equivalent name
    // EXECUTED — measured on `win` with a marker payload, exit 0, no error.
    //
    // The payload creates a file with a RELATIVE name, and `exec` is injected purely to pin
    // the child's cwd to the fixture dir — so if this ever regresses the evidence lands in a
    // temp dir this test already owns, never in the repo. The command, args and stdin are
    // still the real ones the builder produced.
    const { root } = fixture();
    const evil = path.join(root, 'x; New-Item -ItemType File -Name PWNED.txt; #.json');
    fs.writeFileSync(evil, '{}');

    // A refusal would be acceptable too; execution is not. Either way the file must go.
    moveToTrash([evil], 'win32', (command, args, input) => {
      execFileSync(command, args, { cwd: root, ...(input === undefined ? {} : { input }) });
    });

    expect(fs.existsSync(path.join(root, 'PWNED.txt'))).toBe(false);
    // …and being data rather than source is exactly what lets the delete find it at all.
    expect(fs.existsSync(evil)).toBe(false);
  });

  it('survives a legacy console code page — the UTF-8 reset is not decoration', () => {
    // ⚠️ This test exists because the mutation check found the plain "recycles every path"
    // test CANNOT see the `[Console]::InputEncoding` line: this dev box's console is already
    // 65001, so removing the line changes nothing here and the guard looked like dead code.
    // A default en-US (437) or ja-JP (932) box is not, and there the UTF-8 bytes Node writes
    // to stdin are decoded through that page, the path does not match, and the file SILENTLY
    // survives — exit 0, nothing thrown. Measured: CP437 without the reset → survived: true;
    // CP437 then the reset → survived: false.
    //
    // So we reproduce the legacy condition by forcing 437 ahead of the REAL built script. If
    // the shipped script stops resetting the encoding, 437 stands and this goes red.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-trash-cp-'));
    roots.push(root);
    const uni = path.join(root, 'にほんご.json');
    fs.writeFileSync(uni, '{}');

    const { args, input } = trashCommand([uni], 'win32');
    const script = args[args.length - 1];
    execFileSync('powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::InputEncoding = [System.Text.Encoding]::GetEncoding(437); ' + script],
      { input });

    expect(fs.existsSync(uni)).toBe(false);
  });

  it('REPORTS a per-path failure instead of exiting 0 — and still deletes the rest', () => {
    // ⚠️ Close-out review finding. PowerShell treats a .NET exception from the Delete* call as
    // NON-terminating: it writes to stderr, continues the loop, and exits 0. So execFileSync
    // did not throw, moveToTrash returned normally, and `/api/delete-asset` answered `{ok:true}`,
    // unbound the asset in the renderer and rebuilt the manifest — for a file still on disk.
    // That is the same silent-survival shape this fix was written to eliminate, closed for the
    // encoding case and left open for the per-path case.
    //
    // The batch must ALSO keep going: `$ErrorActionPreference='Stop'` would report the failure
    // but abandon every remaining path, turning one bad file into a half-applied delete.
    const { root, files } = fixture();
    const missing = path.join(root, 'never-existed.json');
    const survivor = files[0];
    const alsoDoomed = files[1];

    // ⚠️ It must REPORT the failure without THROWING — a throw aborts the caller's
    // reconciliation for the paths that did go. `/api/delete-asset` then 500s, the manifest is
    // not rebuilt, the renderer is never told, no undo is pushed, and a bound editor re-creates
    // the deleted file at the next save (#186) — for files already in the Recycle Bin. That
    // regression is worse than the silent success it replaced, and an earlier draft shipped it.
    const result = moveToTrash([missing, alsoDoomed]);
    expect(result.failed).toEqual([missing]);
    // …and the good path in the same batch still went.
    expect(fs.existsSync(alsoDoomed)).toBe(false);
    // A wholly-good batch reports nothing failed, or the guard would just break deletes.
    expect(moveToTrash([survivor]).failed).toEqual([]);
    expect(fs.existsSync(survivor)).toBe(false);
  });

  it('names a NON-ASCII failing path readably — the FAILED line is the only place it appears', () => {
    // The thrown/emitted diagnostic is the only place a failing path is named, and without
    // `[Console]::OutputEncoding` it encodes through the OEM code page: `にほんご.json` was
    // measured arriving as `????.json`. Same code-page class as the input side, other direction.
    const { root } = fixture();
    const missingUni = path.join(root, 'にほんご-gone.json');

    const { failed } = moveToTrash([missingUni]);

    expect(failed).toEqual([missingUni]);
    expect(failed[0]).toContain('にほんご');
    expect(failed[0]).not.toContain('?');
  });

  it('keeps the FAILED diagnostic readable under a legacy OUTPUT code page', () => {
    // ⚠️ Sibling of the input-side case above, and it exists for the same reason: the mutation
    // check found the "non-ASCII failing path" test CANNOT see `[Console]::OutputEncoding`,
    // because this box is already 65001. Force 437 ahead of the REAL built script — the script's
    // own reset then overrides it, and removing that reset lets 437 stand.
    // Measured: with the reset → `にほんご-gone-probe.json`; without → `????-gone-probe.json`.
    const missing = path.join(os.tmpdir(), 'にほんご-gone-probe.json');
    const { args, input } = trashCommand([missing], 'win32');
    const script = args[args.length - 1];

    let stderr = '';
    try {
      execFileSync('powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          '[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(437); ' + script],
        { input, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      stderr = String((e as { stderr?: unknown }).stderr ?? '');
    }

    const line = stderr.split('\n').find((l) => l.includes('FAILED')) ?? '';
    expect(line, 'the script must report the failure at all').not.toBe('');
    expect(line).toContain('にほんご');
    expect(line).not.toContain('????');
  });

  it('the built command carries no path on argv, so there is nothing to re-parse', () => {
    // The invariant the two behaviours above rest on, asserted against the real builder.
    const { files, dir } = fixture();
    const { args, input } = trashCommand([...files, dir], 'win32');
    for (const p of [...files, dir]) {
      for (const a of args) expect(a).not.toContain(p);
      expect(input).toContain(p);
    }
  });
});
