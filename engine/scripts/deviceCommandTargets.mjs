/**
 * Pure parser: "which physical device(s) does this shell command target, and
 * would it disturb them?" (#285). Backs a Claude Code PreToolUse hook that
 * refuses a raw CLI call against a phone another clone has claimed — see the
 * device-claim machinery in `docs/debug-tools-mcp.md` § "Several phones
 * attached". This module does NOT read the claim file or process.env; it only
 * classifies a command string. The hook layer cross-references `ids` against
 * `~/.modoki/device-claims.json` separately.
 *
 * PURE by design: no fs, no child_process, no `process.env` reads. The one
 * "environment" rule below (`ANDROID_SERIAL=`) is parsed OUT OF THE STRING
 * itself (a literal `KEY=VALUE` token in the command), never out of the
 * running process's actual environment — a hook evaluating a command string
 * has no business asking what env var values apply at execution time, and
 * doing so would make this function's result depend on where it runs.
 *
 * This is a `.mjs` (with a `.d.mts` sidecar) to match `projectRoots.mjs` —
 * plain Node/JS so it can be required from a hook script with no build step.
 */

/** Strip one layer of matching single/double quotes off a token, if present. */
function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Last path segment of a (possibly quoted) token — resolves `/opt/homebrew/bin/adb` to `adb`.
 *
 *  Also normalises two spellings that name the same binary and were each measured slipping past this
 *  guard entirely:
 *   - a trailing `.exe` — the `win` clone runs these tools as `adb.exe`, and `device.mjs`'s own
 *     `resolveAdbBin()` produces exactly that name on Windows, so the guard would have been blind on
 *     a platform where everything else about it works;
 *   - a leading backslash — `\adb` is the routine way to bypass a shell alias or function, so it is
 *     a spelling a real caller reaches for, not a contrived one.
 *  Backslash is also accepted as a path separator here, for Windows paths. */
function basenameOf(token) {
  const s = stripQuotes(token).replace(/^\\+/, '');
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1].replace(/\.exe$/i, '');
}

/**
 * Split on shell whitespace while keeping single/double-quoted spans intact
 * as one token (so `-destination 'platform=iOS,id=X'` stays two tokens, not
 * four). Not a real shell tokenizer — doesn't handle escaped quotes/backslash
 * continuations — but the brief only calls for "regex/tokenising", not a
 * full parser, and every value this module needs to read (serials, UDIDs,
 * `-destination` specs) fits this.
 */
function tokenize(segment) {
  return segment.match(/'[^']*'|"[^"]*"|\S+/g) || [];
}

/**
 * Find the value of the first flag in `flagNames` present in `tokens`, in
 * either `--flag VALUE` or `--flag=VALUE` form (quotes stripped). Returns
 * null if none of the flags appear.
 */
function findFlagValue(tokens, flagNames) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (const flag of flagNames) {
      if (t === flag) {
        if (i + 1 < tokens.length) return stripQuotes(tokens[i + 1]);
      } else if (t.startsWith(flag + '=')) {
        return stripQuotes(t.slice(flag.length + 1));
      }
    }
  }
  return null;
}

/** The all-empty result — a segment that names none of the recognised device CLIs. */
function empty() {
  return { ids: [], destructive: false, untargeted: false, tools: [] };
}

/**
 * Build a segment result from an id list + a destructive verdict.
 *
 * `untargeted` falls out of the other two on purpose rather than being
 * threaded through every call site: a segment can only "disturb a device
 * without saying which one" when it IS disturbing a device (destructive)
 * AND no id was extracted. A read-only call is never untargeted (rule 5:
 * "adb devices and other read-only calls must NOT set untargeted") and a
 * destructive call WITH an id is targeted by definition — both fall out of
 * `destructive && ids.length === 0` with no separate bookkeeping.
 */
function finalize(ids, destructive, tool) {
  return { ids, destructive, untargeted: destructive && ids.length === 0, tools: [tool] };
}

// ---- adb -------------------------------------------------------------

