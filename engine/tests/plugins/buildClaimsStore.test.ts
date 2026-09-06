/**
 * buildClaimsStore tests (#650) — the cross-process claim on `<project>/dist` that
 * `buildLock.ts`'s in-process `acquireBuild` cannot provide, because a CLI script
 * (`build-web.mjs`, `add-native-targets.mjs`, `ota-publish.mjs`) is a SEPARATE PROCESS.
 *
 * MODOKI_HOME is pointed at a per-test temp dir for every test in this file, same discipline as
 * `deviceClaims.test.ts`: a bug here writing to the developer's REAL `~/.modoki/build-claims.json`
 * would be a false "already building" refusal on their own machine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  claimsDir,
} from '../../scripts/deviceClaimsStore.mjs';
import {
  isPidAlive,
  isStale,
  acquireBuildClaim,
  readBuildClaim,
  describeBuildClaimConflict,
  resetBuildClaimsForTests,
  BUILD_CLAIM_TTL_MS,
  BUILD_CLAIM_ENV_VAR,
} from '../../scripts/buildClaimsStore.mjs';
import type { BuildClaim } from '../../scripts/buildClaimsStore.d.mts';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
});

afterEach(() => {
  resetBuildClaimsForTests();
  if (prevHome === undefined) delete process.env.MODOKI_HOME;
  else process.env.MODOKI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const claimsFilePath = () => path.join(claimsDir(), 'build-claims.json');

describe('claimsDir (shared with deviceClaimsStore)', () => {
  it('honours MODOKI_HOME rather than the real home directory', () => {
    expect(claimsDir()).toBe(home);
  });
});

describe('isStale', () => {
  const base: BuildClaim = { projectRoot: '/p', pid: 999, at: 1_000_000, label: 'ios build', kind: 'editor', token: 't1' };

  it('a dead pid is stale regardless of age (even ONE ms old)', () => {
    expect(isStale({ ...base, at: 999_999 }, { now: 1_000_000, alive: () => false })).toBe(true);
  });

  it('a live pid within the TTL is not stale', () => {
    expect(isStale(base, { now: base.at + 1000, alive: () => true })).toBe(false);
  });

  it('a live pid past BUILD_CLAIM_TTL_MS is stale', () => {
    expect(isStale(base, { now: base.at + BUILD_CLAIM_TTL_MS + 1, alive: () => true })).toBe(true);
  });

  it('exactly at the TTL boundary is not yet stale (strictly greater-than)', () => {
    expect(isStale(base, { now: base.at + BUILD_CLAIM_TTL_MS, alive: () => true })).toBe(false);
  });

  it('a claim stamped in the FUTURE (clock skew) is NOT stale — only genuine age counts', () => {
    expect(isStale({ ...base, at: 2_000_000 }, { now: 1_000_000, alive: () => true })).toBe(false);
  });

  it('defaults to isPidAlive and Date.now() when opts are omitted', () => {
    expect(isStale({ ...base, pid: process.pid, at: Date.now() })).toBe(false);
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
});

describe('acquireBuildClaim — accept side', () => {
  it('grants the slot when nothing holds it, and writes the claim to disk', () => {
    const r = acquireBuildClaim('/proj/a', 'ios build', { kind: 'editor', now: 1000 });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(claimsFilePath())).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(onDisk.claims).toHaveLength(1);
    expect(onDisk.claims[0]).toMatchObject({ projectRoot: '/proj/a', pid: process.pid, label: 'ios build', kind: 'editor', at: 1000 });
    expect(typeof onDisk.claims[0].token).toBe('string');
  });

  it('resolves the project root, so a relative or trailing-slash path collides with the same claim', () => {
    const abs = path.resolve('/proj/b');
    const first = acquireBuildClaim('/proj/b/', 'ios build');
    expect(first.ok).toBe(true);
    const second = acquireBuildClaim('/proj/b', 'android build');
    expect(second.ok).toBe(false);
    expect(readBuildClaim(abs)?.label).toBe('ios build');
  });

  it('defaults kind to "editor" when not specified', () => {
    acquireBuildClaim('/proj/c', 'x');
    expect(readBuildClaim('/proj/c')?.kind).toBe('editor');
  });

  it('records "cli" when the caller says so', () => {
    acquireBuildClaim('/proj/d', 'web build (CLI)', { kind: 'cli' });
    expect(readBuildClaim('/proj/d')?.kind).toBe('cli');
  });

  it('re-grants after a release', () => {
    const first = acquireBuildClaim('/proj/e', 'web build');
    if (!first.ok) throw new Error('unreachable');
    first.release();
    expect(readBuildClaim('/proj/e')).toBeNull();
    expect(acquireBuildClaim('/proj/e', 'ios build').ok).toBe(true);
  });

  it('release is idempotent', () => {
    const first = acquireBuildClaim('/proj/f', 'web build');
    if (!first.ok) throw new Error('unreachable');
    first.release();
    expect(() => first.release()).not.toThrow();
    expect(readBuildClaim('/proj/f')).toBeNull();
  });
});

describe('acquireBuildClaim — refuse side', () => {
  it('refuses a second claim on the SAME project root, naming the holder', () => {
    acquireBuildClaim('/proj/g', 'ios build', { kind: 'editor', now: 1000, alive: () => true });
    const second = acquireBuildClaim('/proj/g', 'android build', { now: 1000 + 5 * 60_000, alive: () => true });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    // A real competing claim, not the UNKNOWN case (#650) — narrow past that variant too.
    if (!second.held) throw new Error('unreachable');
    // The refusal must identify the IN-FLIGHT claim, not the one being refused.
    expect(second.held.label).toBe('ios build');
    expect(second.held.kind).toBe('editor');
    expect(second.held.pid).toBe(process.pid);
    expect(second.message).toContain('ios build');
    expect(second.message).toContain(String(process.pid));
    expect(second.message).toContain('5 min ago');
  });

  it('refuses even a claim from a DIFFERENT project root only when it actually collides — a sibling project is unaffected', () => {
    acquireBuildClaim('/proj/h1', 'ios build');
    expect(acquireBuildClaim('/proj/h2', 'ios build').ok).toBe(true);
  });

  it('a stale release cannot free a LATER claim on the same project root', () => {
    // The #650 analogue of buildLock.test.ts's "a stale release cannot free a LATER build slot" —
    // proving release identity is per-ACQUISITION (a token), not per-project-root or per-pid: the
    // same pid legitimately re-acquires after releasing (a CLI script run twice in a row).
    const first = acquireBuildClaim('/proj/i', 'web build');
    if (!first.ok) throw new Error('unreachable');
    first.release();
    const second = acquireBuildClaim('/proj/i', 'ios build');
    expect(second.ok).toBe(true);
    first.release(); // the old closure fires late
    expect(readBuildClaim('/proj/i')?.label).toBe('ios build');
    expect(acquireBuildClaim('/proj/i', 'android build').ok).toBe(false);
  });

  it('a DEAD-pid claim is stale and silently overtaken, not refused', () => {
    fs.mkdirSync(home, { recursive: true });
    const dead: BuildClaim = { projectRoot: '/proj/j', pid: 424242, at: 500, label: 'stale build', kind: 'cli', token: 'old' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [dead] }));

    const r = acquireBuildClaim('/proj/j', 'fresh build', { now: 600, alive: (pid) => pid === process.pid });
    expect(r.ok).toBe(true);
  });

  it('a LIVE-pid claim within the TTL is refused, not overtaken', () => {
    fs.mkdirSync(home, { recursive: true });
    const live: BuildClaim = { projectRoot: '/proj/k', pid: 424242, at: 500, label: 'in-flight build', kind: 'editor', token: 'tok' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [live] }));

    const r = acquireBuildClaim('/proj/k', 'new build', { now: 600, alive: (pid) => pid === 424242 || pid === process.pid });
    expect(r.ok).toBe(false);
  });

  it('a live claim PAST BUILD_CLAIM_TTL_MS is stale and overtaken', () => {
    fs.mkdirSync(home, { recursive: true });
    const old: BuildClaim = { projectRoot: '/proj/l', pid: 424242, at: 1_000, label: 'ancient build', kind: 'editor', token: 'tok' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [old] }));

    const r = acquireBuildClaim('/proj/l', 'new build', { now: 1_000 + BUILD_CLAIM_TTL_MS + 1, alive: () => true });
    expect(r.ok).toBe(true);
  });

  it('a future-stamped claim (clock skew) is NOT expired — refused, not overtaken', () => {
    fs.mkdirSync(home, { recursive: true });
    const skewed: BuildClaim = { projectRoot: '/proj/m', pid: 424242, at: 2_000_000, label: 'clock-skewed build', kind: 'editor', token: 'tok' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [skewed] }));

    const r = acquireBuildClaim('/proj/m', 'new build', { now: 1_000_000, alive: (pid) => pid === 424242 || pid === process.pid });
    expect(r.ok).toBe(false);
  });
});

// The deadlock this closes (reproduced): `/api/build`/`/api/ota/publish`/`/api/add-native-target`
// hold the claim for their WHOLE pipeline and then spawn `build-web.mjs` as a CHILD process with
// the identical MODOKI_PROJECT — which resolves the SAME root and, before this fix, refused
// itself unconditionally (every check above is deliberately "one live claim per root, no
// exceptions"). The fix is a re-entrancy signal the child inherits through the environment, not a
// relaxation of that rule — see buildClaimsStore.mjs's own header, "Re-entrancy through a CHILD
// PROCESS". These are the pure, in-process unit tests of `acquireBuildClaim`'s own comparison;
// `cliBuildClaims.test.ts`'s "inherits an ancestor claim… instead of deadlocking" spawns the REAL
// build-web.mjs to prove the end-to-end property these units add up to.
describe('acquireBuildClaim — re-entrancy pass-through for a CHILD process (#650 deadlock fix)', () => {
  it('publishes the token onto BUILD_CLAIM_ENV_VAR on a successful grant', () => {
    const r = acquireBuildClaim('/proj/env-a', 'ios build');
    expect(r.ok).toBe(true);
    expect(process.env[BUILD_CLAIM_ENV_VAR]).toBe(readBuildClaim('/proj/env-a')?.token);
  });

  // These write the ANCESTOR claim directly to disk with a pid that is deliberately NOT
  // `process.pid` (same technique the "a DEAD-pid claim…"/"a LIVE-pid claim…" tests above already
  // use to simulate "someone else holds this"), rather than acquiring twice from this same test
  // process — see the pid guard's own comment in buildClaimsStore.mjs for why that distinction is
  // load-bearing: a bare token match is not enough, because the SAME process re-acquiring its own
  // still-live claim would otherwise also match (its own token is still sitting in
  // `process.env[BUILD_CLAIM_ENV_VAR]` from the first grant), and that case must stay refused.
  it('a matching envToken for the SAME resolved root, from a DIFFERENT pid, grants a pass-through instead of refusing', () => {
    fs.mkdirSync(home, { recursive: true });
    const ancestor: BuildClaim = { projectRoot: path.resolve('/proj/env-b'), pid: 999_999, at: Date.now(), label: 'ios build', kind: 'editor', token: 'ancestor-token' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [ancestor] }));
    const alive = (pid: number) => pid === 999_999;
    const inherited = acquireBuildClaim('/proj/env-b', 'ios build (CLI)', { kind: 'cli', envToken: 'ancestor-token', alive });
    expect(inherited.ok).toBe(true);
    // A pass-through never writes to the claims file — the ancestor's IS the acquisition — so the
    // claim on disk is unchanged: still the ancestor's own record, not a new one for the child.
    expect(readBuildClaim('/proj/env-b', { alive })).toEqual(ancestor);
  });

  it("the pass-through's release() is a genuine no-op — it cannot free the ancestor's claim", () => {
    fs.mkdirSync(home, { recursive: true });
    const ancestor: BuildClaim = { projectRoot: path.resolve('/proj/env-c'), pid: 999_999, at: Date.now(), label: 'ios build', kind: 'editor', token: 'ancestor-token' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [ancestor] }));
    const alive = (pid: number) => pid === 999_999;
    const inherited = acquireBuildClaim('/proj/env-c', 'ios build (CLI)', { kind: 'cli', envToken: 'ancestor-token', alive });
    if (!inherited.ok) throw new Error('unreachable');
    inherited.release(); // the CHILD exits first — must not disturb the ancestor's still-live claim
    expect(readBuildClaim('/proj/env-c', { alive })).toEqual(ancestor);
  });

  it('the SAME pid re-acquiring its OWN still-live claim is refused, not passed through, even though the token still matches', () => {
    // The regression this guards: `process.env[BUILD_CLAIM_ENV_VAR]` still carries THIS process's
    // own token after the first grant — a re-entrant call from the SAME process (never a real
    // child) must not read that ambient token as "I am a descendant" and pass through. Caught
    // during development by this exact shape breaking the pre-existing "refuses a second claim on
    // the SAME project root" test below (a token-only comparison passed both, wrongly).
    const first = acquireBuildClaim('/proj/env-self', 'ios build');
    if (!first.ok) throw new Error('unreachable');
    const second = acquireBuildClaim('/proj/env-self', 'android build');
    expect(second.ok).toBe(false);
  });

  it('a STALE token (the claim it named has already been released) does not grant a pass-through — falls through to an ordinary fresh grant', () => {
    const first = acquireBuildClaim('/proj/env-d', 'ios build');
    if (!first.ok) throw new Error('unreachable');
    const staleToken = process.env[BUILD_CLAIM_ENV_VAR];
    first.release();
    expect(process.env[BUILD_CLAIM_ENV_VAR]).toBeUndefined(); // released — see the next test
    // Simulate a child process that still carries the old (now-dead) token in its inherited env.
    process.env[BUILD_CLAIM_ENV_VAR] = staleToken;
    const second = acquireBuildClaim('/proj/env-d', 'android build');
    expect(second.ok).toBe(true);
    // Not a pass-through: a genuine NEW claim was written, with a NEW token.
    expect(readBuildClaim('/proj/env-d')?.label).toBe('android build');
    expect(readBuildClaim('/proj/env-d')?.token).not.toBe(staleToken);
  });

  it("a FOREIGN token (naming a DIFFERENT project's live claim) does not grant a pass-through — refused, not bypassed", () => {
    fs.mkdirSync(home, { recursive: true });
    const other: BuildClaim = { projectRoot: path.resolve('/proj/env-other'), pid: 999_999, at: Date.now(), label: 'other build', kind: 'editor', token: 'other-token' };
    const held: BuildClaim = { projectRoot: path.resolve('/proj/env-e'), pid: 888_888, at: Date.now(), label: 'ios build', kind: 'editor', token: 'held-token' };
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [other, held] }));
    const alive = (pid: number) => pid === 999_999 || pid === 888_888;
    // A child that inherited a token for a DIFFERENT project (`/proj/env-other`'s claim) while
    // trying to build `/proj/env-e` — a stale env value from an earlier build in the same
    // long-lived process, say. It names a live claim, but not the one actually held here.
    const conflict = acquireBuildClaim('/proj/env-e', 'android build', { envToken: 'other-token', alive });
    expect(conflict.ok).toBe(false);
  });

  it('clears BUILD_CLAIM_ENV_VAR on release, matched by TOKEN — a stale release cannot erase a NEWER grant\'s signal', () => {
    const first = acquireBuildClaim('/proj/env-f', 'web build');
    if (!first.ok) throw new Error('unreachable');
    first.release();
    expect(process.env[BUILD_CLAIM_ENV_VAR]).toBeUndefined();

    const second = acquireBuildClaim('/proj/env-f', 'ios build');
    if (!second.ok) throw new Error('unreachable');
    const secondToken = process.env[BUILD_CLAIM_ENV_VAR];
    first.release(); // the old closure fires late — must not clear the SECOND grant's own token
    expect(process.env[BUILD_CLAIM_ENV_VAR]).toBe(secondToken);
  });

  it('resetBuildClaimsForTests clears BUILD_CLAIM_ENV_VAR — a leaked token must not survive into the next test', () => {
    acquireBuildClaim('/proj/env-g', 'ios build');
    expect(process.env[BUILD_CLAIM_ENV_VAR]).toBeDefined();
    resetBuildClaimsForTests();
    expect(process.env[BUILD_CLAIM_ENV_VAR]).toBeUndefined();
  });
});

// #650 — a corrupt/unreadable build-claims.json used to be indistinguishable from an absent one:
// `readClaims`'s single catch returned `[]` either way, so `acquireBuildClaim` read "corrupt" as
// "nothing holds this" and granted a claim on top of one it simply couldn't see — reopening the
// exact torn-dist race this module exists to prevent, through the READ path rather than the LOCK
// path (which is already covered by the "withLock refuses..." block below). Three-way split now:
// absent → proceed silently (the negative control, first below); present-but-unreadable/wrong-shape
// → refuse, never grant, never write.
describe('acquireBuildClaim — a corrupt/unreadable claims file is UNKNOWN, not empty (#650)', () => {
  it('an ABSENT claims file grants the claim — the negative control this must stay true for', () => {
    // Nothing has been written into `home` at all yet (see beforeEach) — the ordinary first-run
    // case, and it must stay exactly this silent.
    expect(fs.existsSync(claimsFilePath())).toBe(false);
    const r = acquireBuildClaim('/proj/corrupt-control', 'x');
    expect(r.ok).toBe(true);
  });

  it('invalid JSON refuses the build and names the file in the message', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(claimsFilePath(), '{ not valid json');

    const r = acquireBuildClaim('/proj/corrupt-a', 'x');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain(claimsFilePath());
    // UNKNOWN carries no holder to name — unlike a real conflict (see the "refuse side" block
    // above, which always has `held`).
    expect('held' in r).toBe(false);
  });

  it('valid JSON but the wrong shape is ALSO refused, not read as empty', () => {
    // `writeClaims` only ever produces `{ claims: [...] }`. A top-level array, or a `claims` field
    // that isn't one, still parses as valid JSON but is a shape this module never writes itself —
    // so it means hand-edited or corrupted, not legitimately emptied. Treated as UNKNOWN for the
    // same reason invalid JSON is, rather than as "no claims" (which is what the old single-catch
    // version effectively did via `Array.isArray(...) ? ... : []`).
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: 'nonsense' }));
    expect(acquireBuildClaim('/proj/corrupt-b', 'x').ok).toBe(false);

    fs.writeFileSync(claimsFilePath(), JSON.stringify([]));
    expect(acquireBuildClaim('/proj/corrupt-c', 'x').ok).toBe(false);
  });

  it('does NOT write a claim in the refusal case — a refusal that still wrote would corrupt things further', () => {
    fs.mkdirSync(home, { recursive: true });
    const before = 'not json at all';
    fs.writeFileSync(claimsFilePath(), before);

    const r = acquireBuildClaim('/proj/corrupt-d', 'x');
    expect(r.ok).toBe(false);
    // The file on disk is untouched — still the same corrupt bytes, not overwritten with a fresh
    // (wrong) claims array, and no claim for /proj/corrupt-d exists anywhere.
    expect(fs.readFileSync(claimsFilePath(), 'utf8')).toBe(before);
  });

  it('readBuildClaim (the lock-free advisory read) returns null on an unparseable file — a documented choice, not a silent "nothing holds this"', () => {
    // readBuildClaim has no production caller today and is advisory/reporting only — see its own
    // comment for why null is an acceptable answer here even though it would NOT be for
    // acquireBuildClaim's gate. Pinning the actual behaviour so a later caller that starts using
    // this to gate something notices the caveat in the comment, not just the return type.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(claimsFilePath(), '{ not valid json');
    expect(readBuildClaim('/proj/corrupt-e')).toBeNull();
  });
});

describe('describeBuildClaimConflict', () => {
  it('names the project root, label, kind, pid and elapsed time for an editor holder', () => {
    const held: BuildClaim = { projectRoot: '/Users/x/Projects/modoki/games/sling', pid: 8123, at: Date.now() - 5 * 60_000, label: 'ios build', kind: 'editor', token: 't' };
    const msg = describeBuildClaimConflict(held);
    expect(msg).toMatch(/an editor/);
    expect(msg).toMatch(/\/Users\/x\/Projects\/modoki\/games\/sling/);
    expect(msg).toMatch(/ios build/);
    expect(msg).toMatch(/8123/);
    expect(msg).toMatch(/\d+ min ago/);
  });

  it('names a CLI holder distinctly from an editor', () => {
    const held: BuildClaim = { projectRoot: '/p', pid: 1, at: Date.now(), label: 'OTA publish (CLI): shell@v13', kind: 'cli', token: 't' };
    expect(describeBuildClaimConflict(held)).toMatch(/a command-line build/);
  });
});

// #650 divergence 1 — see buildClaimsStore.mjs's `withLock` comment. deviceClaimsStore.mjs:264
// gives up and proceeds WITHOUT the lock once its wait window passes ("never block hardware on a
// lock"), which is correct for a device and WRONG for a build claim: proceeding unlocked risks
// losing a write in the read-modify-write, which is the exact torn-claim (and so torn-dist) race
// this file exists to prevent. This must stay a THROW — a later "cleanup" that makes the two
// modules "consistent" by removing it would silently restore the fail-open behaviour.
describe('withLock refuses rather than proceeding unlocked when it cannot get the lock in time (#650 divergence 1)', () => {
  it('throws, and does NOT write a claim, when the lock is held by someone else past the deadline', () => {
    fs.mkdirSync(home, { recursive: true });
    // Simulate another process mid-write: the lock dir exists and is FRESH (nowhere near
    // deviceClaimsStore's 5s abandonment threshold), so the only way `acquireBuildClaim` can ever
    // stop waiting is the (short, test-only) `deadlineMs` below — never the "this lock looks
    // abandoned" path, which is a DIFFERENT condition this test must not conflate with.
    fs.mkdirSync(path.join(home, '.build-claims.lock'));

    expect(() => acquireBuildClaim('/proj/n', 'x', { deadlineMs: 50 })).toThrow(/timed out/i);
    // Crucially: nothing was written while unlocked.
    expect(fs.existsSync(claimsFilePath())).toBe(false);
    expect(readBuildClaim('/proj/n')).toBeNull();
  });
});

// #799 follow-up (BLOCKER 1): the divergence-1 THROW above is correct for ACQUIRE (losing the
// claim in an unlocked read-modify-write reopens the torn-dist race), but `releaseBuildClaimByToken`
// used to call the SAME throwing `withLock` with nothing wrapping it, so `release()` itself became
// a throwing function. Four production call sites invoke it from a place that cannot tolerate an
// exception (an EventEmitter `close` listener in `vite-asset-scanner.ts`, a floating `.finally()`
// in that file and in `build-web.mjs`/`ota-publish.mjs`/`add-native-targets.mjs`) — a thrown release
// there is an uncaught exception or an unhandled rejection, either of which can take the whole
// process down over a build that already finished successfully.
describe('releaseBuildClaimByToken never throws, even when the lock cannot be taken (#799 follow-up)', () => {
  /** Same technique as `denyLockMkdir` below, applied on the RELEASE path instead of acquire. */
  function denyBuildClaimsLockMkdir() {
    const real = fs.mkdirSync;
    return vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: object) => {
      if (String(p).endsWith('.build-claims.lock')) {
        throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' });
      }
      return (real as (p: fs.PathLike, o?: object) => string | undefined)(p, o);
    }) as typeof fs.mkdirSync);
  }

  it('release() does not throw when the lock cannot be created', () => {
    const first = acquireBuildClaim('/proj/release-throw-a', 'ios build');
    if (!first.ok) throw new Error('unreachable');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = denyBuildClaimsLockMkdir();
    try {
      expect(() => first.release()).not.toThrow();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('warns rather than staying silent about the failed release', () => {
    const first = acquireBuildClaim('/proj/release-throw-b', 'ios build');
    if (!first.ok) throw new Error('unreachable');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = denyBuildClaimsLockMkdir();
    try {
      first.release();
    } finally {
      spy.mockRestore();
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still clears BUILD_CLAIM_ENV_VAR even though the on-disk write could not happen', () => {
    const first = acquireBuildClaim('/proj/release-throw-c', 'ios build');
    if (!first.ok) throw new Error('unreachable');
    expect(process.env[BUILD_CLAIM_ENV_VAR]).toBeDefined();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = denyBuildClaimsLockMkdir();
    try {
      first.release();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    // A later acquireBuildClaim call in THIS process must not read a stale re-entrancy token as
    // "I am a descendant of the process that already holds this" — see acquireBuildClaim's own
    // pid-guard comment for why a leaked env token would be load-bearing wrong, not merely untidy.
    expect(process.env[BUILD_CLAIM_ENV_VAR]).toBeUndefined();
  });

  it('leaves the on-disk claim untouched — the pid/TTL staleness check is the backstop, not this call', () => {
    const first = acquireBuildClaim('/proj/release-throw-d', 'ios build');
    if (!first.ok) throw new Error('unreachable');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = denyBuildClaimsLockMkdir();
    try {
      first.release();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    // The write that would have removed this claim never ran — the lock could never be taken to
    // do it. Silently swallowing the failure must not pretend the claim is gone: a caller that
    // acquires again immediately, believing the release succeeded, would still see this held.
    expect(readBuildClaim('/proj/release-throw-d')?.label).toBe('ios build');
  });
});

// The infinite-spin bug this closes (reproduced): `mkdirSync(lock)` throwing EACCES/EROFS/ENOSPC
// (not EEXIST) fell into the SAME bare `catch` as genuine contention — `fs.statSync(lock)` then
// threw ENOENT (the lock dir was never created), whose own catch did `continue`, retrying the
// identical failing `mkdirSync` forever with NO deadline check in that path at all (measured:
// 2m12s at 30% CPU before being killed). Only EEXIST means "someone else holds the lock"; anything
// else is a real failure and must throw immediately. The EEXIST case itself (genuine contention,
// deadline honoured) is the describe block just above — this is its sibling, the errno split.
describe('withLock — a non-EEXIST mkdirSync failure throws IMMEDIATELY, never spinning to the deadline (#650 spin fix)', () => {
  /** Fail ONLY the lock mkdir with a specific errno, the way an unwritable `~/.modoki` does —
   *  same technique as `vendorPlugins.test.ts`'s `denyLockMkdir`, applied to this file's own lock. */
  function denyLockMkdir(code: 'EACCES' | 'EROFS' | 'ENOSPC') {
    const real = fs.mkdirSync;
    return vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: object) => {
      if (String(p).endsWith('.build-claims.lock')) {
        throw Object.assign(new Error(`${code}: simulated, mkdir '${p}'`), { code });
      }
      return (real as (p: fs.PathLike, o?: object) => string | undefined)(p, o);
    }) as typeof fs.mkdirSync);
  }

  it.each(['EACCES', 'EROFS', 'ENOSPC'] as const)('%s throws naming the path and the errno, and never writes a claim', (code) => {
    const spy = denyLockMkdir(code);
    try {
      expect(() => acquireBuildClaim('/proj/spin-a', 'x')).toThrow(
        new RegExp(`Could not create the build-claims lock directory.*${code}`, 's'),
      );
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(claimsFilePath())).toBe(false);
  });

  it('returns almost immediately — proves it did NOT spin/wait, not merely that it eventually threw', () => {
    // A GENEROUS bound relative to the bug: the measured failure burned 2m12s; a busy-wait fix
    // that merely shortened the spin (rather than removing it) would still very visibly exceed
    // this. Not a tight timing assertion — see buildStepEnv.test.ts's own "no wall-clock bound"
    // reasoning elsewhere in this suite for why a TIGHT bound would be the wrong kind of test;
    // this one only has to distinguish "instant" from "spun for any perceptible time at all".
    const spy = denyLockMkdir('EACCES');
    const started = Date.now();
    try {
      expect(() => acquireBuildClaim('/proj/spin-b', 'x', { deadlineMs: 30_000 })).toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('preserves the original fs error as `cause`, for a human reading the stack', () => {
    const spy = denyLockMkdir('EACCES');
    try {
      expect.assertions(1);
      try {
        acquireBuildClaim('/proj/spin-c', 'x');
      } catch (e) {
        expect((e as Error & { cause?: { code?: string } }).cause?.code).toBe('EACCES');
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('round-trip through the real file', () => {
  it('claim, then a fresh readBuildClaim parses the documented on-disk shape', () => {
    const r = acquireBuildClaim('/Users/x/Projects/modoki/games/sling', 'ios build', { kind: 'editor' });
    expect(r.ok).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8')) as { claims: BuildClaim[] };
    expect(onDisk.claims).toHaveLength(1);

    // A fresh read (simulating a separate process reading the same file) sees the same claim.
    const fresh = readBuildClaim('/Users/x/Projects/modoki/games/sling');
    expect(fresh).toEqual(onDisk.claims[0]);
  });
});

// ── THE cross-process proof. Nothing else in the repo spawns two real processes racing the SAME
// claim — buildLock.test.ts's 18 cases are pure in-process unit tests, which is exactly the class
// of bug #650 is about: an in-process lock cannot see a second PROCESS. Two real `node`
// subprocesses (precedent: cliNativeBuildHeals.test.ts's "no-esbuild" case) both try to claim the
// same project root against a shared temp claims dir (never the real ~/.modoki); the assertion is
// that EXACTLY ONE wins — proving the O_EXCL mkdir lock genuinely serializes across OS processes,
// not merely across calls within one.
describe('cross-process: two real node processes racing the same claim (#650)', () => {
  it('exactly one process wins the claim', async () => {
    const storePath = path.join(repoRoot, 'engine', 'scripts', 'buildClaimsStore.mjs');
    const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-claim-race-'));
    const runnerPath = path.join(runnerDir, 'claim-race-runner.mjs');
    fs.writeFileSync(
      runnerPath,
      `
      const [, , storeHref, root, label] = process.argv;
      const { acquireBuildClaim } = await import(storeHref);
      const r = acquireBuildClaim(root, label, { kind: 'cli' });
      // A winner must stay ALIVE for a moment before exiting: isStale treats a dead pid as stale
      // IMMEDIATELY (by design — see the .mjs header), so if this process exited the instant it
      // won, the sibling process (scheduled a hair later) would see a pid that is ALREADY GONE and
      // correctly treat the claim as free — not a bug in the store, but it would defeat this exact
      // test's ability to observe the lock actually serializing the two attempts.
      if (r.ok) await new Promise((resolve) => setTimeout(resolve, 400));
      process.stdout.write(JSON.stringify({ ok: r.ok, pid: process.pid }));
      `,
    );
    const raceRoot = path.join(home, 'race-project');
    const storeHref = pathToFileURL(storePath).href;
    const env = { ...process.env, MODOKI_HOME: home };

    try {
      const [a, b] = await Promise.all([
        execFileAsync(process.execPath, [runnerPath, storeHref, raceRoot, 'runner A'], { env }),
        execFileAsync(process.execPath, [runnerPath, storeHref, raceRoot, 'runner B'], { env }),
      ]);
      const outA = JSON.parse(a.stdout);
      const outB = JSON.parse(b.stdout);

      // Exactly one of the two real, independent OS processes got the claim — the property the
      // in-process buildLock.test.ts suite structurally cannot exercise (its "slot" is a
      // module-level variable, so two Node PROCESSES each get their own, and BOTH would report
      // "ok:true" if the cross-process file lock weren't real).
      expect([outA.ok, outB.ok].filter(Boolean)).toHaveLength(1);
      expect(outA.pid).not.toBe(outB.pid);
      // Not asserted here: reading the claims file back afterward. By the time BOTH child
      // processes have fully exited (what `execFileAsync` waits for), the WINNER's own exit hook
      // has already auto-released its claim — same as a real CLI script finishing its build — so
      // the file is expected to be empty again at this point, not still holding the winner's pid.
    } finally {
      fs.rmSync(runnerDir, { recursive: true, force: true });
    }
  });
});
