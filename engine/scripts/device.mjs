#!/usr/bin/env node
/**
 * Standalone device-claim CLI (#285) — `npm run device:claim|release|list|run`.
 *
 * `deviceClaimsStore.mjs` already arbitrates the hardware for the MCP surface
 * (`device_connect`) and for `claim-guard.mjs`'s Bash hook, but both of those
 * only reach a Claude Code session in THIS repo. Codex, Cursor, Antigravity, a
 * human's own terminal — none of them go through either path, so a claim taken
 * by one of them is invisible to the others and vice versa. This file is the
 * one surface every one of those can reach: `node engine/scripts/device.mjs …`
 * (or the `npm run device:*` shortcuts) needs nothing but Node.
 *
 * ── The owner token ──
 * A CLI invocation is a process that EXITS the moment the command finishes —
 * there is no long-lived pid to check for liveness the way an editor's lease
 * is checked. The store's `owner`/`ttlMs` fields exist for exactly this (see
 * `deviceClaimsStore.mjs`'s header on `CLI_CLAIM_TTL_MS`): a claim identified
 * by a STABLE TOKEN rather than a pid, expiring purely on a TTL.
 *
 * The token is `cli:` + this repo's absolute realpath, computed once per
 * invocation and reused for every subcommand. That is deliberate, not merely
 * convenient: it is what lets `device release` (run later, in a NEW process)
 * give back what `device claim` (an EARLIER, now-dead process) took — the two
 * processes agree on the token without ever talking to each other. It also
 * means two invocations from the SAME clone are indistinguishable to the
 * store, which is exactly right: this clone's CLI claim is a property of the
 * checkout, not of any one command.
 *
 * No randomness, no pid, no timestamp in the token — any of those would break
 * the handoff above.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claimDevice, releaseDevice, listClaims, describeConflict, foreignClaimFor, CLI_CLAIM_TTL_MS,
} from './deviceClaimsStore.mjs';
import { parseDeviceCommand } from './deviceCommandTargets.mjs';

// ── Repo root + owner token ─────────────────────────────────────────────────

/** This checkout's absolute root. `git rev-parse` is the honest answer and
 *  works from any subdirectory; the manual walk-up is the fallback for a
 *  machine with no `git` on PATH (unlikely, but claiming hardware must not
 *  hard-depend on a binary this script does not otherwise need). */
function findRepoRoot() {
  const viaGit = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (viaGit.status === 0 && viaGit.stdout && viaGit.stdout.trim()) {
    try { return fs.realpathSync(viaGit.stdout.trim()); } catch { /* fall through */ }
  }
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      try { return fs.realpathSync(dir); } catch { break; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); }
}

const repoRoot = findRepoRoot();
/** The stable identity every subcommand in this invocation (and every future
 *  invocation from this same checkout) claims and releases under. */
const OWNER = `cli:${repoRoot}`;

/** This clone's branch, for the claim record — read from `.git/HEAD` directly
 *  rather than spawning `git` a second time; a detached HEAD or no git at all
 *  is an unknown branch, never an error (mirrors `deviceClaimsStore.mjs`'s own
 *  `currentBranch`, just pointed at the resolved repo root instead of cwd). */
function currentBranch() {
  try {
    const head = fs.readFileSync(path.join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 12);
  } catch {
    return 'unknown';
  }
}

// ── Attached-hardware enumeration (best-effort — never fatal) ──────────────

/** Every `adb`/`xcrun` call below is wrapped so a machine with no Android SDK
 *  or no Xcode CLT degrades to "could not enumerate" rather than crashing —
 *  claiming a device by explicit `adb:`/`ios:`/`ip:` id must keep working on a
 *  box that cannot even list what's attached. */
/** Where `adb` actually is.
 *
 *  A bare `spawnSync('adb', …)` is a lint ERROR in this repo, and for a good reason: the packaged
 *  editor's adb is NOT on PATH, so a bare spawn ENOENTs there. The authority is
 *  `detectAdb()` in `engine/toolchain/index.ts` — which this file cannot import, being plain ESM
 *  that must run under bare `node` with no build step (that is the whole point of the CLI: Codex,
 *  a terminal, a script). So it mirrors that resolution order instead, most-specific first, and
 *  falls back to PATH last.
 *
 *  The PATH fallback is correct rather than lazy HERE, and the toolchain agrees in code: with no
 *  `MODOKI_TOOLCHAIN_DIR` set it returns early with "dev editor — use the machine's SDKs". This
 *  script only ever runs from a dev clone; the packaged editor never invokes it. Everything below
 *  is best-effort anyway — enumeration failing degrades to "could not enumerate", and a namespaced
 *  `adb:<serial>` claim keeps working on a box with no Android SDK at all. */