const ADB_TOP_DESTRUCTIVE = new Set(['install', 'uninstall', 'push', 'reboot', 'root', 'unroot', 'emu']);
// start-server/kill-server are explicitly carved out by rule 5 ("neither
// destructive nor untargeted") — they manage the adb daemon, not a device.
const ADB_TOP_READONLY = new Set([
  'devices', 'pull', 'bugreport', 'get-state', 'wait-for-device', 'start-server', 'kill-server',
  // No device is involved at all: `version`/`help` print and exit, `keygen` writes a LOCAL adb key
  // file. Listed for the same reason as ADB_TRANSPORT below — without them the fail-safe default
  // refuses them as `untargeted` and tells the caller to add `-s <serial>`, which none of the three
  // accepts. Found by the close-out sweep for the `adb connect` fix, by asking the parser directly
  // which subcommands come back untargeted.
  'version', 'help', 'keygen',
]);

/** TRANSPORT verbs: they attach/detach the local adb daemon to a device, and address it as
 *  `HOST:PORT` — `adb connect 192.0.2.10:5555`. Same carve-out as start-server/kill-server:
 *  daemon management, not device or app state.
 *
 *  ⚠️ These MUST be listed, because the fail-safe default cannot be right for them. An
 *  unrecognised verb is treated as destructive with no id, i.e. `untargeted`, and the refusal
 *  says "say which one: `adb -s <serial> …`" — advice `connect` STRUCTURALLY CANNOT TAKE. There
 *  is no `-s` form: the address IS the target. So the guard refused a command that had no way to
 *  satisfy it, and the only ways past were to bypass the hook or to stop using wireless adb.
 *  Hit for real setting up wireless debugging on the S22 for the Windows clone (2026-08-22).
 *
 *  They are NOT destructive in this guard's sense — nothing on the phone changes — so they do not
 *  require a claim. What follows a connect does: `adb -s 192.0.2.10:5555 install …` is parsed
 *  by the normal path, with the host:port as the serial, and is refused exactly like a USB one.
 *
 *  ⚠️ A wireless device is claimed under a DIFFERENT id than the same phone on USB
 *  (`adb:192.0.2.10:5555` vs `adb:RFTESTSERIAL1`), and claims are per-MACHINE anyway — so a
 *  wirelessly-shared phone is outside what #149/#285 can serialise. That is a real gap in the
 *  rule, not something this list creates; see docs/devices.md. */
const ADB_TRANSPORT = new Set(['connect', 'disconnect', 'pair']);

// Sub-verbs of `adb shell <cmd>` that mutate device/app state. Matched with a
// trailing `\s` (or `\b` for single-word ones) so "am " doesn't also match a
// package name that happens to contain "am" as a substring.
const ADB_SHELL_DESTRUCTIVE_PATTERNS = [
  /\bam\s/, // activity manager: force-stop, start, broadcast, ...
  /\bpm\s/, // package manager: install/uninstall/clear/grant, ...
  /\binput\s/, // synthetic input injection (tap/text/keyevent)
  /\bsvc\s/, // system service control (wifi/data/power)
  /settings\s+put\b/, // settings PUT mutates; settings GET does not
  /\brm\s/, // file deletion
  /\bmonkey\b/, // UI stress fuzzer
  /\bstop\b/, // stop a running app/service
  /\bstart\b/, // start an activity/service
  /\bsetprop\b/, // mutate a system property
  /\bcontent\s/, // content-provider insert/update/delete
];

function isReadonlyAdbShell(shellRest) {
  if (/^getprop\b/.test(shellRest)) return true;
  // "dumpsys (no set)" — dumpsys itself only reads; some services accept a
  // trailing `set` sub-verb (e.g. `dumpsys battery set level N`) which does
  // mutate, so exclude that rather than blanket-allowing all of dumpsys.
  if (/^dumpsys\b/.test(shellRest) && !/\bset\b/.test(shellRest)) return true;
  if (/^ls\b/.test(shellRest)) return true;
  if (/^cat\b/.test(shellRest)) return true;
  if (/^screencap\b/.test(shellRest)) return true; // "screencap+redirect is NOT destructive"
  return false;
}

