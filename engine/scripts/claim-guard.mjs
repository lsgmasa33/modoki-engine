#!/usr/bin/env node
/**
 * The device-claim guard — a Claude Code `PreToolUse` hook that refuses a raw `adb`/`devicectl`/
 * `xcodebuild`/`ideviceinstaller`/go-ios command aimed at a phone this clone does not hold (#285).
 *
 * ── Why a hook, and not a wrapper on PATH ──
 * #149 made a device claim machine-wide and ENFORCED it — but only along the path that consults it.
 * `device_connect` refuses a claimed device and names the holder; the CLI tools do not, because they
 * never ask. So the claim protected the MCP surface and left the CLI surface wide open, and the CLI
 * surface is where the destructive operations live (`install -r`, `uninstall`, `am force-stop`,
 * `pm clear`, `devicectl device process terminate`).
 *
 * That is not a hypothetical. On 2026-08-20 this clone released the Galaxy S22, `work-ai2` claimed
 * it, and this clone then reinstalled Court on it, force-stopped it and cleared its logcat — all
 * over raw `adb -s`. `device_list` showed the claim the whole time. Nothing warned, nothing failed,
 * and the OWNER spotted it rather than the tooling.
 *
 * A wrapper script on PATH only helps the caller who already chose to use it — which is precisely
 * the caller who was not going to violate the rule. The violation happens when an agent shells out
 * to `adb` directly, so the guard has to sit on the path the agent actually takes: its Bash tool.
 *
 * ── What this can and cannot reach ──
 * It intercepts the Bash tool of a Claude Code session in this repo, and nothing else. A human's own
 * terminal, the editor backend's own spawns, and other agent CLIs (Codex, Cursor, Antigravity — none
 * of which have a PreToolUse equivalent) all bypass it. `engine/scripts/device.mjs` is the universal
 * path for those; this hook is the one that closes the case #285 was filed about.
 *
 * It never reaches a Modoki USER: `.claude/` is excluded from the OSS snapshot
 * (`scripts/publish-engine-oss.sh`), so this file exists only in the private repo.
 *
 * ── Fail-open is the failure mode to watch ──
 * A hook whose path is mistyped, or which crashes, does NOT block: Claude Code reports a
 * non-blocking status and the command runs. So a silently-disabled gate looks exactly like a gate
 * that had nothing to say. Two consequences the code below takes seriously:
 *   - anything unexpected is caught and turned into an ALLOW, never an exception (a guard that
 *     crashes on an odd command must not wedge every Bash call in the session), and
 *   - the deliberate "break the path and confirm the notice appears" check belongs in the docs, not
 *     in a comment nobody re-runs — see docs/debug-tools-mcp.md.
 *
 * ── Cost ──
 * `PreToolUse` spawns this process for EVERY Bash tool call, so the first thing it does is a single
 * regex over the command string and an immediate exit when no device CLI is named. The settings
 * entry deliberately does NOT use an `if:` filter to narrow the spawn: those match the command by
 * prefix, and every interesting call here is prefixed by something else — `xcrun devicectl …`,
 * `ANDROID_SERIAL=… adb …`, or an `adb` in the second half of a `&&` chain. A filter that quietly
 * misses those is worse than the ~40 ms it saves, because the gap is invisible.
 */

import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { listClaims } from './deviceClaimsStore.mjs';
import { parseDeviceCommand } from './deviceCommandTargets.mjs';

/** Cheap pre-filter: does this command even mention a tool that can touch a phone? Deliberately
 *  broader than the parser (it may match a command the parser then dismisses) — being wrong in the
 *  direction of "look closer" costs microseconds, being wrong the other way costs the whole guard. */
const MENTIONS_DEVICE_TOOL = /(^|[^\w/-])(adb|devicectl|xcodebuild|ideviceinstaller|ios|go-ios)([^\w-]|$)/;

/** Allow, saying nothing. The overwhelmingly common path — a hook that printed on every Bash call
 *  would be noise in the transcript rather than a guard. */
function allow() {
  process.exit(0);
}

/** Refuse, and tell CLAUDE why — a deny's `permissionDecisionReason` is delivered to the model, so
 *  it is the one place a refusal can also carry the remedy. Always name the fix as a command that
 *  can be run verbatim; "you should have claimed it" is a scolding, not a fix. */
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null; // unreadable payload — not ours to block on
  }
}

/** This checkout's absolute root, as the claim record spells it. `CLAUDE_PROJECT_DIR` is set by the
 *  harness and is the honest answer even when the command runs from a subdirectory; `cwd` from the
 *  payload is the fallback. Compared as paths, not strings, so a trailing slash cannot make this
 *  clone look like a stranger and refuse its own device. */
