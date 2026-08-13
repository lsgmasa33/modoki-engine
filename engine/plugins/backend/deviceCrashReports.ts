/**
 * iOS crash / jetsam report triage, host-side via go-ios.
 *
 * ## The gap this closes, stated precisely
 *
 * `device_native_logs` has two sources and NEITHER can explain a crash after the fact:
 * `source:'app'` reads the app's own `OSLogStore`, and the process that would answer is gone;
 * `source:'system'` streams the syslog FORWARD, so it only ever shows what happens after you
 * attach. The device's own `.ips` reports are the backward-looking record — written by the system
 * at the moment of death, kept for days — which makes them the only surface that answers "it
 * crashed while I was at lunch, why".
 *
 * ## Why summarised and not dumped
 *
 * A `JetsamEvent` is a DEVICE-WIDE memory snapshot: 117 KB and 207 processes on the one measured
 * here. Handing that back whole would blow the response budget by two orders of magnitude and bury
 * the four numbers that matter. So the parsing is a real summariser, not a passthrough, and `raw`
 * exists (size-capped) for when the summary genuinely is not enough.
 *
 * ## Report shapes — all three are real, measured on an iPhone 8 / iOS 16.7.16
 *
 * Every `.ips` is a JSON header line followed by a body. The body is JSON for modern reports and
 * plain text for the legacy resource ones, and the header's `bug_type` does not reliably tell you
 * which — so the parser branches on the SHAPE it actually finds, never on the type code:
 *   - **jetsam** (`processes[]`) — who got killed and why (`highwater`, `vm-pageshortage`), how big
 *     everyone was. This is the one that matters for low-end devices: it is how you learn the
 *     WebView was killed at ~1 GB rather than guessing from a black screen.
 *   - **exception** (`exception`/`termination`) — a real crash: type, subtype, termination reason,
 *     and the faulting thread's frames.
 *   - **text** — legacy resource reports (wakeups, cpu_resource): the head of the body.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveGoIos } from './deviceSyslog';

const execFileAsync = promisify(execFile);

/** iOS on 64-bit ARM uses 16 KiB pages, which is what `rpages` counts. Stated as a named constant
 *  because it is an ASSUMPTION, not something the report tells us — jetsam reports carry no
 *  `pageSize` field (checked). Every derived MB figure is labelled so a reader can discount it. */
export const IOS_PAGE_BYTES = 16 * 1024;

/** Cap on a `raw` fetch. A jetsam report is ~117 KB; returning it whole is a response-budget
 *  violation, so raw is truncated with a note rather than refused — a truncated real report beats
 *  a refusal when someone is deliberately reaching past the summary. */
export const RAW_CHARS_MAX = 20_000;

export interface CrashReportRef {
  name: string;
  /** Parsed out of the filename, which is the only date available without fetching the file. */
  when: string | null;
  /** The process the report is ABOUT, from the filename prefix (`App.wakeups_resource-…` → `App`). */
  process: string;
}

/** `<Process>[.<kind>]-<YYYY-MM-DD-HHMMSS>[.NNN].ips`. Pure — the whole point is that a LIST can be
 *  built and filtered without fetching 99 files off the phone. */
export function parseCrashReportName(name: string): CrashReportRef {
  const m = /^(.+?)-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  const head = (m?.[1] ?? name.replace(/\.ips$/, ''));
  return {
    name,
    when: m ? `${m[2]} ${m[3]}:${m[4]}:${m[5]}` : null,
    // Strip the report KIND, keeping the process: `App.wakeups_resource` → `App`,
    // `JetsamEvent` → `JetsamEvent` (device-wide, not about one process).
    process: head.split('.')[0],
  };
}

/** Reports plausibly about `appProcess`, newest first, plus every device-wide jetsam.
 *
 *  ⚠️ Jetsams are INCLUDED even though their filename names no process, and that is the point: a
 *  jetsam is exactly how your app dies without ever writing a report of its own, so filtering
 *  strictly by process name would hide the single most likely cause of a mystery termination on a
 *  low-end device. Whether a given jetsam actually names your app is a question only the BODY can
 *  answer, and the summary reports it. */
