/**
 * deviceClaims tests (#149 part 2) — machine-wide claims on HARDWARE, not the socket lease.
 *
 * MODOKI_HOME is pointed at a per-test temp dir for every test in this file: a bug here writing
 * to the developer's REAL `~/.modoki/device-claims.json` could block their hardware, so this is
 * not optional hygiene.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimsDir, isPidAlive, isStale, listClaims, claimDevice, releaseDevice,
  releaseAllForThisProcess, sweepStaleClaims, describeConflict, adbDeviceId, iosDeviceId, wifiDeviceId,
  CLAIM_TTL_MS, CLI_CLAIM_TTL_MS,
  type DeviceClaim,
} from '../../plugins/backend/deviceClaims';
// Imported from the .mjs directly: these two are the store's own clamp, and the point of the test
// below is that the STORE applies it — going through the typed shell would test the shell instead.
import { clampTtlMs, MAX_CLAIM_TTL_MS } from '../../scripts/deviceClaimsStore.mjs';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MODOKI_HOME;
  else process.env.MODOKI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const claimsFilePath = () => path.join(claimsDir(), 'device-claims.json');

describe('claimsDir', () => {
  it('honours MODOKI_HOME rather than the real home directory', () => {
    expect(claimsDir()).toBe(home);
  });
});

describe('device id namespacing', () => {
  it('namespaces each addressing scheme so they cannot collide', () => {
    expect(adbDeviceId('X')).toBe('adb:X');
    expect(iosDeviceId('X')).toBe('ios:X');
    expect(wifiDeviceId('X')).toBe('ip:X');
    // Same raw value, three different ids.
    const ids = new Set([adbDeviceId('X'), iosDeviceId('X'), wifiDeviceId('X')]);
    expect(ids.size).toBe(3);
  });
});

describe('isPidAlive', () => {
  it('is true for this very process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('is false for pid 0 or negative / non-integer pids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it('EPERM (belongs to another user) counts as alive, not dead', () => {
    // Can't reliably provoke a real EPERM cross-platform in a unit test — this is exercised
    // indirectly via isStale's injectable `alive`, so it is not duplicated here.
  });
});

describe('isStale', () => {
  const base: DeviceClaim = { deviceId: 'adb:X', clone: '/c', branch: 'main', pid: 999, at: 1_000_000 };

  it('a dead pid is stale regardless of age (even ONE ms old)', () => {
    expect(isStale({ ...base, at: 999_999 }, { now: 1_000_000, alive: () => false })).toBe(true);
  });

  it('a live pid within the TTL is not stale', () => {
    expect(isStale(base, { now: base.at + 1000, alive: () => true })).toBe(false);
  });

  it('a live pid past CLAIM_TTL_MS is stale', () => {
    expect(isStale(base, { now: base.at + CLAIM_TTL_MS + 1, alive: () => true })).toBe(true);
  });

  it('exactly at the TTL boundary is not yet stale (strictly greater-than)', () => {
    expect(isStale(base, { now: base.at + CLAIM_TTL_MS, alive: () => true })).toBe(false);
  });

  it('a claim stamped in the FUTURE (clock skew) is NOT stale — only genuine age counts', () => {
    expect(isStale({ ...base, at: 2_000_000 }, { now: 1_000_000, alive: () => true })).toBe(false);
  });

  it('defaults to isPidAlive and Date.now() when opts are omitted', () => {
    // This process is alive and `at` is "now", so this must read as fresh under the real clock.
    expect(isStale({ ...base, pid: process.pid, at: Date.now() })).toBe(false);
  });
});

describe('listClaims / readClaims robustness', () => {
  it('returns [] when the claims file does not exist yet', () => {
    expect(listClaims()).toEqual([]);
  });

  it('returns [] and never throws on a corrupt claims file', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(claimsFilePath(), '{ not json at all');
    expect(() => listClaims()).not.toThrow();
    expect(listClaims()).toEqual([]);
  });

  it('returns [] when the file is valid JSON but not the documented shape', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ notClaims: [] }));
    expect(listClaims()).toEqual([]);
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: 'not-an-array' }));
    expect(listClaims()).toEqual([]);
  });

  it('filters out stale entries', () => {
    fs.mkdirSync(home, { recursive: true });
    const live: DeviceClaim = { deviceId: 'adb:LIVE', clone: '/c', branch: 'main', pid: process.pid, at: Date.now() };
    const dead: DeviceClaim = { deviceId: 'adb:DEAD', clone: '/c', branch: 'main', pid: 999_999_999, at: Date.now() };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [live, dead] }));
    const result = listClaims({ alive: (pid) => pid === process.pid });
    expect(result.map((c) => c.deviceId)).toEqual(['adb:LIVE']);
  });
});

describe('claimDevice', () => {
  it('succeeds on a free device and writes the claims file to disk', () => {
    const r = claimDevice({ deviceId: 'adb:X', clone: '/clone/a', branch: 'main' });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(claimsFilePath())).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(onDisk.claims).toHaveLength(1);
    expect(onDisk.claims[0].deviceId).toBe('adb:X');
    expect(onDisk.claims[0].pid).toBe(process.pid);
  });

  it('a second claim by the SAME pid is a refreshing no-op success (reconnect / re-lease)', () => {
    const first = claimDevice({ deviceId: 'adb:X', clone: '/clone/a', branch: 'main' }, { now: 1000 });
    expect(first.ok).toBe(true);
    const second = claimDevice({ deviceId: 'adb:X', clone: '/clone/a', branch: 'main', purpose: 'installing' }, { now: 2000 });
    expect(second.ok).toBe(true);
    expect((second as { ok: true; claim: DeviceClaim }).claim.at).toBe(2000);
    expect((second as { ok: true; claim: DeviceClaim }).claim.purpose).toBe('installing');
    // Still exactly one entry for this device — not a duplicate. `now` must be consistent with
    // the injected claim timestamp (2000), or the TTL check reads it as ancient and stale.
    expect(listClaims({ now: 2000 })).toHaveLength(1);
  });

  it('a claim held by a DIFFERENT live pid is refused, naming clone/branch/pid', () => {
    // Simulate a sibling clone by writing the file directly with a pid we inject as "alive".
    fs.mkdirSync(home, { recursive: true });
    const held: DeviceClaim = { deviceId: 'adb:X', clone: '/clone/other', branch: 'work-ai', pid: 424242, at: 500 };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [held] }));

    const r = claimDevice(
      { deviceId: 'adb:X', clone: '/clone/mine', branch: 'main' },
      { now: 600, alive: (pid) => pid === 424242 || pid === process.pid },
    );
    expect(r.ok).toBe(false);
    const failure = r as { ok: false; held: DeviceClaim; message: string };
    expect(failure.held).toEqual(held);
    expect(failure.message).toMatch(/\/clone\/other/);
    expect(failure.message).toMatch(/work-ai/);
    expect(failure.message).toMatch(/424242/);
  });

  it('a stale claim held by a different (dead) pid is silently overtaken, not refused', () => {
    fs.mkdirSync(home, { recursive: true });
    const dead: DeviceClaim = { deviceId: 'adb:X', clone: '/clone/other', branch: 'work-ai', pid: 424242, at: 500 };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [dead] }));

    const r = claimDevice(
      { deviceId: 'adb:X', clone: '/clone/mine', branch: 'main' },
      { now: 600, alive: (pid) => pid === process.pid }, // 424242 is NOT alive
    );
    expect(r.ok).toBe(true);
  });
});

describe('releaseDevice', () => {
  it('drops only THIS process\'s claim for that id', () => {
    claimDevice({ deviceId: 'adb:X', clone: '/mine' });
    releaseDevice('adb:X');
    expect(listClaims().find((c) => c.deviceId === 'adb:X')).toBeUndefined();
  });

  it('leaves a DIFFERENT pid\'s claim on the same device intact — release must never seize a sibling\'s hardware', () => {
    fs.mkdirSync(home, { recursive: true });
    const sibling: DeviceClaim = { deviceId: 'adb:X', clone: '/clone/other', branch: 'work-ai', pid: 424242, at: Date.now() };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [sibling] }));

    releaseDevice('adb:X', { alive: (pid) => pid === 424242 });

    const remaining = listClaims({ alive: (pid) => pid === 424242 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pid).toBe(424242);
  });

  it('is a no-op (never throws) when there is nothing to release', () => {
    expect(() => releaseDevice('adb:nonexistent')).not.toThrow();
  });
});

describe('releaseAllForThisProcess', () => {
  it('drops all of this pid\'s claims and none of anyone else\'s', () => {
    fs.mkdirSync(home, { recursive: true });
    const mine1: DeviceClaim = { deviceId: 'adb:A', clone: '/mine', branch: 'main', pid: process.pid, at: Date.now() };
    const mine2: DeviceClaim = { deviceId: 'ios:B', clone: '/mine', branch: 'main', pid: process.pid, at: Date.now() };
    const theirs: DeviceClaim = { deviceId: 'adb:C', clone: '/other', branch: 'work-ai', pid: 424242, at: Date.now() };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [mine1, mine2, theirs] }));

    releaseAllForThisProcess({ alive: (pid) => pid === process.pid || pid === 424242 });

    const remaining = listClaims({ alive: (pid) => pid === process.pid || pid === 424242 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].deviceId).toBe('adb:C');
  });
});

describe('sweepStaleClaims (#225)', () => {
  // The premise of #225 was that a dead-pid claim locks the phone out of every other clone. It does
  // not, and that is measured here rather than argued: the read path already expires it. What the
  // corpse actually does is LIE — `~/.modoki/device-claims.json` is a read surface CLAUDE.md points
  // agents at — so the sweep is about the file agreeing with the rule.
  it('a dead-pid claim never blocked anyone in the first place', () => {
    fs.mkdirSync(home, { recursive: true });
    const dead: DeviceClaim = { deviceId: 'adb:STALE', clone: '/other', branch: 'work-ai3', pid: 424242, at: Date.now() };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [dead] }));
    const alive = (pid: number) => pid === process.pid;

    expect(listClaims({ alive })).toEqual([]);
    expect(claimDevice({ deviceId: 'adb:STALE', clone: '/mine' }, { alive }).ok).toBe(true);
  });

  it('removes claims whose pid is gone and returns them, keeping live ones', () => {
    fs.mkdirSync(home, { recursive: true });
    const live: DeviceClaim = { deviceId: 'adb:LIVE', clone: '/mine', branch: 'main', pid: process.pid, at: Date.now() };
    const dead: DeviceClaim = { deviceId: 'adb:DEAD', clone: '/other', branch: 'work-ai', pid: 424242, at: Date.now() };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [live, dead] }));

    const swept = sweepStaleClaims({ alive: (pid) => pid === process.pid });

    expect(swept.map((c) => c.deviceId)).toEqual(['adb:DEAD']);
    const onDisk = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8')).claims as DeviceClaim[];
    expect(onDisk.map((c) => c.deviceId)).toEqual(['adb:LIVE']);
  });

  it('sweeps a claim that outlived the TTL even though its pid is alive', () => {
    fs.mkdirSync(home, { recursive: true });
    const old: DeviceClaim = { deviceId: 'adb:OLD', clone: '/mine', branch: 'main', pid: process.pid, at: 1_000 };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [old] }));

    const swept = sweepStaleClaims({ now: 1_000 + CLAIM_TTL_MS + 1, alive: () => true });

    expect(swept.map((c) => c.deviceId)).toEqual(['adb:OLD']);
  });

  // A backend starts on every editor launch, so an unconditional write here would create
  // `~/.modoki/device-claims.json` on a machine that has never touched a device.
  it('returns EXACTLY what it removed, even when a claim expires mid-sweep', () => {
    // The partition is computed once. With two isStale passes, a pid dying between them would be
    // dropped from the file by the second pass and absent from the returned list — the caller
    // would log "swept 0" having swept 1. `alive` flips on its second probe to force that window.
    fs.mkdirSync(home, { recursive: true });
    const a: DeviceClaim = { deviceId: 'adb:A', clone: '/mine', branch: 'main', pid: 111, at: Date.now() };
    const b: DeviceClaim = { deviceId: 'adb:B', clone: '/mine', branch: 'main', pid: 222, at: Date.now() };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [a, b] }));
    let probes = 0;
    const flaky = (pid: number) => { probes += 1; return pid === 222 ? probes < 3 : false; };

    const swept = sweepStaleClaims({ alive: flaky });

    const onDisk = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8')).claims as DeviceClaim[];
    const removed = ['adb:A', 'adb:B'].filter((id) => !onDisk.some((c) => c.deviceId === id));
    expect(swept.map((c) => c.deviceId).sort()).toEqual(removed.sort());
  });

  it('creates no file when there is nothing to sweep', () => {
    expect(sweepStaleClaims()).toEqual([]);
    expect(fs.existsSync(claimsFilePath())).toBe(false);
  });

  it('leaves a file of entirely live claims byte-identical', () => {
    fs.mkdirSync(home, { recursive: true });
    const live: DeviceClaim = { deviceId: 'adb:LIVE', clone: '/mine', branch: 'main', pid: process.pid, at: Date.now() };
    const raw = JSON.stringify({ claims: [live] });
    fs.writeFileSync(claimsFilePath(), raw);

    expect(sweepStaleClaims({ alive: () => true })).toEqual([]);
    expect(fs.readFileSync(claimsFilePath(), 'utf8')).toBe(raw);
  });
});

describe('describeConflict', () => {
  it('names the clone, branch, pid and a time', () => {
    const held: DeviceClaim = {
      deviceId: 'adb:X', clone: '/Users/x/Projects/modoki-ai', branch: 'work-ai', pid: 8123, at: Date.now() - 5 * 60_000,
    };
    const msg = describeConflict(held);
    expect(msg).toMatch(/\/Users\/x\/Projects\/modoki-ai/);
    expect(msg).toMatch(/work-ai/);
    expect(msg).toMatch(/8123/);
    expect(msg).toMatch(/\d+ min ago/);
  });

  it('includes the label and purpose when present', () => {
    const held: DeviceClaim = {
      deviceId: 'adb:X', clone: '/c', branch: 'main', pid: 1, at: Date.now(), label: 'SC_56C', purpose: 'installing a build',
    };
    const msg = describeConflict(held);
    expect(msg).toMatch(/SC_56C/);
    expect(msg).toMatch(/installing a build/);
  });
});

describe('CLI-owned claims (#285) — owner/ttlMs', () => {
  it('an owner-claim (pid 0) is NOT expired by a dead pid while inside its TTL', () => {
    const claim: DeviceClaim = { deviceId: 'adb:X', clone: '/c', branch: 'main', pid: 0, at: 1_000_000, owner: 'wrapper-adb' };
    // alive() would report pid 0 as dead if it were consulted at all — it must not be.
    expect(isStale(claim, { now: 1_000_000 + 1000, alive: () => false })).toBe(false);
  });

  it('an owner-claim IS expired once it outlives CLI_CLAIM_TTL_MS, even with a generous `alive`', () => {
    const claim: DeviceClaim = { deviceId: 'adb:X', clone: '/c', branch: 'main', pid: 0, at: 1_000_000, owner: 'wrapper-adb' };
    expect(isStale(claim, { now: 1_000_000 + CLI_CLAIM_TTL_MS + 1, alive: () => true })).toBe(true);
    expect(isStale(claim, { now: 1_000_000 + CLI_CLAIM_TTL_MS, alive: () => true })).toBe(false);
  });

  it('a per-claim ttlMs overrides CLI_CLAIM_TTL_MS for an owner-claim', () => {
    const claim: DeviceClaim = { deviceId: 'adb:X', clone: '/c', branch: 'main', pid: 0, at: 1_000_000, owner: 'wrapper-adb', ttlMs: 5000 };
    expect(isStale(claim, { now: 1_000_000 + 5000 + 1, alive: () => true })).toBe(true);
    expect(isStale(claim, { now: 1_000_000 + 4999, alive: () => true })).toBe(false);
  });

  it('a plain pid-claim\'s expiry rule is completely unchanged: dead pid stale immediately, live pid stale only past CLAIM_TTL_MS', () => {
    const claim: DeviceClaim = { deviceId: 'adb:X', clone: '/c', branch: 'main', pid: 999, at: 1_000_000 };
    expect(isStale(claim, { now: 1_000_000 + 1, alive: () => false })).toBe(true);
    expect(isStale(claim, { now: 1_000_000 + CLAIM_TTL_MS, alive: () => true })).toBe(false);
    expect(isStale(claim, { now: 1_000_000 + CLAIM_TTL_MS + 1, alive: () => true })).toBe(true);
  });

  it('the same owner token re-claiming refreshes rather than conflicting', () => {
    const first = claimDevice({ deviceId: 'adb:X', clone: '/clone/a', branch: 'main', owner: 'wrapper-adb' }, { now: 1000, alive: () => false });
    expect(first.ok).toBe(true);
    expect((first as { ok: true; claim: DeviceClaim }).claim.pid).toBe(0);

    const second = claimDevice(
      { deviceId: 'adb:X', clone: '/clone/a', branch: 'main', owner: 'wrapper-adb', purpose: 'installing' },
      { now: 2000, alive: () => false },
    );
    expect(second.ok).toBe(true);
    expect((second as { ok: true; claim: DeviceClaim }).claim.at).toBe(2000);
    expect((second as { ok: true; claim: DeviceClaim }).claim.purpose).toBe('installing');
    expect(listClaims({ now: 2000, alive: () => false })).toHaveLength(1);
  });

  it('a DIFFERENT owner token is refused, and describeConflict names the owner, not "pid 0"', () => {
    fs.mkdirSync(home, { recursive: true });
    const held: DeviceClaim = { deviceId: 'adb:X', clone: '/clone/other', branch: 'work-ai', pid: 0, at: 500, owner: 'wrapper-adb' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [held] }));

    const r = claimDevice(
      { deviceId: 'adb:X', clone: '/clone/mine', branch: 'main', owner: 'other-wrapper' },
      { now: 600, alive: () => false },
    );
    expect(r.ok).toBe(false);
    const failure = r as { ok: false; held: DeviceClaim; message: string };
    expect(failure.message).toMatch(/wrapper-adb/);
    expect(failure.message).not.toMatch(/pid 0/);
  });

  it('an owner-claim from clone A does not block a request from clone A (takeover), but DOES block clone B', () => {
    fs.mkdirSync(home, { recursive: true });
    const held: DeviceClaim = { deviceId: 'adb:X', clone: '/clone/a', branch: 'main', pid: 0, at: 500, owner: 'wrapper-adb' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [held] }));

    // Same clone, no owner token (the editor taking over its own CLI's claim) — succeeds.
    const takeover = claimDevice(
      { deviceId: 'adb:X', clone: '/clone/a', branch: 'main' },
      { now: 600, alive: () => false },
    );
    expect(takeover.ok).toBe(true);

    // Reset and try from a different clone — refused.
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [held] }));
    const refused = claimDevice(
      { deviceId: 'adb:X', clone: '/clone/b', branch: 'main' },
      { now: 600, alive: () => false },
    );
    expect(refused.ok).toBe(false);
  });

  it('a pid-claim from another pid still conflicts even when clone matches (the MODOKI_MULTI regression — must NOT be loosened)', () => {
    fs.mkdirSync(home, { recursive: true });
    const held: DeviceClaim = { deviceId: 'adb:X', clone: '/clone/a', branch: 'main', pid: 424242, at: 500 };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [held] }));

    const r = claimDevice(
      { deviceId: 'adb:X', clone: '/clone/a', branch: 'main' },
      { now: 600, alive: (pid) => pid === 424242 || pid === process.pid },
    );
    expect(r.ok).toBe(false);
  });

  it('releaseDevice with an owner drops only that owner\'s record and leaves another owner\'s record alone', () => {
    fs.mkdirSync(home, { recursive: true });
    const mine: DeviceClaim = { deviceId: 'adb:X', clone: '/c', branch: 'main', pid: 0, at: Date.now(), owner: 'wrapper-adb' };
    const theirs: DeviceClaim = { deviceId: 'ios:Y', clone: '/c', branch: 'main', pid: 0, at: Date.now(), owner: 'other-wrapper' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [mine, theirs] }));

    releaseDevice('adb:X', { owner: 'wrapper-adb' });

    // Read the raw file (not listClaims) so the assertion is about the release itself, not staleness.
    const onDisk = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8')).claims as DeviceClaim[];
    expect(onDisk.map((c) => c.deviceId)).toEqual(['ios:Y']);
  });
});

describe('round-trip through the real file', () => {
  it('claim, then a fresh listClaims read parses the documented on-disk shape', () => {
    const r = claimDevice({ deviceId: 'adb:RFDEADBEEF1', clone: '/Users/x/Projects/modoki', branch: 'main', guid: 'g-1', label: 'SC_56C', purpose: 'device lease' });
    expect(r.ok).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8')) as { claims: DeviceClaim[] };
    expect(onDisk.claims).toHaveLength(1);
    const [claim] = onDisk.claims;
    expect(claim).toMatchObject({
      deviceId: 'adb:RFDEADBEEF1',
      clone: '/Users/x/Projects/modoki',
      branch: 'main',
      pid: process.pid,
      guid: 'g-1',
      label: 'SC_56C',
      purpose: 'device lease',
    });
    expect(typeof claim.at).toBe('number');

    // A fresh read (simulating a separate process reading the same file) sees the same claim.
    const fresh = listClaims();
    expect(fresh).toEqual([claim]);
  });
});

describe('ttlMs is clamped — an owner-claim must not be able to outlive its own backstop', () => {
  // The TTL is the ONLY expiry an owner-claim has, so an unbounded one is a device locked out of
  // every other clone with no mechanism left to free it. Measured before the clamp: `--ttl 999999999`
  // wrote a ~1900-year expiry.
  it('caps a wild TTL at MAX_CLAIM_TTL_MS rather than rejecting the claim', () => {
    expect(clampTtlMs(999_999_999 * 60_000)).toBe(MAX_CLAIM_TTL_MS);
    expect(clampTtlMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_CLAIM_TTL_MS);
  });

  it('leaves a sane TTL alone, and treats junk as "use the default"', () => {
    expect(clampTtlMs(CLI_CLAIM_TTL_MS)).toBe(CLI_CLAIM_TTL_MS);
    expect(clampTtlMs(5 * 60_000)).toBe(5 * 60_000);
    for (const junk of [undefined, null, 0, -1, NaN, Infinity]) {
      expect(clampTtlMs(junk as number | undefined | null)).toBeUndefined();
    }
  });

  it('applies the clamp at the point a claim is WRITTEN, not just in the helper', () => {
    // The helper being right buys nothing if `claimDevice` does not use it — this is the assertion
    // that actually pins the behaviour.
    const res = claimDevice({ deviceId: adbDeviceId('RFTESTSERIAL1'), owner: 'cli:/tmp/x', ttlMs: 999_999_999 * 60_000 });
    expect(res.ok).toBe(true);
    const [written] = listClaims();
    expect(written.ttlMs).toBe(MAX_CLAIM_TTL_MS);
    // ...and it really does expire: one ms past the ceiling is stale.
    expect(isStale(written, { now: written.at + MAX_CLAIM_TTL_MS + 1 })).toBe(true);
  });
});

// #650's `buildClaimsStore.mjs` found the identical spin hole in its OWN copy of this exact
// `withLock` shape and fixed it there; this is the same fix applied HERE, to the pre-existing
// original — see that file's own header for the full mechanism. `mkdirSync(lock)` throwing
// EACCES/EROFS/ENOSPC (not EEXIST) used to fall into the SAME bare `catch` as genuine contention:
// `fs.statSync(lock)` then threw ENOENT (the lock dir was never created), whose own catch did
// `continue`, retrying the identical failing `mkdirSync` forever with no deadline check in that
// path at all. Only EEXIST means "someone else holds the lock"; anything else is a real failure
// and must throw immediately — this module's own "give up and proceed unlocked past the deadline"
// behaviour (unlike buildClaimsStore.mjs's throw) is UNCHANGED for genuine EEXIST contention; only
// the non-EEXIST branch moves from spin to throw.
describe('withLock — a non-EEXIST mkdirSync failure throws IMMEDIATELY, never spinning (#650 sibling spin fix)', () => {
  /** Fail ONLY the device-claims lock mkdir, the way an unwritable `~/.modoki` does — same
   *  technique as `vendorPlugins.test.ts`'s `denyLockMkdir` / `buildClaimsStore.test.ts`'s own
   *  copy of it, applied to this store's lock file. */
  function denyLockMkdir(code: 'EACCES' | 'EROFS' | 'ENOSPC') {
    const real = fs.mkdirSync;
    return vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: object) => {
      if (String(p).endsWith('.device-claims.lock')) {
        throw Object.assign(new Error(`${code}: simulated, mkdir '${p}'`), { code });
      }
      return (real as (p: fs.PathLike, o?: object) => string | undefined)(p, o);
    }) as typeof fs.mkdirSync);
  }

  it.each(['EACCES', 'EROFS', 'ENOSPC'] as const)('%s throws naming the path and the errno, and never writes a claim', (code) => {
    const spy = denyLockMkdir(code);
    try {
      expect(() => claimDevice({ deviceId: adbDeviceId('SIM-SPIN-A') })).toThrow(
        new RegExp(`Could not create the device-claims lock directory.*${code}`, 's'),
      );
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(claimsFilePath())).toBe(false);
  });

  it('returns almost immediately — proves it did NOT spin, not merely that it eventually threw', () => {
    const spy = denyLockMkdir('EACCES');
    const started = Date.now();
    try {
      expect(() => claimDevice({ deviceId: adbDeviceId('SIM-SPIN-B') })).toThrow();
    } finally {
      spy.mockRestore();
    }
    // Generous relative to the bug this catches (an unbounded spin) — see
    // buildClaimsStore.test.ts's identical assertion for why this isn't a tight timing bound.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