function resolveAdbBin() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const roots = [];
  if (process.env.MODOKI_TOOLCHAIN_DIR) roots.push(path.join(process.env.MODOKI_TOOLCHAIN_DIR, 'android-sdk'));
  for (const v of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) if (process.env[v]) roots.push(process.env[v]);
  const home = os.homedir();
  roots.push(path.join(home, 'Library', 'Android', 'sdk'), path.join(home, 'Android', 'Sdk'));
  for (const root of roots) {
    const candidate = path.join(root, 'platform-tools', exe);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next candidate */ }
  }
  return 'adb';
}

function tryListAdb() {
  try {
    const res = spawnSync(resolveAdbBin(), ['devices', '-l'], { encoding: 'utf8', timeout: 5000 });
    if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return [];
    return parseAdbDevices(res.stdout);
  } catch {
    return [];
  }
}

/** Parse `adb devices -l`. Format (see `androidDevices.ts`'s `parseAdbDevices`
 *  for the fuller, typed version this mirrors — kept separate here so this
 *  script has zero TypeScript/toolchain-provisioning dependencies):
 *    List of devices attached
 *    ASJTESTSERIAL3   device usb:2-1.4.3 model:MRD_LX3 ...
 *    RFDEADBEEF2        unauthorized usb:2-1.1
 */
function parseAdbDevices(out) {
  const devices = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('*') || /^List of devices/i.test(line)) continue;
    const parts = line.split(/\s+/);
    const [serial, state] = parts;
    if (!serial || !state) continue;
    const dev = { serial, state };
    for (const kv of parts.slice(2)) {
      const idx = kv.indexOf(':');
      if (idx <= 0) continue;
      const key = kv.slice(0, idx);
      const value = kv.slice(idx + 1);
      if (key === 'model') dev.model = value;
    }
    devices.push(dev);
  }
  return devices;
}

function tryListXctrace() {
  try {
    const res = spawnSync('xcrun', ['xctrace', 'list', 'devices'], { encoding: 'utf8', timeout: 8000 });
    if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return [];
    return parseXctraceDevices(res.stdout);
  } catch {
    return [];
  }
}

/** Parse `xcrun xctrace list devices` (the legacy listing — the only one that
 *  can see iOS 16 and older, #143). Format (mirrors `wdaLauncher.ts`'s
 *  `parseXctraceDevices`):
 *    == Devices ==
 *    iPhone8 (16.7.16) (deadbeef…)     ← name (os) (udid)
 *    == Devices Offline ==
 *    == Simulators ==                 ← skipped
 *  Requiring the `(os) (udid)` pair is what excludes the Mac itself (which
 *  has no OS version in this listing) without special-casing its name. */
function parseXctraceDevices(out) {
  const result = [];
  let inDevices = false;
  let connected = false;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('==')) {
      inDevices = /^==\s*Devices(\s+Offline)?\s*==$/.test(line);
      connected = inDevices && !/Offline/i.test(line);
      continue;
    }
    if (!inDevices || !line) continue;
    const m = /^(.*?)\s+\(([0-9]+(?:\.[0-9]+)*)\)\s+\(([0-9A-Fa-f][0-9A-Fa-f-]{7,})\)$/.exec(line);
    if (!m) continue;
    result.push({ udid: m[3], name: m[1], connected, osVersion: m[2] });
  }
  return result;
}

function describeAttached(adb, ios) {
  const bits = [];
  if (adb.length) bits.push(`Android: ${adb.map((d) => `${d.serial}${d.model ? ` (${d.model})` : ''}`).join(', ')}`);
  if (ios.length) bits.push(`iOS: ${ios.map((d) => `${d.udid}${d.name ? ` (${d.name})` : ''}`).join(', ')}`);
  return bits.length ? `Attached right now — ${bits.join(' · ')}.` : 'Nothing appears to be attached (or adb/xcrun could not be run).';
}

// ── Device-id resolution ────────────────────────────────────────────────────