export function filterCrashReports(names: string[], appProcess?: string): CrashReportRef[] {
  const refs = names.filter((n) => n.endsWith('.ips')).map(parseCrashReportName);
  const kept = appProcess
    ? refs.filter((r) => r.process === appProcess || r.name.startsWith('JetsamEvent'))
    : refs;
  // Newest first. `when` is a sortable `YYYY-MM-DD HH:MM:SS`; a name we could not parse sorts last
  // rather than being dropped — an unrecognised NAME is not evidence the report is uninteresting.
  return kept.sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''));
}

export interface JetsamSummary {
  kind: 'jetsam';
  when: string | null;
  /** Processes the kernel actually killed, with the reason it gives (`highwater`, `vm-pageshortage`). */
  killed: { name: string; pid?: number; reason: string; mb: number }[];
  /** The biggest resident process at the moment of the kill — often the culprit, not the victim. */
  largest: { name: string; mb: number } | null;
  /** Every entry matching the app we asked about, whether or not it was the one killed. */
  app: { name: string; pid?: number; mb: number; peakMb: number; killed: string | null }[];
  processCount: number;
}

export interface ExceptionSummary {
  kind: 'exception';
  when: string | null;
  process: string | null;
  exception: string;
  termination: string | null;
  /** Faulting-thread frames, symbolicated only as far as the report itself is (usually not at all —
   *  a raw offset is still the difference between "crashed in our code" and "crashed in WebKit"). */
  frames: string[];
}

export interface TextSummary {
  kind: 'text';
  when: string | null;
  process: string | null;
  head: string[];
}

export type CrashSummary = JetsamSummary | ExceptionSummary | TextSummary;

const pagesToMb = (pages: unknown): number =>
  Math.round(((typeof pages === 'number' ? pages : 0) * IOS_PAGE_BYTES) / (1024 * 1024) * 10) / 10;

/**
 * Summarise one `.ips`. Pure, so every branch is testable against real captured reports with no
 * device attached. `appProcess` selects which entries the jetsam branch calls out as "ours".
 */
