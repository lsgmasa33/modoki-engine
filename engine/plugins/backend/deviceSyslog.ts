/**
 * Host-side iOS SYSTEM log capture, via go-ios over usbmuxd.
 *
 * ## Why this exists next to a native-logs path that already works
 *
 * `device_native_logs` reads `OSLogStore(scope: .currentProcessIdentifier)` INSIDE the app
 * (`GameDebugPlugin.swift`). That is the right default — it is precise, needs no host tooling, and
 * covers iOS 15+. But its scope is exactly its limit: it only ever sees **this process's** logs,
 * and only while the app is running with the debug bridge attached. Three questions it therefore
 * cannot answer at all:
 *   - why did the app CRASH (the process that would have answered is gone)
 *   - what happened during LAUNCH, before the bridge connected
 *   - what did the SYSTEM say about us (jetsam/OOM kills, watchdog terminations, sandbox denials)
 *     — none of which are emitted by our process
 *
 * This module answers those by reading the device's own syslog from the HOST, so the app need not
 * be running, or installed, or reachable.
 *
 * ## ⚠️ It streams FORWARD. That is not the same question the app path answers.
 *
 * `OSLogStore` is a QUERY over stored logs: "the last N seconds", looking backward. `ios syslog` is
 * a STREAM: it delivers what the device logs from the moment it attaches. So a system capture
 * cannot show you a crash that already happened — you attach, then reproduce. Conflating the two
 * would be the worst kind of tooling lie, since both return plausible-looking log lines either way,
 * so `seconds` means "capture for this long" here and "look back this far" there, and the MCP tool
 * says so in the text an agent actually reads.
 *
 * (For a crash that ALREADY happened, the device keeps `.ips` reports — `ios crash ls|cp`. Not
 * wired up here; it is a different surface, not a flag on this one.)
 *
 * ## No lease, no claim — deliberately
 *
 * This talks to the phone over USB, not through the app's debug bridge, so it needs no lease. That
 * is the whole point: the motivating case is an app that has just died, which is precisely when the
 * lease is gone. It takes no `~/.modoki/device-claims.json` claim either, matching the rule
 * `deviceClaims.ts` already states for `adb shell` — a claim governs the debug LEASE, not read-only
 * access to the hardware.
 */
import { spawn } from 'node:child_process';
import { detect as detectTool } from '../../toolchain';

/** Hard ceiling on a capture, whatever the caller asks for. A syslog stream is a firehose and this
 *  runs inside a backend request, so an unbounded `seconds` is a hung editor route. */
export const MAX_CAPTURE_SECONDS = 60;
/** Default capture window. Deliberately SHORTER than the app path's 60s default: that one is a
 *  backward query and costs nothing to widen, while this one is wall-clock the caller waits out. */
export const DEFAULT_CAPTURE_SECONDS = 10;

export interface SyslogCapture {
  lines: string[];
  /** How long we actually streamed, in seconds — the caller asked for it, but it is clamped. */
  capturedFor: number;
  /** Lines matched the filter but fell out of the `limit` ring buffer. */
  truncated: boolean;
}

/** Where go-ios is, or null. Shared with the build path's resolution (env → toolchain → PATH), so a
 *  tool provisioned by a build is immediately usable here and vice versa. */
export function resolveGoIos(): string | null {
  const d = detectTool('go-ios');
  return d.present ? (d.command ?? d.path ?? null) : null;
}

/** go-ios emits one JSON object per line, `{"msg":"Aug 13 16:58:54 iPhone8 proc(sub)[pid] <Notice>: …"}`.
 *  Pure so the parsing is testable without a phone. A line that is not our JSON shape is passed
 *  through verbatim rather than dropped: go-ios also writes its own `{"level":"WARN",…}` diagnostics
 *  to stderr, and silently swallowing an unrecognised line is how a real error becomes an empty
 *  result that reads as "the device logged nothing". */
