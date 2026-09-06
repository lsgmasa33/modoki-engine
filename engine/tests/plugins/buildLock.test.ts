import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBuild, activeBuild, acquireBuildSlot, describeBuildConflict, releasePolicy, resetBuildLockForTests } from '../../plugins/backend/buildLock';
import { acquireBuildClaim, readBuildClaim, resetBuildClaimsForTests } from '../../scripts/buildClaimsStore.mjs';

afterEach(() => resetBuildLockForTests());

// `acquireBuildSlot` (#650) touches the cross-process claims FILE, unlike every other test in
// this file — isolated the same way buildClaimsStore.test.ts is, so a bug here can never reach
// the developer's real `~/.modoki`.
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

describe('buildLock', () => {
  it('grants the slot when nothing is running', () => {
    const r = acquireBuild('ios build');
    expect(r.ok).toBe(true);
    expect(activeBuild()?.label).toBe('ios build');
  });

  it('refuses a second build and names what holds the slot', () => {
    acquireBuild('ios build', 1000);
    const second = acquireBuild('android build', 1000);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    // acquireBuild is purely in-process and never returns the cross-process UNKNOWN variant (#650)
    // — narrow past it anyway since the type is now shared with acquireBuildSlot's result.
    if (!second.held) throw new Error('unreachable');
    // The refusal must identify the IN-FLIGHT build, not the one being refused — the caller's
    // question is "what is already running", and answering with their own platform is useless.
    expect(second.held.label).toBe('ios build');
    expect(second.message).toContain('ios build');
  });

  it('grants the slot again after a release', () => {
    const first = acquireBuild('web build');
    if (!first.ok) throw new Error('unreachable');
    first.release();
    expect(activeBuild()).toBeNull();
    expect(acquireBuild('ios build').ok).toBe(true);
  });

  it('release is idempotent', () => {
    const first = acquireBuild('web build');
    if (!first.ok) throw new Error('unreachable');
    first.release();
    first.release();
    expect(activeBuild()).toBeNull();
  });

  // The bug this guards: the route releases from `res.on('close')`, so a finished build's closure
  // outlives it. If that stale release cleared whatever is CURRENT, a build starting moments after
  // one ended would have its slot silently freed — re-opening the exact collision the lock exists to
  // prevent, and only under the timing that makes it hardest to reproduce.
  it('a stale release cannot free a LATER build slot', () => {
    const first = acquireBuild('web build');
    if (!first.ok) throw new Error('unreachable');
    first.release();
    const second = acquireBuild('ios build');
    expect(second.ok).toBe(true);
    first.release(); // the old closure fires late
    expect(activeBuild()?.label).toBe('ios build');
    expect(acquireBuild('android build').ok).toBe(false);
  });

  it('reports how long the held build has been running', () => {
    const started = Date.parse('2026-08-08T10:00:00Z');
    expect(describeBuildConflict({ label: 'android build', startedAt: started }, started + 7 * 60_000))
      .toContain('7 min ago');
  });

  it('never reports a negative age when the clock moves backwards', () => {
    const started = Date.parse('2026-08-08T10:00:00Z');
    expect(describeBuildConflict({ label: 'ios build', startedAt: started }, started - 60_000))
      .toContain('0 min ago');
  });
});

// The slot is shared by THREE routes, not just /api/build (#173 close-out): /api/ota/publish and
// /api/add-native-target compile the byte-identical `build-web.mjs --target native` into the
// byte-identical `<project>/dist`. A per-route lock would have left the worst case open — a publish
// racing a build ships the torn dist to installed devices.
describe('one slot across all three pipelines', () => {
  it('an OTA publish is refused while a build holds the slot, and vice versa', () => {
    const build = acquireBuild('ios build');
    if (!build.ok) throw new Error('unreachable');
    const publish = acquireBuild('OTA publish');
    expect(publish.ok).toBe(false);
    if (publish.ok) throw new Error('unreachable');
    expect(publish.message).toContain('ios build');
    build.release();
    const retry = acquireBuild('OTA publish');
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('unreachable');
    const build2 = acquireBuild('android build');
    expect(build2.ok).toBe(false);
    if (build2.ok) throw new Error('unreachable');
    expect(build2.message).toContain('OTA publish');
  });

  it('a native scaffold is refused while another scaffold for the same platform runs', () => {
    acquireBuild('ios native scaffold');
    const second = acquireBuild('ios native scaffold');
    expect(second.ok).toBe(false);
  });
});

