/** A console `level` is a THRESHOLD — "this severity or worse" — on every tool that takes one (#1559):
 *  `get_console_logs`, `device_console_logs` and `wait_for`'s console condition. The journals already
 *  read `level` that way (`journal.ts`'s `LEVEL_RANK`), and the console tools used to read it as an
 *  EXACT match — so `level:'warn'` hid the errors, and one parameter name meant two things across the
 *  surface. The two console tools did not even agree with each other: the editor folded `info` into
 *  `log`, the device kept it apart, so `level:'log'` returned different lines on each.
 *
 *  `log` and `info` rank together: nothing a caller could want separates them, and the editor-side
 *  readers already fold `info` into `log`. Owner decision, 2026-09-25. */

import { EPOCH_BASE, SINCE_CURSOR_BASE } from './sinceCursor.js';

export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

const RANK: Record<ConsoleLevel, number> = { log: 0, info: 0, warn: 1, error: 2 };

export function isConsoleLevel(v: unknown): v is ConsoleLevel {
  return typeof v === 'string' && (CONSOLE_LEVELS as readonly string[]).includes(v);
}

/** Does an entry at `entryLevel` pass a `threshold` filter? An unrecognised entry level ranks as `log`. */
export function atConsoleLevel(entryLevel: string, threshold: ConsoleLevel): boolean {
  return (RANK[entryLevel as ConsoleLevel] ?? 0) >= RANK[threshold];
}

/** The console-read params, described ONCE for both twins (`modoki_get_console_logs`,
 *  `device_console_logs`) — two copies of these sentences are how the twins drifted (#1559 C-4). */
export const CONSOLE_LOGS_PARAM_DOCS = {
  level: 'A THRESHOLD: this level or worse (warn = warn + error; log = info).',
  limit: 'How many matching entries (default 50): the newest N bare, the oldest N after a since cursor. Pass a large one for the whole ring.',
  since: `${SINCE_CURSOR_BASE}, oldest first; pass back nextSeq with epoch. A timestamp is refused (that is sinceMs).`,
  epoch: `${EPOCH_BASE}.`,
  sinceMs: 'Only entries logged after this epoch-ms instant. Not with since.',
} as const;

/** The reply, described once for both twins. */
export const CONSOLE_LOGS_REPLY_DOC =
  'RETURNS {logs:[{seq, level, ts, text}], returnedCount, totalCount, ringTotal, byLevel, dropped, nextSeq, epoch}: ' +
  '`returnedCount` is what came back, `totalCount` what MATCHED level=/since=/sinceMs=, and `ringTotal`+`byLevel` ' +
  'describe the WHOLE ring regardless of the filter. A bare read is the NEWEST 50; a since= read pages OLDEST-first ' +
  'from the cursor, so polling with since=<nextSeq> and epoch=<epoch> never skips a line. `cursorReset` (a sentence) ' +
  'means the ring restarted (a reload) and the read began again at the start.';
