/** A `$`-anchored capture applied to a line that still carries a `\r` fails on EVERY line, and
 *  returns `null`/`[]` rather than throwing (#1118).
 *
 *  That is how `parseLogcatLine` made `device_crash_reports` answer *"no crashes"* about a phone
 *  that had just crashed (fixed in `5fb7f3b1`). Three `ps` parsers in `engine/scripts/**` carried
 *  the same shape and were safe only because a `win32` branch returned before them — an invariant
 *  living in another part of the control flow, written down nowhere. One function
 *  (`livePackagedEditor.mjs`) disagreed with itself about it: Windows half `/\r?\n/`, POSIX half
 *  `'\n'`.
 *
 *  Two halves here:
 *  1. **Unit** — `outputLines` / `parsePidRows` / `joinPidColumns` on CRLF, a lone CR, and LF, so
 *     the parses that were previously unreachable by any test have one.
 *  2. **A corpus guard** — the SHAPE cannot come back in a new call site. It is deliberately
 *     narrow: see the docblock on `crFragileLineParses` for what it can and cannot see.
 */
import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { outputLines, parsePidRows } from '../../scripts/subprocessText.mjs';
import { joinPidColumns } from '../../scripts/livePackagedEditor.mjs';

/** This file spells the offending shapes as fixtures, in literals that survive the comment strip. */
const SELF = 'engine/tests/architecture/subprocessLineEndings.test.ts';

/**
 * Find `\r`-fragile line parses: a line taken from a BARE `'\n'` split and then matched against an
 * end-anchored pattern whose `$` is reached directly by a capture.
 *
 * ⚠️ **Deliberately narrow, and heuristic — here is exactly what it does NOT see.** Whether a
 * string came from a subprocess is a data-flow question no regex can answer, and the file-level
 * approximations were measured before choosing this one: `spawn + bare split + any $-anchor`
 * matches **14** files in this corpus, 11 of them false positives (an end-anchored regex on a FILE
 * PATH, e.g. `/\.json$/`), which would force an 11-entry allowlist — and an allowlisted guard rots
 * (this repo has a whole `family/derived-corpus` for that). So this one keys on the SHAPE instead:
 * the split's own element meeting a `)$`-style capture. It therefore cannot see a parse whose split
 * and match are far apart, or one that goes through an intermediate variable.
 *
 * ACCEPTED on purpose (all three are correct, and all three appear in this corpus):
 * `\s*$` before the anchor — `\s` matches `\r`, so the anchor is reached either way;
 * a `.trim()`/`.trimEnd()` on the line before the match; and splitting on `/\r?\n/` or through
 * `outputLines`, which is the fix this guard is pointing at.
 */
