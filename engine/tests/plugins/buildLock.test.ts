import { describe, it, expect, afterEach } from 'vitest';
import { acquireBuild, activeBuild, describeBuildConflict, releasePolicy, resetBuildLockForTests } from '../../plugins/backend/buildLock';

afterEach(() => resetBuildLockForTests());

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