const NAMESPACES = ['adb', 'ios', 'ip'];
function isNamespaced(id) {
  return NAMESPACES.some((ns) => id.startsWith(`${ns}:`));
}

/** A UDID is either the legacy 40-hex form (pre-iPhone-X) or the modern
 *  `XXXXXXXX-XXXXXXXXXXXXXXXX` form — same rule `resolveIosDevice` uses. */
const IOS_UDID_RE = /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16})$/;

/** Turn whatever the human/agent typed into a namespaced device id. NEVER
 *  guesses silently (the brief's own rule): an id that matches nothing known
 *  is refused with what IS attached, rather than assumed to be one namespace
 *  or another. */
function resolveDeviceId(rawId) {
  if (isNamespaced(rawId)) return { ok: true, deviceId: rawId };

  const adb = tryListAdb();
  const adbHit = adb.find((d) => d.serial === rawId);
  if (adbHit) return { ok: true, deviceId: `adb:${rawId}`, label: adbHit.model };

  if (IOS_UDID_RE.test(rawId)) {
    const ios = tryListXctrace();
    const iosHit = ios.find((d) => d.udid === rawId);
    return { ok: true, deviceId: `ios:${rawId}`, label: iosHit ? iosHit.name : undefined };
  }

  const ios = tryListXctrace();
  return {
    ok: false,
    message: `"${rawId}" isn't a recognised adb serial or iOS UDID. ${describeAttached(adb, ios)}\n`
      + `Use a namespaced id instead: adb:${rawId}, ios:${rawId}, or ip:${rawId}.`,
  };
}

/** Same resolution as `resolveDeviceId`, but for `release`: a device that has
 *  since been UNPLUGGED can no longer be resolved by matching it against
 *  attached hardware, yet its claim (and the ability to give it back) must
 *  still be reachable. Falls back to this clone's OWN live claims. */
function resolveIdForRelease(rawId) {
  if (isNamespaced(rawId)) return { ok: true, deviceId: rawId };
  const live = resolveDeviceId(rawId);
  if (live.ok) return live;
  const mine = listClaims().filter((c) => c.owner === OWNER);
  const hit = mine.find((c) => c.deviceId.endsWith(`:${rawId}`));
  if (hit) return { ok: true, deviceId: hit.deviceId };
  return {
    ok: false,
    message: `"${rawId}" isn't a recognised device id, and this clone holds no claim ending in `
      + `":${rawId}". Use a namespaced id (adb:${rawId}, ios:${rawId}, ip:${rawId}), or check `
      + '`npm run device:list`.',
  };
}

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseFlags(args) {
  const out = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--purpose') { out.purpose = args[++i]; }
    else if (a.startsWith('--purpose=')) { out.purpose = a.slice('--purpose='.length); }
    else if (a === '--ttl') { out.ttl = Number(args[++i]); }
    else if (a.startsWith('--ttl=')) { out.ttl = Number(a.slice('--ttl='.length)); }
    else if (a === '--all') { out.all = true; }
    else if (a === '--force') { out.force = true; }
    else out.positional.push(a);
  }
  return out;
}

// ── iOS "is this the same phone as a foreign WiFi claim?" narrowing (#285) ──
//
// See `deviceClaimsStore.mjs`'s header ("KNOWN GAP: one phone can hold two claim ids") for the full
// picture. Short version: a WiFi lease can only claim a phone by ADDRESS (`ip:<host>`), every raw
// iOS CLI targets it by UDID (`ios:<udid>`), and nothing can prove those are the same handset — an
// iOS app is deliberately never allowed to report its own UDID. What a WiFi lease DOES stamp on its
// claim is the phone's product type (`DeviceClaim.model`, e.g. `iPhone18,4`), and `xcrun devicectl`
// can look the SAME fact up for a bare UDID — a product type is the strongest bridge available
// between the two namespaces, precisely because it is the one fact both sides can independently
// report. It is still only a HINT: two identical handsets report the same model, so a match cannot
// be certain — hence `--force`.

/** Find `hardwareProperties.productType` for a matching `hardwareProperties.udid` inside a parsed
 *  `xcrun devicectl list devices --json-output` document. Mirrors `wdaLauncher.ts`'s
 *  `parseIosDevices` shape (`result.devices[].hardwareProperties`) — kept as a small local parse
 *  rather than importing that module, since this script is deliberately dependency-free plain JS
 *  (see the file header on why `deviceClaimsStore.mjs` is plain JS too). Case-insensitive because
 *  UDIDs are hex and nothing here promises consistent casing between `xcrun` and the caller. */