function analyzeAdb(restTokens, envVars) {
  const serial = findFlagValue(restTokens, ['-s']) || envVars.ANDROID_SERIAL || envVars.MODOKI_ANDROID_SERIAL || null;
  const ids = serial ? [`adb:${serial}`] : [];

  // Drop `-s VALUE` (and `-s=VALUE`) from the token stream so the first
  // remaining token is the actual subcommand, not the serial.
  const subTokens = [];
  for (let i = 0; i < restTokens.length; i++) {
    const t = restTokens[i];
    if (t === '-s') {
      i++; // also skip its value
      continue;
    }
    if (t.startsWith('-s=')) continue;
    subTokens.push(t);
  }

  if (subTokens.length === 0) {
    // Bare `adb` (or `adb -s X` with nothing else) — nothing to disturb.
    return { ids, destructive: false, untargeted: false, tools: ['adb'] };
  }

  const sub = subTokens[0];

  if (sub === 'forward' && subTokens[1] === '--list') return finalize(ids, false, 'adb');

  if (sub === 'logcat') {
    // Only `-c` (clear) mutates the device's log buffer; `-d` (dump) and a
    // bare `logcat` just stream/read it.
    const clears = subTokens.includes('-c');
    return finalize(ids, clears, 'adb');
  }

  if (sub === 'shell') {
    const shellRest = subTokens.slice(1).map(stripQuotes).join(' ');
    if (ADB_SHELL_DESTRUCTIVE_PATTERNS.some((p) => p.test(shellRest))) return finalize(ids, true, 'adb');
    if (isReadonlyAdbShell(shellRest)) return finalize(ids, false, 'adb');
    // An `adb shell` verb we don't recognise — fail SAFE (destructive) rather
    // than silently permit an unknown mutation. See the module-level note on
    // rule 4's fail-safe default; the same reasoning applies here.
    return finalize(ids, true, 'adb');
  }

  if (ADB_TOP_DESTRUCTIVE.has(sub)) return finalize(ids, true, 'adb');
  if (ADB_TOP_READONLY.has(sub)) return finalize(ids, false, 'adb');
  if (ADB_TRANSPORT.has(sub)) return finalize(ids, false, 'adb');

  // Unrecognised adb subcommand: fail SAFE. A hook that refuses an unknown
  // command is an annoyance; one that silently permits an unknown mutation
  // against a claimed device is the bug this module exists to prevent.
  return finalize(ids, true, 'adb');
}

// ---- devicectl ---------------------------------------------------------

const DEVICECTL_DESTRUCTIVE_PATTERNS = [
  /\bdevice\s+install\b/,
  /\bdevice\s+uninstall\b/,
  /\bdevice\s+process\s+launch\b/,
  /\bdevice\s+process\s+terminate\b/,
  /\bdevice\s+copy\s+to\b/,
  /\bdevice\s+reboot\b/,
];
const DEVICECTL_READONLY_PATTERNS = [/\bdevice\s+info\b/, /\blist\s+devices\b/];

function analyzeDevicectl(restTokens) {
  const udid = findFlagValue(restTokens, ['--device']);
  const ids = udid ? [`ios:${udid}`] : [];
  const text = restTokens.map(stripQuotes).join(' ');
  if (DEVICECTL_DESTRUCTIVE_PATTERNS.some((p) => p.test(text))) return finalize(ids, true, 'devicectl');
  if (DEVICECTL_READONLY_PATTERNS.some((p) => p.test(text))) return finalize(ids, false, 'devicectl');
  return finalize(ids, true, 'devicectl'); // fail-safe: unrecognised devicectl verb
}

// ---- ideviceinstaller ----------------------------------------------------

function analyzeIdeviceinstaller(restTokens) {
  const udid = findFlagValue(restTokens, ['-u', '--udid']);
  const ids = udid ? [`ios:${udid}`] : [];
  const words = restTokens.map(stripQuotes);
  if (words.includes('install') || words.includes('-i') || words.includes('uninstall') || words.includes('-U')) {
    return finalize(ids, true, 'ideviceinstaller');
  }
  if (words.includes('-l') || words.includes('list')) return finalize(ids, false, 'ideviceinstaller');
  return finalize(ids, true, 'ideviceinstaller'); // fail-safe: unrecognised verb
}