function thisClone(payload) {
  const raw = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  // realpath, not merely resolve: `device.mjs` records the claim under the REAL path (it resolves
  // the repo root through `fs.realpathSync`), so on a symlinked checkout — or with
  // CLAUDE_PROJECT_DIR pointed at a non-canonical path — a `path.resolve` here would produce a
  // different string for the same directory and this clone would be refused its OWN device. Falls
  // back to `resolve` when the path does not exist, since a refusal must never depend on a stat.
  try { return fs.realpathSync(path.resolve(raw)); } catch { return path.resolve(raw); }
}

function heldByThisClone(claim, clone) {
  // Same normalisation on both sides — see `thisClone`.
  let held;
  try { held = fs.realpathSync(path.resolve(claim.clone)); } catch { held = path.resolve(claim.clone); }
  return held === clone;
}

const CLAIM_HINT = (id) => `Claim it first: \`npm run device:claim ${id}\` (or connect it in the `
  + `editor / \`device_connect\`). Release it with \`npm run device:release ${id}\` when you are done — `
  + 'a claim is machine-wide and locks the phone out of every other clone until you do.';

function main() {
  const payload = readStdin();
  if (!payload) return allow();
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !MENTIONS_DEVICE_TOOL.test(command)) return allow();

  const targets = parseDeviceCommand(command);
  if (!targets.tools.length) return allow();
  // Read-only calls (`adb devices`, `getprop`, `logcat -d`, `devicectl device info`) cannot disturb
  // another session, so they are allowed against a claimed phone. The claim arbitrates INTERFERENCE,
  // not curiosity — refusing a listing would train the agent to route around the guard.
  if (!targets.destructive) return allow();

  const clone = thisClone(payload);
  const claims = listClaims();

  for (const id of targets.ids) {
    const held = claims.find((c) => c.deviceId === id);
    if (held && !heldByThisClone(held, clone)) {
      return deny(`Refused: ${command.slice(0, 120)}\n\nThis device is held by another clone. `
        + `${describeHeld(held)}\n\nTwo sessions driving one phone install over each other and `
        + 'interleave taps, and the victim gets no attribution — which is why this is refused rather '
        + 'than warned about. Use a different device, or ask that session to release it.');
    }
    if (!held) {
      return deny(`Refused: ${command.slice(0, 120)}\n\nNothing holds ${id} on this machine, and a `
        + 'destructive device command must run under a claim — four clones share this hardware, and '
        + `an unclaimed phone is one another session may take mid-flight.\n\n${CLAIM_HINT(id)}`);
    }
  }

  if (targets.untargeted) {
    // No `-s`/`--device`: the command targets "whatever is attached", which on this machine is three
    // Android handsets and two iPhones. We cannot tell WHICH phone it would reach without spawning
    // adb, and guessing is the failure this guard exists to prevent — so it is refused on the aim,
    // not on the claim. Naming the device is also what makes the claim checkable next time.
    const others = claims.filter((c) => !heldByThisClone(c, clone));
    const held = others.length
      ? `Another clone is holding ${others.map((c) => c.deviceId).join(', ')} right now, so this `
        + 'could land on their phone. '
      : '';
    return deny(`Refused: ${command.slice(0, 120)}\n\nThis is a destructive device command with no `
      + `device named. ${held}Say which one: \`adb -s <serial> …\`, \`devicectl --device <udid> …\`, `
      + '`ideviceinstaller -u <udid> …`. `npm run device:list` shows what is attached and who holds it.');
  }

  return allow();
}

/** The holder, in the terms a human can act on. Mirrors `describeConflict` in the claim store rather
 *  than re-deriving it, but drops its trailing advice — the deny message above supplies its own. */
function describeHeld(held) {
  const who = held.owner ? `the CLI in ${held.clone}` : `clone ${held.clone} (pid ${held.pid})`;
  const when = new Date(held.at).toLocaleTimeString();
  const doing = held.purpose ? `, ${held.purpose}` : '';
  return `${held.label ? `${held.label} (${held.deviceId})` : held.deviceId} is claimed by ${who} `
    + `on branch ${held.branch}${doing} — since ${when}.`;
}

try {
  main();
} catch {
  // A guard that throws must not wedge the session. Claude Code treats a crash as non-blocking
  // anyway; exiting 0 explicitly keeps it quiet rather than emitting a hook-error notice on a
  // command that was probably fine.
  allow();
}
