/**
 * Persistent main-process log file (both macOS AND Windows).
 *
 * The packaged editor has no terminal attached — a macOS .app launched from Finder
 * and a Windows GUI .exe both send `console.log/error` into the void. So when the
 * editor fails on a user's machine (esp. the class that ends in `app.quit()`), there
 * was previously NO record of why. This tees every console call to a real file in the
 * per-app writable dir so a user can send us the log, and a crash leaves a trail.
 *
 *   macOS:   ~/Library/Application Support/<AppName>/logs/main.log
 *   Windows: %APPDATA%\<AppName>\logs\main.log
 *
 * `app.getPath('userData')` resolves both without a ready-wait, so init can run at the
 * very top of main. Best-effort throughout: a logging failure must NEVER break the
 * editor, so every fs op is guarded and we always still call the original console.
 */

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let stream: fs.WriteStream | null = null;
let logFilePath = '';

/** Absolute path of the active log file (empty until initFileLog runs). */
export function getLogFilePath(): string {
  return logFilePath;
}

/**
 * Append a line to the log file only (does NOT echo to the main-process console) —
 * used to persist the RENDERER's console-message events, which already show in the
 * renderer's own devtools; we just want them in main.log too so a user can send ONE
 * file. No-op until initFileLog has run.
 */
export function logToFile(level: string, message: string): void {
  try { stream?.write(fmt(level, [message])); } catch { /* best-effort */ }
}

function fmt(level: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  const body = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
  return `${ts} [${level}] ${body}\n`;
}

/**
 * Redirect console.{log,info,warn,error} to ALSO append to a log file. Idempotent
 * (a second call is a no-op). Rotates once at startup when the file exceeds ~5 MB
 * (main.log → main.prev.log) so it can't grow unbounded across launches.
 */
export function initFileLog(): string {
  if (stream) return logFilePath;
  let dir = '';
  try {
    dir = path.join(app.getPath('userData'), 'logs');
  } catch {
    dir = path.join(os.tmpdir(), 'modoki-logs'); // pre-app fallback, never /tmp-hardcoded
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, 'main.log');
    // One-shot rotation so the file can't grow without bound.
    try {
      if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > 5 * 1024 * 1024) {
        fs.renameSync(logFilePath, path.join(dir, 'main.prev.log'));
      }
    } catch { /* rotation is best-effort */ }
    stream = fs.createWriteStream(logFilePath, { flags: 'a' });
    stream.on('error', () => { stream = null; }); // stop teeing if the FD dies; console still works
  } catch {
    return ''; // couldn't open a log file — leave console untouched
  }

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const tee = (level: string, fn: (...a: unknown[]) => void) => (...args: unknown[]) => {
    fn(...args);
    try { stream?.write(fmt(level, args)); } catch { /* best-effort */ }
  };
  console.log = tee('info', orig.log);
  console.info = tee('info', orig.info);
  console.warn = tee('warn', orig.warn);
  console.error = tee('error', orig.error);

  // Last-ditch: log an otherwise-silent hard crash before the process dies.
  process.on('uncaughtException', (e) => { try { stream?.write(fmt('fatal', ['uncaughtException', e])); } catch { /* noop */ } });
  process.on('unhandledRejection', (e) => { try { stream?.write(fmt('fatal', ['unhandledRejection', e])); } catch { /* noop */ } });

  orig.log(`[modoki-electron] logging to ${logFilePath}`);
  return logFilePath;
}