// ---- go-ios (`ios`) ------------------------------------------------------

const GOIOS_DESTRUCTIVE = new Set(['install', 'uninstall', 'launch', 'kill', 'reboot']);
const GOIOS_READONLY = new Set(['info', 'list', 'ps']);

function analyzeGoIos(restTokens) {
  const udid = findFlagValue(restTokens, ['--udid']);
  const ids = udid ? [`ios:${udid}`] : [];
  const words = restTokens.map(stripQuotes);
  const sub = words[0];
  if (sub && GOIOS_DESTRUCTIVE.has(sub)) return finalize(ids, true, 'go-ios');
  if (sub && GOIOS_READONLY.has(sub)) return finalize(ids, false, 'go-ios');
  return finalize(ids, true, 'go-ios'); // fail-safe: unrecognised/missing verb
}

// ---- xcodebuild ------------------------------------------------------

function analyzeXcodebuild(restTokens) {
  const destIdx = restTokens.findIndex((t) => t === '-destination' || t.startsWith('-destination='));
  if (destIdx === -1) {
    // No `-destination` at all contributes NOTHING — deliberately the one place this module does
    // not fail safe, because here failing safe is the more expensive mistake. Xcode's default
    // destination can in principle be a plugged-in phone, but the destination-less invocations that
    // actually occur are `xcodebuild -list`, `clean`, `-showBuildSettings` and simulator builds —
    // all harmless, all frequent. Refusing them would produce a stream of device refusals on
    // commands that touch no device, and a guard that cries wolf is one the next agent learns to
    // route around, which costs more than the narrow case it would catch. Modoki's own iOS build
    // path always passes an explicit `-destination` (see docs/build.md), so the device-touching
    // invocations we care about are covered by the branch below.
    return empty();
  }
  const destToken = restTokens[destIdx];
  const spec = stripQuotes(destToken.startsWith('-destination=') ? destToken.slice('-destination='.length) : restTokens[destIdx + 1] || '');

  // A simulator or macOS destination is not a PHYSICAL device at all — the
  // whole point of this module — so it contributes nothing: no id, no
  // destructive/untargeted flags, and (deliberately) no 'xcodebuild' tool
  // entry either, since this invocation never touches the hardware this
  // module cares about.
  if (spec.includes('platform=iOS Simulator') || spec.includes('platform=macOS')) return empty();

  const idMatch = /(?:^|,)\s*id=([^,]+)/.exec(spec);
  const ids = idMatch ? [`ios:${idMatch[1].trim()}`] : [];
  // Any destination naming a real (non-simulator/macOS) device builds,
  // installs, and runs on it — always destructive, `id=` or not; an id-less
  // physical destination is additionally untargeted (finalize's formula).
  return finalize(ids, true, 'xcodebuild');
}

// ---- segment dispatch -----------------------------------------------

/** Leading `KEY=VALUE` env assignments before the command word, e.g. `ANDROID_SERIAL=X adb …`. */
const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|\S+)(?:\s+|$)/;

function analyzeSegment(rawSegment) {
  const segment = rawSegment.trim();
  if (!segment) return empty();

  let rest = segment;
  const envVars = {};
  for (;;) {
    const m = ENV_ASSIGN_RE.exec(rest);
    if (!m) break;
    envVars[m[1]] = stripQuotes(m[2]);
    rest = rest.slice(m[0].length);
  }

  const tokens = tokenize(rest);
  if (tokens.length === 0) return empty();
  return analyzeSegmentTokens(tokens, envVars);
}

/** Launchers that simply run the rest of the segment as a command, taking no options that could be
 *  confused for one. `xcrun devicectl …` is the familiar one; the rest are ordinary shell usage. */
const PLAIN_LAUNCHERS = new Set(['xcrun', 'command', 'nohup', 'exec', 'time', 'stdbuf', 'builtin']);

/** Launchers whose OWN options sit between them and the command word, so those have to be stepped
 *  over before the command word can be read. The regex per tool lists the options that consume a
 *  following VALUE — miss one and its value gets mistaken for the command. */