describe('releasePolicy — which signal gives the slot back', () => {
  const spy = () => { const calls = { n: 0 }; return { calls, release: () => { calls.n += 1; } }; };

  it('a preflight refusal releases on response close — no pipeline ever ran', () => {
    const { calls, release } = spy();
    const p = releasePolicy(release);
    p.onResponseClose();
    expect(calls.n).toBe(1);
  });

  // THE REGRESSION. Releasing on `close` while the pipeline is mid-flight is what the first version
  // of this did: a disconnect (the editor force-reloads the page whenever a game `.ts` is edited,
  // tearing down the EventSource) freed the slot with `npm run build` still flushing into
  // <project>/dist, so a retry starting right then wrote that dist from two processes — the exact
  // interleaving #173 exists to prevent, re-entered through the back door.
  it('a disconnect MID-PIPELINE does NOT release — the pipeline still owns the slot', () => {
    const { calls, release } = spy();
    const p = releasePolicy(release);
    p.onPipelineStart();
    p.onResponseClose();
    expect(calls.n).toBe(0);
    p.onPipelineEnd();
    expect(calls.n).toBe(1);
  });

  it('a normal run releases exactly once, though both signals fire', () => {
    const { calls, release } = spy();
    const p = releasePolicy(release);
    p.onPipelineStart();
    p.onPipelineEnd();   // the pipeline finishes and calls res.end()...
    p.onResponseClose(); // ...which fires close right after
    expect(calls.n).toBe(1);
  });

  it('is order-independent — close arriving before the pipeline settles still yields one release', () => {
    const { calls, release } = spy();
    const p = releasePolicy(release);
    p.onPipelineStart();
    p.onResponseClose();
    p.onPipelineEnd();
    p.onPipelineEnd(); // a second settle (a stray finally) must not double-release
    expect(calls.n).toBe(1);
  });

  it('releases once when the pipeline throws and close follows', () => {
    const { calls, release } = spy();
    const p = releasePolicy(release);
    p.onPipelineStart();
    p.onPipelineEnd(); // `.finally` runs on rejection too
    p.onResponseClose();
    expect(calls.n).toBe(1);
  });
});

describe('buildLock — end-to-end through the release policy', () => {
  it('the slot is NOT re-acquirable while a disconnected build is still winding down', () => {
    const first = acquireBuild('ios build');
    if (!first.ok) throw new Error('unreachable');
    const p = releasePolicy(first.release);
    p.onPipelineStart();
    p.onResponseClose(); // client vanished; xcodebuild is still being torn down
    expect(acquireBuild('android build').ok).toBe(false);
    p.onPipelineEnd();   // the child finally exits
    expect(acquireBuild('android build').ok).toBe(true);
  });
});

// #650: acquireBuildSlot composes the in-process flag above WITH the cross-process claim
// (buildClaimsStore.mjs), so an editor route is refused not only by its own in-flight build but
// by a CLI script (or a second editor process) holding the SAME project's claim, and vice versa.
describe('acquireBuildSlot — in-process AND cross-process (#650)', () => {
  it('grants when both layers are free', () => {
    const r = acquireBuildSlot('ios build', '/proj/a');
    expect(r.ok).toBe(true);
    expect(activeBuild()?.label).toBe('ios build');
    expect(readBuildClaim('/proj/a')?.label).toBe('ios build');
  });

  it('refuses on an in-process conflict WITHOUT ever touching the cross-process claim file', () => {
    acquireBuild('ios build'); // takes the in-process slot directly, bypassing acquireBuildSlot
    const second = acquireBuildSlot('android build', '/proj/b');
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.message).toContain('ios build');
    // The in-process refusal is correctly worded "in this editor" — acquireBuildSlot never got
    // far enough to write a cross-process claim for a project nothing has actually built yet.
    expect(readBuildClaim('/proj/b')).toBeNull();
  });

  it('refuses on a CROSS-PROCESS conflict (a CLI build already holds the claim), naming it distinctly from an in-process one', () => {
    const cli = acquireBuildClaim('/proj/c', 'web build (CLI)', { kind: 'cli' });
    if (!cli.ok) throw new Error('unreachable');
    const editor = acquireBuildSlot('ios build', '/proj/c');
    expect(editor.ok).toBe(false);
    if (editor.ok) throw new Error('unreachable');
    expect(editor.message).toContain('command-line build');
    expect(editor.message).toContain('web build (CLI)');
  });

  it('releases the in-process slot again when the cross-process claim is refused — no false self-refusal on the very next attempt', () => {
    const cli = acquireBuildClaim('/proj/d', 'web build (CLI)', { kind: 'cli' });
    if (!cli.ok) throw new Error('unreachable');
    const refused = acquireBuildSlot('ios build', '/proj/d');
    expect(refused.ok).toBe(false);
    // The in-process slot must be free again — acquireBuildSlot took it, then gave it straight
    // back on the cross-process refusal, so THIS backend has no build actually running.
    expect(activeBuild()).toBeNull();
    cli.release();
    expect(acquireBuildSlot('android build', '/proj/d').ok).toBe(true);
  });

  it('release() gives back BOTH layers, exactly once each', () => {
    const r = acquireBuildSlot('ios build', '/proj/e');
    if (!r.ok) throw new Error('unreachable');
    r.release();
    expect(activeBuild()).toBeNull();
    expect(readBuildClaim('/proj/e')).toBeNull();
    // Idempotent, same contract as acquireBuild's own release.
    expect(() => r.release()).not.toThrow();
  });

  it('a stale release cannot free a LATER acquireBuildSlot on the same project (both layers)', () => {
    const first = acquireBuildSlot('web build', '/proj/f');
    if (!first.ok) throw new Error('unreachable');
    first.release();
    const second = acquireBuildSlot('ios build', '/proj/f');
    expect(second.ok).toBe(true);
    first.release(); // the old closure fires late
    expect(activeBuild()?.label).toBe('ios build');
    expect(readBuildClaim('/proj/f')?.label).toBe('ios build');
  });
});

