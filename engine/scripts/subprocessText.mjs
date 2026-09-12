/**
 * TEXT THAT CAME BACK FROM A SUBPROCESS — normalised once, at the boundary.
 *
 * `docs/windows.md` § Line endings argues for exactly this and names the alternative as the
 * defect: *"Normalize once, at the boundary"*, with the note that three separate places in the
 * Android diagnostics knowing about line endings is "two too many". This module is that boundary
 * for `engine/scripts/**` and its callers.
 *
 * ── WHY IT MATTERS, AND WHY IT FAILS SILENTLY ─────────────────────────────────────────────
 * `\r` is a JS line terminator. So `.` never matches it and `$` (without `/m`) will not match
 * before it — which means an end-anchored capture applied to a CRLF line fails on EVERY line and
 * returns `null`/`[]` rather than throwing. That is how `parseLogcatLine` made
 * `device_crash_reports` answer *"no crashes"* about a phone that had just crashed (fixed in
 * `5fb7f3b1`; the `trimEnd()` in `engine/plugins/backend/deviceAndroidDiag.ts` is load-bearing and
 * commented as such, and stays where it is — a different layer, already correct).
 *
 * ── THE INVARIANT THIS MODULE EXISTS TO STATE OUT LOUD (#1118) ────────────────────────────
 * Three `ps` parsers carried `parseLogcatLine`'s exact shape and were correct only because a
 * `win32` branch returned before them — an invariant living in another part of the control flow,
 * written down NOWHERE. One of them (`livePackagedEditor.mjs`) disagreed with itself: its Windows
 * half split `/\r?\n/` while its POSIX half split `'\n'`, one function with two opposite
 * assumptions about the same hazard and no comment reconciling them.
 *
 * ⚠️ Nothing here was ever OBSERVED failing, and with those `win32` branches in place it could not
 * be. The point is that the sites were one edit away from reachable, and that the normalisation is
 * cheaper than the invariant.
 */

/**
 * Subprocess output → lines with NO carriage return left anywhere in them.
 *
 * A LONE `\r` is treated as a line terminator too, not just `\r\n`. That is deliberate and it is
 * what makes the postcondition statable: **no line this function returns can contain a `\r`**,
 * which is precisely the property every `$`-anchored pattern downstream depends on. Splitting only
 * on `/\r?\n/` would leave a mid-line CR intact — and `ps` prints a process's own argv, so a
 * process launched with a CR in an argument yields a row that an end-anchored capture drops
 * WHOLESALE. Breaking it at the CR instead costs the tail of one exotic row; keeping it costs the
 * pid as well, which is the half the callers need.
 *
 * The trailing empty entry from a final terminator is dropped — exactly that one, not every blank
 * line, because a blank line in the MIDDLE can be a record separator. So `'a\n\nb\n'` gives three
 * entries and `'\r\n'` gives ONE (an empty line, then its terminator) while `''` gives none: a
 * caller reading `.length` as "did we get anything" should know 1 is possible for output that is
 * nothing but a terminator.
 *
 * The `trimEnd()` is NOT redundant with the split: the split removes every `\r`, and the trim then
 * removes trailing spaces and tabs, which break a shape-sensitive consumer in exactly the same way.
 * The sibling this change fixed in `games/court/tests/changedLevels.ts` turns on
 * `.endsWith('.court.json')` — defeated by a trailing space as thoroughly as by a `\r`.
 *
 * @param {string|null|undefined} out Raw captured stdout/stderr. Nullish → `[]`.
 * @returns {string[]} Lines, each `trimEnd()`ed.
 */
export function outputLines(out) {
  if (out === null || out === undefined) return [];
  const lines = String(out).split(/\r\n|\n|\r/).map((l) => l.trimEnd());
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * `ps -Ao pid=,<col>=` text → `[{ pid, rest }]`, one entry per parsable row.
 *
 * All three `ps` call sites in `engine/scripts/**` parse this same shape with the same
 * `/^\s*(\d+)\s+(.*)$/`, so the regex lives ONCE here rather than three times there (#1118 asked
 * for one change, not three copies of a `trimEnd`). Unparsable rows are dropped, which is what
 * every caller already did — a `ps` header or a blank tail is not an error.
 *
 * ⚠️ The `(.*)$` capture is safe ONLY because `outputLines` guarantees no line contains a `\r`.
 * That is the invariant the three sites previously leaned on a `win32` early-return for, without
 * saying so anywhere.
 *
 * ⚠️ It deliberately does NOT live in either CLI that uses it. `stopDevServer.mjs` runs its main on
 * import (it is a script, not a module), so a test importing it to reach the parse would try to
 * STOP THIS CLONE'S DEV SERVER — measured while building this change: importing it printed "No dev
 * server running for this repo — nothing to stop", which is the harmless branch of a
 * side-effect-on-import that would otherwise have killed a running editor mid-gate.
 *
 * @param {string|null|undefined} out Raw `ps` stdout.
 * @returns {{pid: number, rest: string}[]}
 */
export function parsePidRows(out) {
  const rows = [];
  for (const line of outputLines(out)) {
    // ⚠️ The second column is OPTIONAL, and that is not cosmetic. `livePackagedEditor.mjs` states
    // the policy for its win32 twin explicitly — a row whose column is empty "is one this user
    // cannot open — unknown, not 'not an editor'", so it is kept with an empty value and "still
    // counts toward 'we enumerated something'", because the caller DELETES editor state and an
    // empty list read as "nothing is live" wipes a live app's data. A `\s+(.*)` here dropped such a
    // row on POSIX while win32 kept it (the `trimEnd()` removes the separating space, so `\s+` no
    // longer matches) — an asymmetry against a written invariant, found in review. `ps` on this Mac
    // emits no such row today, so this is the invariant, not a live bug.
    const m = line.match(/^\s*(\d+)(?:\s+(.*))?$/);
    if (m) rows.push({ pid: Number(m[1]), rest: m[2] ?? '' });
  }
  return rows;
}

/**
 * ── THE SIBLING CONCERN, AND WHY IT IS NOT IN HERE ────────────────────────────────────────
 *
 * #1118 asked whether one normalisation seam could cover both this module and
 * `joinCapturedStreams` in `nativePluginLegs.mjs`, which protects a `^`-anchored pattern from a
 * GLUED stream boundary (stdout ending mid-line, stderr beginning immediately). **The answer is
 * no, and the reason is in that function's own docblock:** it says it lives there *"next to the
 * patterns, because it exists only to protect them"* — three of `networkFailureCause`'s four
 * patterns are `^`-anchored, and the gradle wrapper's `java.net.*Exception` is only ever the first
 * stderr line, so a glued boundary classifies a network failure as a compile FAIL where it should
 * SKIP. Relocating it here would move the code away from the patterns that give it its reason to
 * exist and leave that reason behind.
 *
 * ⚠️ The two rules are also OPPOSITE, which is the deeper reason not to merge them:
 * `joinCapturedStreams` deliberately PRESERVES `\r\n` (its tests assert that — the text it returns
 * is written to the console as well as classified, so anything already terminated must come back
 * byte-identical), while `outputLines` normalises it away. One helper doing both would have to
 * take a flag, and a flag is how two callers end up on the wrong side of it.
 *
 * So: two functions, two files, one cross-reference each. If a THIRD line-ending concern appears,
 * revisit — but do not unify these two just because both say "\r".
 */