// ⚠️ THE REJECTED ALTERNATIVE, WITH THE EXACT QUERY. Recorded as line comments (not in the JSDoc
// above) because one of these regexes ends in `[a-z]*` followed by a slash, which closes a block
// comment — the first version of this note did exactly that and would not parse.
//
// A reviewer could not reproduce the prose version's count from six plausible spellings, so here is
// the query. On the PRE-FIX tree, over `git ls-files engine/scripts engine/tools engine/plugins
// engine/electron scripts` filtered to /\.(mjs|cjs|js|ts|tsx)$/ and minus /dist/, a FILE-LEVEL
// conjunction of all three of:
//     SPAWN   = /\b(execFileSync|execSync|spawnSync|execFile|spawn|exec)\s*\(/
//     SPLIT_N = /\.split\(\s*['"]\\n['"]\s*\)/
//     ENDANCH = /\/[^/\n]*\$\/(?![a-z]*m)[a-z]*/
// matched 14 files, of which 2 carried an unprotected defect (livePackagedEditor.mjs,
// stopDevServer.mjs) and 12 did not — end-anchored regexes on FILE PATHS, or parses already
// protected by a trimEnd() (deviceAndroidDiag.ts). Re-run on the FIXED tree it matches 12, all
// false, because the two real ones no longer split on a bare newline. Quote the figure with the
// tree it was taken on; it moves when the fix lands.
export function crFragileLineParses(code: string): string[] {
  const ITER = /(?:for\s*\(\s*const\s+(\w+)\s+of\s+[^;]*?\.split\(\s*['"]\\n['"]\s*\)|\.split\(\s*['"]\\n['"]\s*\)\s*\.(?:map|filter|forEach|flatMap)\(\s*\(?\s*(\w+)\s*\)?\s*=>)/g;
  // An end-anchored regex literal, no /m flag, whose `$` is preceded by a capture close rather
  // than by `\s*` (which would absorb the CR).
  const ENDANCH = /\/[^/\n]*\)\$\/(?![a-z]*m)[a-z]*/g;
  const out: string[] = [];
  for (const m of code.matchAll(ITER)) {
    const v = m[1] ?? m[2];
    if (!v) continue;
    const tail = code.slice(m.index! + m[0].length, m.index! + m[0].length + 900);
    for (const rm of tail.matchAll(ENDANCH)) {
      const seg = tail.slice(Math.max(0, rm.index! - 90), rm.index! + rm[0].length + 90);
      const used = new RegExp(`\\b${v}\\s*\\.\\s*match\\s*\\(`).test(seg) || new RegExp(`exec\\(\\s*${v}\\b`).test(seg);
      const trimmed = new RegExp(`\\b${v}\\s*\\.\\s*trim(End)?\\(\\)`).test(seg);
      if (used && !trimmed) { out.push(rm[0]); break; }
    }
  }
  return out;
}

describe('outputLines — no line it returns can contain a \\r (#1118)', () => {
  it('strips CRLF, and the trailing terminator produces no empty tail entry', () => {
    expect(outputLines('  1 a\r\n 22 b\r\n')).toEqual(['  1 a', ' 22 b']);
    expect(outputLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('treats a LONE \\r as a terminator too — that is what makes the postcondition hold', () => {
    // `ps` prints a process's own argv, so a CR can arrive MID-line. Splitting only on /\r?\n/
    // would leave it in place and an end-anchored capture would drop the whole row, pid included.
    expect(outputLines('a\rb')).toEqual(['a', 'b']);
    expect(outputLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
    for (const line of outputLines('x\ry\r\nz')) expect(line).not.toContain('\r');
  });

  it('keeps a blank line in the MIDDLE — only the trailing empty is dropped', () => {
    expect(outputLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('trims trailing WHITESPACE too, not only the \\r — the `endsWith` hazard is the same class', () => {
    // The split alone already removes every `\r`, so this assertion is what makes `trimEnd()`
    // load-bearing rather than decoration: a trailing SPACE or TAB breaks a shape-sensitive
    // consumer exactly the way a `\r` does. That is not hypothetical — the sibling this sweep found
    // in `games/court/tests/changedLevels.ts` fails on `.endsWith('.court.json')`, which a trailing
    // space defeats just as thoroughly. Written after a mutation deleting `trimEnd()` left all 11
    // cases green.
    expect(outputLines('a/b.json   \n')).toEqual(['a/b.json']);
    expect(outputLines('x\t\r\ny  ')).toEqual(['x', 'y']);
    for (const line of outputLines('p.json \r\nq.json\t\n')) expect(line.endsWith('.json')).toBe(true);
  });

  it('nullish and empty are [], and a lone terminator is ONE empty line', () => {
    expect(outputLines(undefined)).toEqual([]);
    expect(outputLines(null)).toEqual([]);
    expect(outputLines('')).toEqual([]);
    // `'\r\n'` is an empty line FOLLOWED by a terminator, so one entry survives: only the
    // terminator's own empty tail is dropped, never a line that was really there. Asserted
    // because I first wrote `[]` here and the code was right — a caller reading `.length` as
    // "did we get anything" needs to know 1 is possible for output that is all terminator.
    expect(outputLines('\r\n')).toEqual(['']);
    expect(outputLines('\n\n')).toEqual(['', '']);
  });
});

describe('parsePidRows — the ps row shape, parsed in one place (#1118)', () => {
  it('parses CRLF rows identically to LF rows — this is what returned [] before', () => {
    const lf = parsePidRows('  10 /bin/vite --x\n  22 node foo\n');
    expect(parsePidRows('  10 /bin/vite --x\r\n  22 node foo\r\n')).toEqual(lf);
    expect(lf).toEqual([{ pid: 10, rest: '/bin/vite --x' }, { pid: 22, rest: 'node foo' }]);
  });

  it('keeps a command containing SPACES intact — the macOS `ps -Ao comm=` case', () => {
    expect(parsePidRows('  7 /Applications/My App.app/Contents/MacOS/My App\r\n'))
      .toEqual([{ pid: 7, rest: '/Applications/My App.app/Contents/MacOS/My App' }]);
  });

  it('drops unparsable rows rather than throwing — a header or blank tail is not an error', () => {
    expect(parsePidRows('  PID COMMAND\r\n  9 x\r\n\r\n')).toEqual([{ pid: 9, rest: 'x' }]);
  });

  it('KEEPS a row whose second column is empty — the caller deletes things on an empty list', () => {
    // `livePackagedEditor.mjs` states this policy for its win32 twin: a row with no value is
    // "unknown, not 'not an editor'", kept so it "still counts toward 'we enumerated something'",
    // because its caller DELETES editor state and an empty list read as "nothing is live" wipes a
    // live app's data. A `\s+(.*)` capture dropped such a row on POSIX while win32 kept it — the
    // `trimEnd()` takes the separating space away, so `\s+` stops matching. Found in review.
    expect(parsePidRows('  10 \n  11 x\n')).toEqual([{ pid: 10, rest: '' }, { pid: 11, rest: 'x' }]);
    expect(parsePidRows('  10\n')).toEqual([{ pid: 10, rest: '' }]);
  });
});

describe('joinPidColumns — two ps captures joined by pid (#1118)', () => {
  it('joins across CRLF, and a pid missing from the second capture keeps an empty command', () => {
    // Two separate `ps` invocations, so churn between them is normal: the pid must survive.
    expect(joinPidColumns('  7 /a/b\r\n  8 /c/d\r\n', '  7 /a/b --flag\r\n')).toEqual([
      { pid: 7, exe: '/a/b', command: '/a/b --flag' },
      { pid: 8, exe: '/c/d', command: '' },
    ]);
  });
});

describe('the SHAPE cannot come back — corpus guard (#1118)', () => {
  it('flags the three forms that actually shipped', () => {
    // The exact text of the three sites this issue fixed.
    expect(crFragileLineParses(`for (const line of out.split('\\n')) {\n  const m = line.match(/^\\s*(\\d+)\\s+(.*)$/);\n}`)).toHaveLength(1);
    expect(crFragileLineParses(`out.split('\\n').map((line) => {\n  const m = line.match(/^\\s*(\\d+)\\s+(.*)$/);\n})`)).toHaveLength(1);
    expect(crFragileLineParses(`for (const l of x.split("\\n")) {\n  const kv = /^([a-z]+):\\s*(.*)$/.exec(l);\n}`)).toHaveLength(1);
  });

  it('ACCEPTS the three correct forms — this guard must not read as "no $ anchors anywhere"', () => {
    // `\s*` absorbs the CR, so the anchor is reached either way.
    expect(crFragileLineParses(`for (const line of out.split('\\n')) {\n  const m = line.match(/^##\\s+(.+?)\\s*$/);\n}`)).toEqual([]);
    // trimmed before the match.
    expect(crFragileLineParses(`for (const line of out.split('\\n')) {\n  const m = line.trimEnd().match(/^(\\d+)\\s+(.*)$/);\n}`)).toEqual([]);
    // split on /\r?\n/ — no bare-'\n' split to key on at all.
    expect(crFragileLineParses(`for (const line of out.split(/\\r?\\n/)) {\n  const m = line.match(/^\\s*(\\d+)\\s+(.*)$/);\n}`)).toEqual([]);
    // and the fix this guard points at.
    expect(crFragileLineParses(`for (const line of outputLines(out)) {\n  const m = line.match(/^\\s*(\\d+)\\s+(.*)$/);\n}`)).toEqual([]);
  });

  it('no file in the tooling corpus carries the shape', () => {
    const files = repoFiles({
      under: ['engine/scripts', 'engine/tests', 'engine/tools', 'engine/plugins', 'engine/electron', 'scripts', 'games', 'demos'],
      match: /\.(mjs|cjs|js|ts|tsx)$/,
      exclude: ['node_modules', 'dist'],
      floor: 200,
    });
    expect(files.length, 'corpus collapsed — the scan below would pass vacuously').toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const { rel, abs } of files) {
      if (rel === SELF) continue;
      const { code } = readScannedSource(abs);
      for (const pat of crFragileLineParses(code)) offenders.push(`${rel} — ${pat}`);
    }
    expect(offenders, 'a line from a bare `\'\\n\'` split must not meet an end-anchored capture: '
      + 'split through `outputLines` (engine/scripts/subprocessText.mjs), or on /\\r?\\n/, or trim '
      + 'the line first. `\\r` is a JS line terminator, so the capture fails on EVERY line and '
      + 'returns null — silently. ⚠️ BUT NOT IF THE FILE ROUND-TRIPS THE TEXT: where lines are '
      + 'split, edited and rejoined back to disk (healNativeConfig.ts does this to a pbxproj, and '
      + '*.pbxproj is not eol-pinned), a bare split is LOAD-BEARING — it preserves the file\'s CRLF '
      + 'on a Windows clone, and every remedy above would rewrite the whole file\'s line endings. '
      + 'Normalise a COPY for the comparison there, and keep writing the original lines.').toEqual([]);
  });
});
