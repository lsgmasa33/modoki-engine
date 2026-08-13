/**
 * Android host-side diagnostics — the `adb` twin of `deviceSyslog.ts` + `deviceCrashReports.ts`.
 *
 * Same motivation: the in-app log path needs the app alive and the debug lease attached, so it can
 * never explain a crash, a launch failure, or a kill the system performed. adb reads the device's
 * own ring buffers, so it needs neither.
 *
 * ## ⚠️ The direction is OPPOSITE to iOS, and that is not a wart to hide
 *
 * `ios syslog` is a forward STREAM — you attach, then reproduce. `adb logcat -d` DUMPS a ring
 * buffer that is already full of the past, so on Android `source:'system'` looks BACKWARD and needs
 * no capture window at all. That makes Android strictly better at post-hoc questions, and it means
 * `seconds` (the iOS capture window) is meaningless here: what bounds an Android read is `limit`.
 * Papering over that to make one tool "consistent" would cost the platform its main advantage and
 * make an agent wait ten seconds for logs it already has.
 *
 * ## The two buffers that matter, and the iOS surfaces they correspond to
 *
 *   - `-b crash` ↔ an `.ips` exception report. Java/Kotlin `FATAL EXCEPTION` with the stack, plus
 *     the header lines of native tombstones.
 *   - `-b events` ↔ a `JetsamEvent`. `am_kill` / `am_proc_died` record the ACTIVITY MANAGER killing
 *     a process, with its oom_adj and a reason (`empty #34`, `cached`, …). This is how an Android
 *     app dies without writing a crash of its own — the exact role jetsam plays on iOS, and the
 *     reason both are surfaced by `device_crash_reports` rather than only the crash buffer.
 *
 * Deliberately NOT `adb bugreport`: tens of MB and a minute-plus to generate, for a superset almost
 * none of which answers "why did my app die". Tombstone FILES under `/data/tombstones` need root on
 * a production device, so the crash buffer's copy of their header is what we can actually read.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adbBinary, adbArgs } from './androidDevices';

const execFileAsync = promisify(execFile);

/** Bounded like every other device shell-out. A `logcat -d` dump is a local read of a ring buffer
 *  (~200ms measured); the ceiling is for a wedged adb daemon. */
const ADB_TIMEOUT_MS = 15_000;
/** adb's own cap on lines pulled per buffer, before our filtering. Generous — the filtering is what
 *  makes the result small, and a tail that stops short of the event you want is worse than useless. */
const LOGCAT_TAIL = 4000;
/** Ceiling on lines RETURNED, whatever `limit` asks for. `LOGCAT_TAIL` bounds what we read off the
 *  phone, not what we hand back: at ~100 chars a threadtime line, returning all 4000 is ~400 KB —
 *  roughly 7x the 60,000-char response budget in docs/debug-tools-mcp.md, un-truncated, straight
 *  into an agent's context. A caller asking for more than this gets the cap and is TOLD (`clamped`),
 *  the same no-silent-caps rule the listings follow. */
export const MAX_RETURNED_LINES = 400;

async function adb(serial: string | undefined, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(adbBinary(), adbArgs(serial, args), {
    timeout: ADB_TIMEOUT_MS, maxBuffer: 32 << 20,
  });
  return stdout;
}

/** A `logcat -v threadtime` line: `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message`. Pure.
 *
 *  ⚠️ The `trimEnd` is load-bearing on WINDOWS, where adb hands back CRLF: `\r` is a JS line
 *  terminator, so `.` does not match it and the trailing `(.*)$` fails — the whole regex misses and
 *  EVERY line parses as null. That is not a cosmetic wart: `parseCrashBuffer` then returns `[]` and
 *  `device_crash_reports` answers "no crashes" about a phone that just crashed, which is the worst
 *  answer a diagnostic can give. Caught by the Windows CI leg (2026-08-13), never by a Mac run. */
export function parseLogcatLine(line: string): { when: string; pid: number; tag: string; text: string } | null {
  const m = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]*):\s?(.*)$/.exec(line.trimEnd());
  if (!m) return null;
  return { when: m[1], pid: Number(m[2]), tag: m[5].trim(), text: m[6] };
}