function findProductType(parsed, udidLower) {
  const devices = parsed?.result?.devices;
  if (!Array.isArray(devices)) return undefined;
  for (const d of devices) {
    const udid = d?.hardwareProperties?.udid;
    if (typeof udid === 'string' && udid.toLowerCase() === udidLower) {
      const productType = d.hardwareProperties?.productType;
      return typeof productType === 'string' && productType ? productType : undefined;
    }
  }
  return undefined;
}

/** Resolve a UDID's product type, best-effort. Returns `undefined` on ANYTHING that stops this from
 *  producing an answer — no `xcrun`, a timeout, a device list that never mentions the UDID — because
 *  the caller's whole design hinges on "cannot tell" never being treated as evidence of anything.
 *
 *  `MODOKI_DEVICECTL_JSON_FIXTURE` points this at a canned JSON file (the same shape `xcrun devicectl
 *  --json-output` writes) instead of really spawning `xcrun` — the seam `deviceCli.test.ts` needs to
 *  pass on a machine with no Xcode and no phone attached. It does not change the rule under test,
 *  only where the JSON comes from.
 *
 *  `MODOKI_DEVICECTL_LOOKUP_MARKER`, when set, has this function touch that path the moment it is
 *  entered — a test-only observability hook so a test can assert the lookup was never even attempted
 *  (the "no foreign claim, no lookup" case), which a return value alone cannot distinguish from "ran
 *  and found nothing". It has no effect on the actual resolution and is never read anywhere else. */
