/** Type sidecar for subprocessText.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** Subprocess output → lines with NO carriage return left in any of them.
 *
 *  Splits on `\r\n`, `\n` **and a lone `\r`**, then `trimEnd()`s each line, so the postcondition is
 *  the one every `$`-anchored pattern downstream needs: no returned line contains a `\r`. The lone
 *  `\r` counts because `ps` prints a process's own argv — a CR mid-argument makes an end-anchored
 *  capture drop the row WHOLESALE, pid included.
 *
 *  The trailing empty entry from a final terminator is dropped, and only that one: `'a\n\nb\n'` is
 *  three lines, `'\r\n'` is one (an empty line, then its terminator), `''` is none. */
export declare function outputLines(out: string | null | undefined): string[];

/** One `ps -Ao pid=,<col>=` row: the pid, and whatever the second column held. */
export interface PidRow {
  pid: number;
  /** The second column, verbatim — an executable path, a full argv, anything. May contain spaces. */
  rest: string;
}

/** `ps -Ao pid=,<col>=` text → one entry per parsable row, unparsable rows dropped (a header or a
 *  blank tail is not an error). The regex lives here once for all three `ps` callers in
 *  `engine/scripts/**`. */
export declare function parsePidRows(out: string | null | undefined): PidRow[];
