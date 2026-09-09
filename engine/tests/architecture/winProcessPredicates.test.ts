/** Guard: a PowerShell predicate that scopes a process kill to a PATH uses `.StartsWith(…,
 *  OrdinalIgnoreCase)`, never `-like` (#988).
 *
 *  `-like` is a WILDCARD match. A `[`, `]`, `*` or `?` anywhere in the path — all legal on Windows,
 *  and reachable here because both the toolchain dir (`MODOKI_TOOLCHAIN_DIR`) and the app dir sit
 *  under user-influenced roots — is read as a character class and matches NOTHING. The reap then
 *  silently kills nothing, and whatever it existed to unblock fails afterwards.
 *
 *  Measured on Windows PowerShell 5.1 with `E:\dev-temp\a[1]b`: `-like` is **False** for the image
 *  that IS under the dir while `StartsWith` is **True**; a no-bracket control has `-like` **True**,
 *  so the bracket is the cause rather than a broken probe.
 *
 *  ⚠️ **This guard exists because the OLD one was scoped to a single file, and that scope was a
 *  claim.** `packagedAppPaths.test.ts` asserted `not.toContain('ExecutablePath -like')` for
 *  `packagedAppPaths.mjs` alone — while `engine/toolchain/index.ts` carried the identical defect,
 *  for months, with `packagedAppPaths.mjs`'s own comment already documenting why `-like` is wrong.
 *  A rule enforced for the file that was audited and not for the one next to it is exactly the
 *  shape `reapScoping.test.ts` was written for (#69), one subsystem over. So this sweeps the CORPUS.
 *
 *  Scope of the sweep, stated rather than implied: any source that can build a PowerShell command,
 *  plus `.ps1` files themselves — which no guard in this repo could see at all before now
 *  (`reapScoping` matches `.(sh|mjs|js|ts)`, `pathIdentityIsShared` matches `.ts`/`.mjs`). */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments as stripJsComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../..');

/** Every source that could construct a Windows process predicate. Floored well under what is
 *  matched today, so the guard fails loudly if the corpus producer ever silently returns nothing —
 *  a sweep over an empty list passes every assertion. */
function sources(): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under: [path.join(REPO, 'scripts'), path.join(REPO, 'toolchain'), path.join(REPO, 'electron'), path.join(REPO, 'plugins')],
    // ⚠️ **`.sh` is in this set, and leaving it out was the same mistake this guard exists to
    // prevent.** The first version matched `.(mjs|js|ts|ps1)` — four directories minus one
    // extension — and `engine/scripts/lib/repo-reap.sh` was carrying TWO live `-like` process
    // kills the whole time, with the clone root interpolated straight in. A guard written to end a
    // one-file scope shipped with a one-extension scope. `reapScoping.test.ts` already proved `.sh`
    // is scannable.
    match: /\.(mjs|js|ts|ps1|sh)$/,
    floor: 100,
  });
}

/** `.ps1` uses `#` comments; everything else goes through the shared JS/TS scanner (#419).
 *
 *  ⚠️ Stripping matters in BOTH directions here. These files explain this very hazard in prose —
 *  `packagedAppPaths.mjs`'s comment contains the words `-like` and `ExecutablePath` — so an
 *  unstripped scan flags the documentation that exists to prevent the bug. */
function strip(src: string, rel: string): string {
  if (rel.endsWith('.ps1') || rel.endsWith('.sh')) return src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return stripJsComments(src);
}

describe('Windows process predicates are prefix tests, not wildcards (#988)', () => {
  it('the comment scan is sane over every scanned file', () => {
    for (const { rel, abs } of sources()) {
      if (rel.endsWith('.ps1') || rel.endsWith('.sh')) continue;
      const raw = fs.readFileSync(abs, 'utf8');
      assertScanIsSane(raw, stripJsComments(raw), rel);
    }
  });

  it('matches a real corpus — the sweep is not silently empty', () => {
    // A guard over zero files passes everything it asserts. State the contrast rather than a count:
    // the floor is in `sources()`, and this pins that the corpus actually contains each file a
    // real instance of the defect has been found in — one per extension that matters, because
    // "the corpus is big enough" is what let `.sh` sit outside it.
    const rels = sources().map((f) => f.rel);
    expect(rels).toContain('engine/toolchain/index.ts');            // .ts  — #988
    expect(rels).toContain('engine/scripts/packagedAppPaths.mjs');  // .mjs — the original site
    expect(rels).toContain('engine/scripts/lib/repo-reap.sh');      // .sh  — the one the scope missed
    expect(rels).toContain('engine/scripts/uninstall-editor-windows.ps1'); // .ps1 — population of one
  });

  it('no source pairs a process-path property with -like', () => {
    const offenders: string[] = [];
    for (const { rel, abs } of sources()) {
      const src = strip(fs.readFileSync(abs, 'utf8'), rel);
      // `ExecutablePath`/`.Path`/`CommandLine` compared with `-like`, on one line. Deliberately
      // narrow: `-like` against a NAME (`$_.Name -like 'node*'`) is a legitimate use of a wildcard
      // and is none of this guard's business — the defect is specifically a PATH scoped by wildcard.
      for (const line of src.split('\n')) {
        if (/(ExecutablePath|CommandLine|\$_\.Path)\b[^\n]{0,40}-like/.test(line)) {
          offenders.push(`${rel}: ${line.trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders, 'use .StartsWith(dir + sep, OrdinalIgnoreCase) — see this file\'s header').toEqual([]);
  });

  it('the sweep DETECTS the defect it is written for — it is not vacuous', () => {
    // ⚠️ The pattern is checked against the exact string that shipped, because a guard whose regex
    // silently stopped matching would pass forever and look identical to a clean corpus.
    const shipped = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${esc}\\*' }";
    expect(/(ExecutablePath|CommandLine|\$_\.Path)\b[^\n]{0,40}-like/.test(shipped)).toBe(true);
    // …and does not fire on the replacement, nor on a legitimate wildcard over a process NAME.
    const fixed = "$_.ExecutablePath.StartsWith('C:\\tools\\', [System.StringComparison]::OrdinalIgnoreCase)";
    expect(/(ExecutablePath|CommandLine|\$_\.Path)\b[^\n]{0,40}-like/.test(fixed)).toBe(false);
    expect(/(ExecutablePath|CommandLine|\$_\.Path)\b[^\n]{0,40}-like/.test("$_.Name -like 'node*'")).toBe(false);
  });
});