function resolveIosProductType(udid) {
  if (process.env.MODOKI_DEVICECTL_LOOKUP_MARKER) {
    try { fs.writeFileSync(process.env.MODOKI_DEVICECTL_LOOKUP_MARKER, '1'); } catch { /* test-only, best-effort */ }
  }
  const needle = udid.toLowerCase();

  const fixture = process.env.MODOKI_DEVICECTL_JSON_FIXTURE;
  if (fixture) {
    try {
      return findProductType(JSON.parse(fs.readFileSync(fixture, 'utf8')), needle);
    } catch {
      return undefined;
    }
  }

  const tmp = path.join(os.tmpdir(), `modoki-device-cli-devicectl-${process.pid}-${Date.now()}.json`);
  try {
    const res = spawnSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmp], { timeout: 8000 });
    if (res.error || res.status !== 0) return undefined;
    return findProductType(JSON.parse(fs.readFileSync(tmp, 'utf8')), needle);
  } catch {
    return undefined;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

/** The narrowing check itself, run only for an `ios:<udid>` claim. Does nothing at all — no lookup,
 *  no message, no spawn — when there is no foreign `ip:` claim carrying a `model` to compare
 *  against, which is the ordinary case and must stay exactly as fast as it is today.
 *
 *  The three-way outcome is asymmetric on purpose, not a simplification that happened to leave a gap:
 *   - **MATCH → refuse.** A matching product type means two clones are probably driving one physical
 *     phone two different ways (an install, a tap, a WDA launch) with neither aware of the other —
 *     exactly the collision this whole claims system exists to prevent. Still only a hint (see
 *     above), so it is refused rather than silently arbitrated, and it is overridable.
 *   - **MISMATCH (a resolved, different product type) → allow silently.** This is real evidence, not
 *     an absence of it — two DIFFERENT iPhones is not a collision, and printing anything here would
 *     just be noise on the ordinary case of two clones legitimately using two different phones.
 *   - **UNKNOWN (no `xcrun`, a failed lookup, a UDID the listing doesn't mention) → allow, but SAY
 *     so.** "Cannot tell" must never collapse into "different" (a Mac with no Xcode CLT would then be
 *     unable to claim ANY iPhone at all — worse than the gap this check narrows) and must equally
 *     never collapse into "refuse" (that would block hardware on a lookup failure, not on evidence).
 *     A warning naming the foreign claim(s) is the honest middle ground: the human can go check by
 *     hand what an automated comparison could not settle. */
function checkIosPhoneCollision(udid, { force }) {
  const foreignWithModel = listClaims().filter(
    // Compared as PATHS, not strings: a claim recorded with a trailing slash (or any other spelling
    // of the same directory) must not make this clone look like a stranger and refuse its own phone.
    // `claim-guard.mjs` resolves the same comparison the same way.
    (c) => c.deviceId.startsWith('ip:') && path.resolve(c.clone) !== path.resolve(repoRoot) && c.model,
  );
  if (!foreignWithModel.length) return;

  const productType = resolveIosProductType(udid);

  if (!productType) {
    const holders = foreignWithModel
      .map((c) => `${c.label ? `${c.label} (${c.deviceId})` : c.deviceId} — clone ${c.clone}, branch ${c.branch}`)
      .join('; ');
    console.error(
      `Warning: could not determine ios:${udid}'s product type (xcrun devicectl is missing, failed, `
      + 'timed out, or does not list this UDID), so it could not be checked against a foreign WiFi '
      + `claim that might be the SAME physical phone: ${holders}. Proceeding anyway — a lookup failure `
      + 'is not evidence of a different device, so it is not grounds to refuse hardware.',
    );
    return;
  }

  const matches = foreignWithModel.filter((c) => c.model === productType);
  if (!matches.length) return; // resolved AND different — real evidence this is a different phone

  const holders = matches
    .map((c) => `${c.label ? `${c.label} (${c.deviceId})` : c.deviceId} held by clone ${c.clone} on `
      + `branch ${c.branch} since ${new Date(c.at).toLocaleTimeString()} (reports model ${c.model})`)
    .join('; ');

  if (force) {
    console.error(
      `--force: overriding a probable-same-phone refusal. ios:${udid} reports product type `
      + `${productType}, which matches ${holders}. Proceeding anyway.`,
    );
    return;
  }

  console.error(
    `Refused: ios:${udid} reports product type ${productType}, which MATCHES a foreign WiFi claim — `
    + `${holders}, also ${productType}. This is probably the same physical phone, claimed twice: once `
    + 'by address, once by UDID. It cannot be made certain — two identical handsets report the same '
    + 'product type, so this is a hint, not proof — so if you are sure this is a DIFFERENT phone that '
    + 'merely shares a model, re-run with --force.',
  );
  process.exit(1);
}

// ── Subcommands ──────────────────────────────────────────────────────────────

function cmdClaim(args) {
  const { positional, purpose, ttl, force } = parseFlags(args);
  const rawId = positional[0];
  if (!rawId) {
    console.error('Usage: device claim <id> [--purpose "..."] [--ttl <minutes>] [--force]');
    process.exit(1);
  }
  const resolved = resolveDeviceId(rawId);
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(1);
  }
  // (#285) Only an `ios:` claim can collide with a foreign `ip:` (WiFi) claim on the same physical
  // phone — see `checkIosPhoneCollision`'s comment. Every other namespace already carries a real
  // hardware serial, so there is nothing to narrow and this must not run (or spawn anything) for them.
  if (resolved.deviceId.startsWith('ios:')) {
    checkIosPhoneCollision(resolved.deviceId.slice('ios:'.length), { force });
  }
  const ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl * 60_000 : undefined;
  const result = claimDevice({
    deviceId: resolved.deviceId,
    owner: OWNER,
    clone: repoRoot,
    branch: currentBranch(),
    purpose,
    label: resolved.label,
    ttlMs,
  });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  const ttlUsed = result.claim.ttlMs ?? CLI_CLAIM_TTL_MS;
  const expires = new Date(result.claim.at + ttlUsed).toLocaleTimeString();
  const name = resolved.label ? `${resolved.label} (${resolved.deviceId})` : resolved.deviceId;
  console.log(
    `Claimed ${name} — expires ${expires} unless refreshed (\`npm run device:claim ${resolved.deviceId}\` `
    + `again). Release with \`npm run device:release ${resolved.deviceId}\`.`,
  );
  process.exit(0);
}