const OPTION_LAUNCHERS = {
  sudo: /^(-u|--user|-g|--group|-p|--prompt|-C|--close-from|-h|--host|-R|--chroot|-U|--other-user|-T|--command-timeout)$/,
  doas: /^(-u|-C)$/,
  env: /^(-u|--unset|-C|--chdir|-S|--split-string)$/,
  nice: /^(-n|--adjustment)$/,
  xargs: /^(-n|--max-args|-I|--replace|-P|--max-procs|-d|--delimiter|-L|--max-lines|-s|--max-chars|-E|-e|--eof)$/,
};

function analyzeSegmentTokens(tokens, envVars) {
  let idx = 0;
  let first = basenameOf(tokens[idx]);
  // Strip LAUNCHER words until the real command word is in hand.
  //
  // Matching only the bare tool name was a hole big enough to drive the original incident straight
  // through: `sudo adb -s X uninstall …`, `env ANDROID_SERIAL=X adb …`, `nice adb …` and
  // `… | xargs adb …` are all functionally identical to the command this guard refuses, and every
  // one of them was measured silently ALLOWED — the segment just failed to look like a device
  // command and fell through. Two independent reviewers found this within minutes of each other,
  // which is about how long it would have taken to find by accident in real use. A guard with a
  // one-word bypass is not a guard; it is a speed bump.
  //
  // `sudo`/`env` get their own option grammars rather than blanket flag-skipping because both accept
  // `KEY=VALUE` assignments before the command — and for `env` that is exactly how a serial arrives
  // (`env ANDROID_SERIAL=… adb install`), so those assignments must be COLLECTED, not skipped, or a
  // precisely-targeted command reads as untargeted.
  //
  // Bounded so a pathological string cannot spin here; no real command nests launchers eight deep.
  for (let hop = 0; hop < 8; hop++) {
    const valueOpts = OPTION_LAUNCHERS[first];
    if (PLAIN_LAUNCHERS.has(first)) {
      idx++;
    } else if (valueOpts) {
      idx++;
      while (idx < tokens.length) {
        const t = stripQuotes(tokens[idx]);
        if (t.startsWith('-') && t !== '-') { idx += valueOpts.test(t) ? 2 : 1; continue; }
        const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(t);
        if (assigned) { envVars[assigned[1]] = stripQuotes(assigned[2]); idx++; continue; }
        break;
      }
    } else {
      break;
    }
    if (idx >= tokens.length) return empty();
    first = basenameOf(tokens[idx]);
  }

  // `bash -c "<command>"` and friends: the quoted argument IS a command, so parse it as one.
  // Termination is guaranteed by the string shrinking on every hop (a `-c` value is a strict
  // substring of the segment holding it); a wrapper with no `-c` has nothing to parse.
  if (SHELL_WRAPPERS.has(first)) {
    const inner = findFlagValue(tokens.slice(idx + 1), ['-c']);
    return inner ? parseDeviceCommand(inner) : empty();
  }

  // Declared without an initialiser: every branch below either assigns or returns, so a `= null`
  // here would be a value nothing can read (eslint `no-useless-assignment`).
  let tool;
  if (first === 'adb') tool = 'adb';
  else if (first === 'devicectl') tool = 'devicectl';
  else if (first === 'xcodebuild') tool = 'xcodebuild';
  else if (first === 'ideviceinstaller') tool = 'ideviceinstaller';
  // Bare `ios` as the COMMAND WORD is go-ios — checked only at this position
  // (never scanning the rest of the segment) so `echo ios` or a path
  // component named `ios` is never mistaken for the go-ios CLI.
  else if (first === 'ios') tool = 'go-ios';
  else return empty();

  const restTokens = tokens.slice(idx + 1);
  switch (tool) {
    case 'adb':
      return analyzeAdb(restTokens, envVars);
    case 'devicectl':
      return analyzeDevicectl(restTokens);
    case 'ideviceinstaller':
      return analyzeIdeviceinstaller(restTokens);
    case 'go-ios':
      return analyzeGoIos(restTokens);
    case 'xcodebuild':
      return analyzeXcodebuild(restTokens);
    default:
      return empty();
  }
}

