/** A build stream's log, shaped for the answer (#1900, docs/mcp-tool-conventions.md § response budgets).
 *
 *  The backend sends each stdout/stderr pipe CHUNK as one `message` frame, not one line, so "the last 40 messages" had
 *  no size at all: one web build's Vite asset listing was a single 60,535-char frame, and the answer came to 72,902
 *  chars — over the 60k cap, so it arrived as a `TOO_LARGE` envelope whose preview read `log: "array(40)"`, which says
 *  nothing about the build. So the answer carries a bounded TAIL of LINES, the count of all of them, and the path of a
 *  file holding the whole log for the part the tail cut. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capLogText, LOG_LINE_CHARS } from '../../shared/logAnswer.js';

/** Lines of the tail. The end of a build log is where its verdict and its error are. */
export const BUILD_TAIL_LINES = 30;
/** One line's cap — the shared one every log answer uses (`shared/logAnswer.ts`, #1903). */
export const BUILD_LINE_CHARS = LOG_LINE_CHARS;

// ESC [ … final byte — the colour codes a build tool writes even into a pipe.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Every non-blank line of `chunks`, colour codes stripped. */
export function buildLogLines(chunks: readonly string[]): string[] {
  return chunks.join('\n').replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

/** The last `maxLines` of `lines`, each cut to `lineChars` with the count of what was cut. */
export function buildLogTail(lines: readonly string[], maxLines = BUILD_TAIL_LINES, lineChars = BUILD_LINE_CHARS): string[] {
  return lines.slice(-maxLines).map((l) => capLogText(l, lineChars));
}

const LOG_PREFIX = 'modoki-build-';
/** A day: a build is rare and its log is read after the fact, unlike a capture read at once. */
const LOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Write the whole log to the OS temp dir — on THIS machine, where the agent that asked can read it, whichever machine
 *  the backend runs on — and sweep this prefix's logs older than a day. Null if the write fails: the tail still
 *  answers, and a failed write must never turn a finished build into a failed call. */
export function writeBuildLog(chunks: readonly string[], label: string, dir = os.tmpdir(), now = Date.now()): string | null {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(LOG_PREFIX)) continue;
      const file = path.join(dir, name);
      try { if (fs.statSync(file).mtimeMs < now - LOG_TTL_MS) fs.unlinkSync(file); } catch { /* raced/gone */ }
    }
  } catch { /* an unreadable temp dir only skips the sweep */ }
  const file = path.join(dir, `${LOG_PREFIX}${label.replace(/[^a-z0-9-]+/gi, '-')}-${now}.log`);
  try {
    fs.writeFileSync(file, chunks.join('\n').replace(ANSI_RE, '') + '\n');
    return file;
  } catch {
    return null;
  }
}