function cmdRelease(args) {
  const { positional, all } = parseFlags(args);

  if (all) {
    const mine = listClaims().filter((c) => c.owner === OWNER);
    if (!mine.length) {
      console.log('This clone holds no device claims.');
      process.exit(0);
    }
    for (const c of mine) releaseDevice(c.deviceId, { owner: OWNER });
    console.log(`Released: ${mine.map((c) => (c.label ? `${c.label} (${c.deviceId})` : c.deviceId)).join(', ')}.`);
    process.exit(0);
  }

  const rawId = positional[0];
  if (!rawId) {
    console.error('Usage: device release <id|--all>');
    process.exit(1);
  }
  const resolved = resolveIdForRelease(rawId);
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(1);
  }

  const before = listClaims().find((c) => c.deviceId === resolved.deviceId);
  if (!before) {
    console.log(`This clone holds no claim on ${resolved.deviceId} — nothing claims it at all.`);
    process.exit(0);
  }
  if (before.owner !== OWNER) {
    // A release must only ever be able to give back what THIS clone's CLI token took — never a
    // sibling clone's or a running editor's hold. Say so plainly rather than silently no-op'ing,
    // since a caller asking to release something they don't hold is worth telling.
    console.log(`Not released — ${resolved.deviceId} is held by another session, not this clone's CLI. ${describeConflict(before)}`);
    process.exit(0);
  }
  releaseDevice(resolved.deviceId, { owner: OWNER });
  console.log(`Released ${before.label ? `${before.label} (${resolved.deviceId})` : resolved.deviceId}.`);
  process.exit(0);
}

/** `held.owner`/`held.pid`-aware one-liner for the `list` table. */
function holderText(c) {
  if (c.owner) {
    const ttl = c.ttlMs ?? CLI_CLAIM_TTL_MS;
    const remaining = Math.max(0, Math.round((c.at + ttl - Date.now()) / 60000));
    return `held by CLI in ${c.clone} (branch ${c.branch}) — ${remaining} min left`;
  }
  return `held by clone ${c.clone} (branch ${c.branch}, pid ${c.pid})`;
}

function printTable(rows) {
  const idW = Math.max(2, ...rows.map((r) => r.id.length));
  const labelW = Math.max(5, ...rows.map((r) => r.label.length));
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(idW)}  ${r.label.padEnd(labelW)}  ${r.status}`);
  }
}

function cmdList() {
  // `listClaims()` — NEVER the raw `device-claims.json` file — because it applies staleness before
  // returning anything. A dead-pid record can sit in the file long after its holder is gone; #225
  // was filed because printing that record as-is reads exactly like a live claim to a human, when
  // `listClaims()` would have shown nothing holds the device at all.
  const claims = listClaims();
  const adb = tryListAdb();
  const ios = tryListXctrace();

  const rows = [];
  for (const d of adb) {
    const id = `adb:${d.serial}`;
    const held = claims.find((c) => c.deviceId === id);
    rows.push({ id, label: d.model ?? '', status: held ? holderText(held) : 'free' });
  }
  for (const d of ios) {
    const id = `ios:${d.udid}`;
    const held = claims.find((c) => c.deviceId === id);
    rows.push({ id, label: d.name ?? '', status: held ? holderText(held) : 'free' });
  }

  console.log('Attached devices:');
  if (!rows.length) console.log('  (none detected — adb/xcrun missing, or nothing plugged in)');
  else printTable(rows);

  // A live claim whose device id matches nothing attached is still a REAL hold — a WiFi `ip:`
  // lease, or a phone that has since been unplugged — so it gets its own heading rather than being
  // silently dropped from the report.
  const attachedIds = new Set(rows.map((r) => r.id));
  const detached = claims.filter((c) => !attachedIds.has(c.deviceId));
  if (detached.length) {
    console.log('\nClaimed but not currently attached:');
    for (const c of detached) {
      console.log(`  ${c.label ? `${c.label} (${c.deviceId})` : c.deviceId} — ${holderText(c)}`);
    }
  }
  process.exit(0);
}

function execCommand(command) {
  const res = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  if (res.error) {
    console.error(`Failed to run "${command[0]}": ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? (res.signal ? 1 : 0));
}