/** Split a command into the sub-commands a shell would actually run, on `;`, `&&`, `||`, `|` and
 *  newlines — but ONLY where those characters are not inside quotes.
 *
 *  Quote-awareness is not a nicety here, it is the difference between a guard and a nuisance. A
 *  naive split cuts inside a quoted argument, and the tail of the cut then LOOKS like a command:
 *  a segment such as `foo "cd /tmp && <a device command>"` splits into a second segment that
 *  BEGINS with that device command and is refused — even though the shell runs `foo` and touches no
 *  device at all. Measured the moment this hook went live: it refused the very command that was
 *  testing it, and then refused the patch fixing it, because both merely CONTAINED device-command
 *  text. Anything that writes about a device command through Bash — a heredoc, a test fixture, a
 *  doc example — hits this.
 *
 *  Over-refusal is the safe direction for an unknown VERB (see the fail-safe default below), but it
 *  is the wrong direction for an unknown COMMAND POSITION: a guard that fires on text rather than on
 *  execution trains its reader to route around it, and a routed-around guard protects nothing. */
/** Remove heredoc BODIES before splitting.
 *
 *  A heredoc body is data being written, not commands being run — but it is newline-separated text
 *  sitting inside a command string, so the segment splitter treats every line of it as a
 *  sub-command. A script that WRITES a device command (a doc example, a test fixture, a shell script
 *  being generated) therefore reads as a script that RUNS one, and is refused. That is not
 *  hypothetical: it blocked two consecutive attempts to write this very module's tests, and writing
 *  files through `cat <<EOF` is routine for the agents this guard runs in front of.
 *
 *  Deliberately coarse — it finds `<<`/`<<-` plus a delimiter and drops through the terminator line,
 *  without modelling expansion, nesting or `<<<` here-strings. The cost of getting it wrong is
 *  symmetrical and small: an unterminated heredoc swallows the rest of the string (a command that
 *  was going to fail anyway), and a missed one merely falls through to the old over-refusal. */
function stripHeredocBodies(command) {
  const lines = command.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    // `<< EOF`, `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` — the quotes only control expansion, which
    // is irrelevant here: either way the body is data.
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!m) continue;
    const delimiter = m[2];
    // Skip the body, and the terminator line with it: neither is a command.
    i++;
    while (i < lines.length && lines[i].trim() !== delimiter) i++;
  }
  return out.join('\n');
}

function splitSegments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      // A backslash-escaped quote inside a double-quoted span does not close it. Single-quoted
      // spans have no escapes at all, per POSIX.
      if (ch === quote && !(quote === '"' && command[i - 1] === '\\')) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    // Order matters: `||` must be consumed whole, or it splits into two spurious `|` separators.
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Command words that RUN their string argument, so that string is a command and not merely text.
 *  Without this, the quote-awareness above would open an exact evasion: a `bash -c "<device
 *  command>"` is one segment beginning with `bash`, and everything inside it would be invisible. */
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Parse a shell command string and report which physical device(s) it names,
 * whether any sub-command would disturb them, and whether a device-touching
 * sub-command names no device at all ("whatever is attached").
 *
 * @param {string} command
 * @returns {{ ids: string[], destructive: boolean, untargeted: boolean, tools: string[] }}
 */
export function parseDeviceCommand(command) {
  const segments = splitSegments(stripHeredocBodies(String(command)));

  const idsSeen = new Set();
  const ids = [];
  const toolsSeen = new Set();
  const tools = [];
  let destructive = false;
  let untargeted = false;

  for (const rawSegment of segments) {
    const result = analyzeSegment(rawSegment);
    destructive = destructive || result.destructive;
    untargeted = untargeted || result.untargeted;
    for (const id of result.ids) {
      if (!idsSeen.has(id)) {
        idsSeen.add(id);
        ids.push(id);
      }
    }
    for (const t of result.tools) {
      if (!toolsSeen.has(t)) {
        toolsSeen.add(t);
        tools.push(t);
      }
    }
  }

  return { ids, destructive, untargeted, tools };
}