export interface AndroidCrash {
  kind: 'crash';
  when: string;
  process: string | null;
  pid: number | null;
  exception: string;
  frames: string[];
}

/**
 * Parse `adb logcat -b crash -d` into one record per FATAL EXCEPTION.
 *
 * Pure, and tested against a REAL crash forced on a Galaxy S22 rather than a hand-written sample —
 * the risk in a log parser is being wrong about the format, and a fixture I invented would agree
 * with my mistake.
 */
export function parseCrashBuffer(out: string): AndroidCrash[] {
  const crashes: AndroidCrash[] = [];
  let cur: AndroidCrash | null = null;
  for (const raw of out.split('\n')) {
    const p = parseLogcatLine(raw);
    if (!p || p.tag !== 'AndroidRuntime') continue;
    if (p.text.startsWith('FATAL EXCEPTION')) {
      // A second FATAL closes the first — the buffer holds many, oldest first.
      if (cur) crashes.push(cur);
      cur = { kind: 'crash', when: p.when, process: null, pid: p.pid, exception: '', frames: [] };
      continue;
    }
    if (!cur) continue;
    const proc = /^Process:\s*([^,]+),\s*PID:\s*(\d+)/.exec(p.text);
    if (proc) { cur.process = proc[1]; cur.pid = Number(proc[2]); continue; }
    if (p.text.startsWith('at ') || p.text.startsWith('\tat ')) {
      if (cur.frames.length < 12) cur.frames.push(p.text.trim());
      continue;
    }
    // The first non-Process, non-frame line after FATAL is the exception itself; later ones are
    // `Caused by:` chains, which are kept because that is usually where the real cause is named.
    if (!cur.exception) cur.exception = p.text;
    else if (p.text.startsWith('Caused by:') && cur.frames.length < 12) cur.frames.push(p.text);
  }
  if (cur) crashes.push(cur);
  return crashes.reverse();   // newest first, matching every other listing here
}

export interface AndroidKill {
  kind: 'kill';
  when: string;
  process: string;
  pid: number;
  /** oom_adj at kill time — 0 is foreground, higher is more expendable. */
  adj: number | null;
  /** The activity manager's own words: `empty #34`, `cached`, `excessive cpu`, … */
  reason: string | null;
}

/**
 * Parse `am_kill` / `am_proc_died` out of `adb logcat -b events -d`.
 *
 *   `am_kill : [userId, pid, processName, oomAdj, reason]`
 *   `am_proc_died: [userId, pid, processName, oomAdj, …]`
 *
 * `am_kill` is the interesting one (it carries the REASON); `am_proc_died` is kept only for a
 * process that has no matching kill, so a death that the activity manager did not attribute still
 * shows up rather than vanishing.
 */
export function parseKillEvents(out: string): AndroidKill[] {
  const kills: AndroidKill[] = [];
  // Keyed by pid AND process, never pid alone. Android RECYCLES pids, and a 4000-line logcat tail
  // can span hours — so a bare pid set makes an `am_kill` of com.foo swallow a LATER, unrelated
  // `am_proc_died` of com.bar that happened to reuse the number. The death of the very app you are
  // diagnosing then reads as "no kill happened", which is the worst answer a diagnostic can give.
  const killedKeys = new Set<string>();
  const died: AndroidKill[] = [];
  for (const raw of out.split('\n')) {
    const p = parseLogcatLine(raw);
    if (!p) continue;
    const m = /^\[(\d+),(\d+),([^,\]]+),(-?\d+)(?:,([^\]]*))?\]/.exec(p.text.trim());
    if (!m) continue;
    const rec: AndroidKill = {
      kind: 'kill', when: p.when, process: m[3], pid: Number(m[2]),
      adj: Number.isFinite(Number(m[4])) ? Number(m[4]) : null,
      reason: null,
    };
    if (p.tag === 'am_kill') {
      // The reason is the LAST field and may itself contain commas (`empty #34`), so take the tail
      // rather than a fixed index.
      rec.reason = (m[5] ?? '').split(',').pop()?.trim() || null;
      kills.push(rec);
      killedKeys.add(`${rec.pid}|${rec.process}`);
    } else if (p.tag === 'am_proc_died') {
      died.push(rec);
    }
  }
  const orphanDeaths = died.filter((d) => !killedKeys.has(`${d.pid}|${d.process}`));
  // ⚠️ logcat timestamps carry NO YEAR (`MM-DD HH:MM:SS.mmm`), so this string sort mis-orders a
  // window that spans New Year: `01-01` sorts BEFORE `12-31`. Left as-is deliberately — inferring
  // the year would need a clock read, which the determinism rules keep out of here, and the window
  // is a ring buffer that would have to span midnight on Dec 31 for it to bite. Stated so the next
  // reader does not have to re-derive that it is known rather than missed.
  return [...kills, ...orphanDeaths]
    .sort((a, b) => b.when.localeCompare(a.when));
}