export function summarizeCrashReport(raw: string, appProcess?: string): CrashSummary {
  const nl = raw.indexOf('\n');
  const headerLine = nl >= 0 ? raw.slice(0, nl) : raw;
  const bodyText = nl >= 0 ? raw.slice(nl + 1) : '';
  let header: Record<string, unknown> = {};
  try { header = JSON.parse(headerLine) as Record<string, unknown>; } catch { /* not our shape */ }
  const when = typeof header.timestamp === 'string' ? header.timestamp : null;
  const headerProc = typeof header.app_name === 'string' ? header.app_name : null;

  let body: Record<string, unknown> | null;
  try { body = JSON.parse(bodyText) as Record<string, unknown>; } catch { body = null; }

  // Branch on SHAPE, never on bug_type — the type code is an opaque number that has meant different
  // things across OS versions, and being wrong about it would mis-parse a real crash silently.
  if (body && Array.isArray(body.processes)) {
    const procs = body.processes as Record<string, unknown>[];
    const killed = procs
      .filter((p) => typeof p.reason === 'string' && p.reason)
      .map((p) => ({ name: String(p.name ?? '?'), pid: typeof p.pid === 'number' ? p.pid : undefined, reason: String(p.reason), mb: pagesToMb(p.rpages) }));
    const biggest = [...procs].sort((a, b) => (Number(b.rpages) || 0) - (Number(a.rpages) || 0))[0];
    const app = appProcess
      ? procs.filter((p) => String(p.name ?? '') === appProcess).map((p) => ({
        name: String(p.name), pid: typeof p.pid === 'number' ? p.pid : undefined,
        mb: pagesToMb(p.rpages), peakMb: pagesToMb(p.lifetimeMax),
        killed: typeof p.reason === 'string' && p.reason ? p.reason : null,
      }))
      : [];
    return {
      kind: 'jetsam', when, killed,
      largest: biggest ? { name: String(biggest.name ?? '?'), mb: pagesToMb(biggest.rpages) } : null,
      app, processCount: procs.length,
    };
  }

  if (body && (body.exception || body.termination)) {
    const exc = (body.exception ?? {}) as Record<string, unknown>;
    const term = (body.termination ?? null) as Record<string, unknown> | null;
    const threads = Array.isArray(body.threads) ? body.threads as Record<string, unknown>[] : [];
    const images = Array.isArray(body.usedImages) ? body.usedImages as Record<string, unknown>[] : [];
    const faulting = threads[Number(body.faultingThread) || 0];
    const rawFrames = Array.isArray(faulting?.frames) ? faulting.frames as Record<string, unknown>[] : [];
    const frames = rawFrames.slice(0, 12).map((f) => {
      const img = images[Number(f.imageIndex)] as Record<string, unknown> | undefined;
      const where = String(img?.name ?? img?.path ?? `image#${String(f.imageIndex)}`);
      return f.symbol ? `${where} ${String(f.symbol)} +${String(f.symbolLocation ?? 0)}` : `${where} +${String(f.imageOffset ?? '?')}`;
    });
    return {
      kind: 'exception', when,
      process: typeof body.procName === 'string' ? body.procName : headerProc,
      exception: [exc.type, exc.subtype, exc.message].filter(Boolean).map(String).join(' · ') || 'unknown',
      termination: term ? [term.namespace, term.indicator, term.code !== undefined ? `code ${String(term.code)}` : null].filter(Boolean).map(String).join(' · ') : null,
      frames,
    };
  }

  return {
    kind: 'text', when, process: headerProc,
    head: bodyText.split('\n').filter((l) => l.trim()).slice(0, 20),
  };
}

function goIosOrThrow(goIos?: string): string {
  const bin = goIos ?? resolveGoIos();
  if (!bin) {
    throw new Error(
      'go-ios is not installed, so device crash reports cannot be read. Install it from the ' +
      "editor's Build Support dialog (iOS Build Support → go-ios), or set MODOKI_GO_IOS.");
  }
  return bin;
}

/** Filenames of every crash report on the device. */
export async function listCrashReports(opts: { udid: string; goIos?: string }): Promise<string[]> {
  const bin = goIosOrThrow(opts.goIos);
  const { stdout } = await execFileAsync(bin, ['crash', 'ls', `--udid=${opts.udid}`], { maxBuffer: 8 << 20 });
  // go-ios prints one JSON object per line; the listing is the one carrying `files`.
  for (const line of stdout.split('\n')) {
    try {
      const o = JSON.parse(line) as { files?: unknown };
      if (Array.isArray(o.files)) return o.files.map(String);
    } catch { /* a status line */ }
  }
  return [];
}

/** Copy ONE report off the device and return its text. Cleans up the temp copy. */
export async function fetchCrashReport(opts: { udid: string; name: string; goIos?: string }): Promise<string> {
  const bin = goIosOrThrow(opts.goIos);
  // Refuse a name that could escape the temp dir or turn into a glob that copies the whole store.
  // The name comes from an agent, and `crash cp` takes a PATTERN — `*` here would be a 10 MB pull.
  // Also reject a LEADING dash: `execFile` takes an argv array so there is no shell to inject into,
  // but `crash cp` still parses its own flags, and a name like `--udid` would be consumed as one
  // rather than treated as the report to copy.
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(opts.name)) throw new Error(`invalid crash report name: ${opts.name}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-crash-'));
  try {
    await execFileAsync(bin, ['crash', 'cp', opts.name, dir, `--udid=${opts.udid}`], { maxBuffer: 8 << 20 });
    const file = path.join(dir, opts.name);
    if (!fs.existsSync(file)) throw new Error(`crash report '${opts.name}' was not found on the device`);
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