function cmdRun(rawArgs) {
  const sepIdx = rawArgs.indexOf('--');
  if (sepIdx === -1) {
    console.error('Usage: device run [--purpose "..."] -- <command...>');
    process.exit(1);
  }
  const { purpose } = parseFlags(rawArgs.slice(0, sepIdx));
  const command = rawArgs.slice(sepIdx + 1);
  if (!command.length) {
    console.error('device run: no command given after --');
    process.exit(1);
  }

  // Rebuilt only to hand to the PURE classifier below — the actual exec at the bottom of this
  // function uses the original argv array with no shell, per the "never build a shell string from
  // user input" rule. Reconstructing a string here is safe because these tokens already came out
  // of the invoking shell's own parsing (no re-quoting needed).
  const cmdStr = command.join(' ');
  const targets = parseDeviceCommand(cmdStr);

  if (!targets.tools.length) {
    // Names no device CLI at all — nothing for this tool to arbitrate.
    execCommand(command);
    return;
  }

  if (targets.destructive && targets.untargeted) {
    console.error(
      `Refused: ${cmdStr}\n\nThis is a destructive device command with no device named. Several `
      + 'Android and iOS devices can be attached on this machine at once, so "whatever is plugged '
      + 'in" is a coin flip. Say which one: `adb -s <serial> …`, `xcrun devicectl --device <udid> …`, '
      + '`ideviceinstaller -u <udid> …`. `npm run device:list` shows what is attached.',
    );
    process.exit(1);
  }

  // TWO PASSES, and the order is the point. Claiming as we go leaked hardware on a multi-device
  // command: a command naming a free Android and a foreign iPhone claimed the Android, was then
  // refused on the iPhone, and exited WITHOUT running — leaving the Android locked out of every
  // other clone for up to 90 minutes on behalf of a command that provably did nothing. So: refuse
  // first on the whole set, then take anything.
  //
  // This is a check-then-act, and deliberately so. A sibling clone could claim one of these devices
  // in the window between the two passes; the second pass would then refuse it, and the only cost is
  // that a claim taken earlier in the same pass outlives the command — the same leak, narrowed from
  // "every refused multi-device run" to "a genuine race". Closing it properly needs an all-or-nothing
  // claim across several ids, which the store cannot express today and which no caller has needed:
  // a command naming two physical devices at once is rare enough that it has never been observed.
  const blocked = targets.ids
    .map((id) => ({ id, held: foreignClaimFor(id, { clone: repoRoot }) }))
    .filter((x) => x.held);
  if (blocked.length) {
    for (const { held } of blocked) console.error(describeConflict(held));
    process.exit(1);
  }

  for (const id of targets.ids) {
    // `claimDevice` already IS the claim-or-refresh decision this subcommand needs: it treats a
    // matching `owner` token as a refresh rather than a conflict (see `deviceClaimsStore.mjs`'s
    // `isSameHolder`), so there is no separate branch here for "mine" vs "free". Its refusal path
    // still runs — it is what catches the race the two-pass comment above describes.
    const result = claimDevice({
      deviceId: id, owner: OWNER, clone: repoRoot, branch: currentBranch(), purpose,
    });
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
  }

  // Claim(s) kept deliberately: the whole point of `device run` is that the caller goes on driving
  // the device after this command exits (a build, then a screenshot, then a tap). Releasing here
  // would hand the phone away mid-session, one command after claiming it.
  execCommand(command);
}

// ── Entry point ──────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`Usage: node engine/scripts/device.mjs <claim|release|list|run> ...
  (or: npm run device:claim / device:release / device:list / device:run)

  device claim <id> [--purpose "..."] [--ttl <minutes>] [--force]
      Claim a device — by adb serial, iOS UDID, or a namespaced "adb:X" /
      "ios:X" / "ip:X" id. Refused (named holder + release command) if
      another clone already has it. An "ios:" claim that matches a foreign
      "ip:" (WiFi) claim's reported product type is ALSO refused as a
      probable same-phone collision (#285) — pass --force to override.

  device release <id|--all>
      Give back a device THIS clone's CLI previously claimed. --all releases
      every device this clone's CLI token holds. Never touches another
      holder's claim; exits 0 either way.

  device list
      Show attached Android/iOS devices and who (if anyone) holds them, plus
      any live claim (e.g. a WiFi lease) on a device not currently attached.

  device run [--purpose "..."] -- <command...>
      Claim whatever device the command names (refusing a destructive command
      that names none), then run it with the claim KEPT afterward so the
      caller can keep driving the device.

A device claim is machine-wide (#149/#285) — it locks a phone out of every
other clone on this Mac until released. This clone's CLI owner token:
  ${OWNER}`);
}

function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    process.exit(0);
  }
  switch (sub) {
    case 'claim': cmdClaim(rest); break;
    case 'release': cmdRelease(rest); break;
    case 'list': cmdList(rest); break;
    case 'run': cmdRun(rest); break;
    default:
      console.error(`Unknown subcommand "${sub}".\n`);
      printUsage();
      process.exit(1);
  }
}

main();