export type AndroidDiagRecord = AndroidCrash | AndroidKill;

/** Keep only what concerns `pkg`. A kill of ANOTHER process is not noise-free context here the way
 *  a jetsam is on iOS: an iOS jetsam is ONE device-wide event that names every process, while an
 *  `am_kill` names exactly one — so filtering by package is safe and leaves nothing implicit. */
export function filterAndroidDiag(records: AndroidDiagRecord[], pkg?: string): AndroidDiagRecord[] {
  if (!pkg) return records;
  // `<pkg>:sub` counts for BOTH kinds. A Capacitor game's WebView runs in its own
  // `:sandboxed_process`, so an OutOfMemoryError thrown in the renderer is filed under
  // `com.x:webview` — and that crash is the one that actually takes the screen black. An earlier
  // revision applied this to kills only, which silently hid exactly the crash most worth seeing.
  // A crash whose `Process:` line we could not parse has `process: null` and is dropped here: it
  // cannot be attributed, and a filtered view is a claim about ONE app. `all:true` is the way to
  // see those.
  return records.filter((r) => r.process != null && (r.process === pkg || r.process.startsWith(`${pkg}:`)));
}

/** Recent crashes + activity-manager kills, newest first. */
export async function readAndroidDiagnostics(opts: { serial?: string; pkg?: string; limit?: number }): Promise<{
  records: AndroidDiagRecord[]; totalSeen: number; matched: number;
}> {
  const [crashOut, eventOut] = await Promise.all([
    adb(opts.serial, ['logcat', '-b', 'crash', '-d', '-v', 'threadtime', '-t', String(LOGCAT_TAIL)]),
    adb(opts.serial, ['logcat', '-b', 'events', '-d', '-v', 'threadtime', '-t', String(LOGCAT_TAIL)]),
  ]);
  const all: AndroidDiagRecord[] = [...parseCrashBuffer(crashOut), ...parseKillEvents(eventOut)]
    .sort((a, b) => b.when.localeCompare(a.when));
  const matched = filterAndroidDiag(all, opts.pkg);
  const asked = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.floor(Number(opts.limit))) : 20;
  const limit = Math.min(asked, MAX_RETURNED_LINES);
  return {
    records: matched.slice(0, limit),
    totalSeen: all.length, matched: matched.length,
  };
}

/**
 * Host-side system log — the Android half of `device_native_logs source:'system'`.
 *
 * BACKWARD, unlike its iOS twin: this dumps a ring buffer that already holds the past, so there is
 * no capture window and nothing to wait for.
 */
export async function readAndroidSystemLog(opts: { serial?: string; limit?: number; filter?: string }): Promise<{
  lines: string[]; clamped: boolean;
}> {
  const out = await adb(opts.serial, ['logcat', '-d', '-v', 'threadtime', '-t', String(LOGCAT_TAIL)]);
  const needle = opts.filter?.toLowerCase();
  const lines = out.split('\n').map((l) => l.trimEnd()).filter(Boolean)
    .filter((l) => !needle || l.toLowerCase().includes(needle));
  // The wire is untyped, so a non-numeric `limit` must not become NaN and disable the bound (the
  // same trap deviceSyslog documents).
  const asked = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.floor(Number(opts.limit))) : 50;
  const limit = Math.min(asked, MAX_RETURNED_LINES);
  return { lines: lines.slice(-limit), clamped: asked > limit };   // the TAIL: the most recent matching lines
}