export function parseSyslogLine(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t) as unknown;
    if (o && typeof o === 'object' && typeof (o as { msg?: unknown }).msg === 'string') return (o as { msg: string }).msg;
    // Only an OBJECT can be a go-ios status line. A device line that happens to parse as a JSON
    // primitive (`null`, `123`, a bare quoted word) is device output, and dropping it would be the
    // silent-swallow this function exists to avoid.
    if (o && typeof o === 'object') return null;
    return t;
  } catch {
    return t;
  }
}

/**
 * Stream the device syslog for `seconds`, returning the last `limit` lines that match `filter`.
 *
 * Rejects with a message naming the fix when go-ios is absent. Never throws for an empty capture —
 * "the device logged nothing matching that in N seconds" is a real answer, and the caller
 * distinguishes it from failure by the absence of an error, not by an empty array.
 */
export function captureIosSyslog(opts: {
  udid: string;
  seconds?: number;
  limit?: number;
  filter?: string;
  /** Injectable for tests — defaults to the resolved go-ios. */
  goIos?: string;
}): Promise<SyslogCapture> {
  const bin = opts.goIos ?? resolveGoIos();
  if (!bin) {
    return Promise.reject(new Error(
      'go-ios is not installed, so the device syslog cannot be read. Install it from the editor\'s ' +
      'Build Support dialog (iOS Build Support → go-ios), or set MODOKI_GO_IOS to the binary.'));
  }
  // `Math.max(1, NaN)` is NaN, not 1 — so a non-numeric value off the HTTP body would sail through
  // and disable the cap entirely (`ring.length > NaN` is always false, i.e. unbounded growth while
  // `truncated` still reads false). Coerce through a finite check rather than trusting the types:
  // the wire is untyped.
  const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const seconds = Math.min(Math.max(1, Math.floor(num(opts.seconds, DEFAULT_CAPTURE_SECONDS))), MAX_CAPTURE_SECONDS);
  const limit = Math.max(1, Math.floor(num(opts.limit, 50)));
  const needle = opts.filter?.toLowerCase();

  return new Promise<SyslogCapture>((resolve, reject) => {
    const child = spawn(bin, ['syslog', `--udid=${opts.udid}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ring: string[] = [];
    let truncated = false;
    let pending = '';
    let settled = false;
    let stderrTail = '';

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // DETACH before killing. SIGTERM is not synchronous with exit (measured: `ios syslog` takes
      // ~200ms to go), and until it does, buffered stdout keeps arriving — into the very array we
      // are about to hand out. Left attached, a caller that awaits anything between receiving the
      // result and reading `.lines` could watch its contents change, with `truncated` (a primitive,
      // copied at resolve) still claiming nothing was dropped. Hand out a COPY for the same reason.
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      // Kill the stream — this process outlives the request otherwise, and a leaked `ios syslog`
      // holds a usbmuxd channel open for as long as the editor lives. SIGTERM suffices: measured on
      // go-ios 1.3.2, the process exits ~200ms after it, so no SIGKILL escalation is warranted.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (err) reject(err);
      else resolve({ lines: [...ring], capturedFor: seconds, truncated });
    };

    const timer = setTimeout(() => finish(), seconds * 1000);

    child.stdout.on('data', (buf: Buffer) => {
      pending += buf.toString();
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const raw of parts) {
        const msg = parseSyslogLine(raw);
        if (msg === null) continue;
        if (needle && !msg.toLowerCase().includes(needle)) continue;
        ring.push(msg);
        if (ring.length > limit) { ring.shift(); truncated = true; }
      }
    });
    child.stderr.on('data', (buf: Buffer) => { stderrTail = (stderrTail + buf.toString()).slice(-2000); });

    // A spawn failure (binary vanished mid-flight) and an early exit are different shapes of the
    // same answer — the capture never happened — and both must reject rather than resolve empty.
    child.on('error', (e) => finish(new Error(`could not run go-ios syslog: ${e.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      finish(new Error(
        `go-ios syslog exited early (code ${code}) — is the device attached and unlocked?` +
        (stderrTail ? `\n${stderrTail.trim()}` : '')));
    });
  });
}