// A genuine FAILURE taking the cross-process claim (not a conflict) — `~/.modoki` uncreatable, or
// its lock genuinely wedged past its deadline — makes `acquireBuildClaim` THROW rather than return
// a refusal. `acquireBuild` above already took the in-process slot by the time that happens; the
// bug this guards is `active` staying set for the life of the backend process when nothing wraps
// that call, so every LATER build attempt would wrongly refuse "in this editor" until a restart —
// over a build that never actually started.
describe('acquireBuildSlot — a genuine failure taking the cross-process claim does not leak the in-process slot', () => {
  /** Fail ONLY the build-claims lock mkdir, the way an uncreatable `~/.modoki` (or any other
   *  non-EEXIST mkdir failure) does — same technique as `vendorPlugins.test.ts`'s `denyLockMkdir`,
   *  applied to `buildClaimsStore.mjs`'s own lock file instead of the plugin-build one. */
  function denyBuildClaimsLockMkdir() {
    const real = fs.mkdirSync;
    return vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: object) => {
      if (String(p).endsWith('.build-claims.lock')) {
        throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' });
      }
      return (real as (p: fs.PathLike, o?: object) => string | undefined)(p, o);
    }) as typeof fs.mkdirSync);
  }

  it('releases the in-process slot and reports a message, rather than propagating the throw or leaking the slot', () => {
    const spy = denyBuildClaimsLockMkdir();
    let r: ReturnType<typeof acquireBuildSlot>;
    try {
      r = acquireBuildSlot('ios build', '/proj/leak-a');
    } finally {
      spy.mockRestore();
    }
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toMatch(/Could not create the build-claims lock directory/);
    // The load-bearing assertion: the in-process slot must be free again, not held for the life of
    // this backend process — the mutation this catches is buildLock.ts's own `try` being removed.
    expect(activeBuild()).toBeNull();
    expect(acquireBuild('android build').ok).toBe(true);
  });
});

// #799 follow-up (BLOCKER 1): `withLock` throwing on a non-EEXIST errno was only ever wrapped on
// the ACQUIRE side (the describe block just above) — `releaseBuildClaimByToken` called it bare, so
// `release()` itself became a throwing function. Reproduced the same way as the acquire-side bug:
// take a claim normally, then deny the SAME lock-directory mkdir on the RELEASE path instead.
// Before the fix this made `r.release()` throw AND skipped `local.release()` (a bare
// `cross.release(); local.release();` in buildLock.ts's composed release), so `active` stayed set
// for the life of the backend process — every LATER build wrongly refused "in this editor" until a
// restart, over a build that had actually finished.
describe('acquireBuildSlot — release() never throws, and frees the in-process slot even when the cross-process release fails (#799 follow-up)', () => {
  function denyBuildClaimsLockMkdir() {
    const real = fs.mkdirSync;
    return vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: object) => {
      if (String(p).endsWith('.build-claims.lock')) {
        throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' });
      }
      return (real as (p: fs.PathLike, o?: object) => string | undefined)(p, o);
    }) as typeof fs.mkdirSync);
  }

  it('release() does not throw, and the in-process slot is freed even though the cross-process claim could not be updated', () => {
    const r = acquireBuildSlot('ios build', '/proj/release-fail-a');
    if (!r.ok) throw new Error('unreachable');
    expect(activeBuild()?.label).toBe('ios build');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = denyBuildClaimsLockMkdir();
    try {
      expect(() => r.release()).not.toThrow();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }

    // The load-bearing assertion, mirroring the acquire-path test above: the in-process slot is
    // free again — a `try { cross.release() } finally { local.release() }` composition in
    // buildLock.ts, not two bare statements, is what keeps this true independent of whether the
    // cross-process side itself throws.
    expect(activeBuild()).toBeNull();
    expect(acquireBuild('android build').ok).toBe(true);
  });
});
