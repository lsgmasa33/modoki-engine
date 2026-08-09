/** devServer.findFreePort — port selection + the pinned-port fail-loud contract
 *  (E6). Binds a real loopback listener to occupy a port.
 *  Plus waitForServer's #67 guard against adopting somebody else's dev server. */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { findFreePort, waitForServer, needsWinTreeKill } from '../../electron/devServer';

let occupied: net.Server | null = null;

function occupy(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, host, () => {
      occupied = srv;
      resolve((srv.address() as net.AddressInfo).port);
    });
  });
}

afterEach(() => {
  occupied?.close();
  occupied = null;
});

/** Is `port` bindable on `host`? Mirrors devServer's own probeHost EXACTLY, including
 *  "any error that is not EADDRINUSE counts as free" — an IPv6-less runner fails the `::1`
 *  bind with EADDRNOTAVAIL, which must not read as occupied. */
function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code !== 'EADDRINUSE'));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** findFreePort probes these three and needs all of them free. */
const PROBE_HOSTS = ['0.0.0.0', '127.0.0.1', '::1'];

/** A port genuinely free on every host findFreePort probes, drawn from ABOVE the kernel's
 *  ephemeral range — see the comment on the test below. Returns -1 if the band is somehow
 *  saturated, which the caller reports rather than silently skipping. */
async function findGenuinelyFreePort(start = 61000, tries = 40): Promise<number> {
  for (let p = start; p < start + tries; p++) {
    // SEQUENTIALLY — see findFreePort's own comment. Probing 0.0.0.0 and 127.0.0.1 for the
    // same port CONCURRENTLY makes them collide with each other on Linux, which is exactly
    // how this helper reported a fresh 61000-61039 band as fully saturated on CI.
    let free = true;
    for (const h of PROBE_HOSTS) if (!(await bindable(p, h))) { free = false; break; }
    if (free) return p;
  }
  return -1;
}

describe('findFreePort', () => {
  // DO NOT reach for an OS-assigned ephemeral port here (`listen(0)`), which is what this test
  // did until CI run 30699634800 went red on Linux with `expected 34961 to be 46487`.
  //
  // findFreePort probes THREE hosts (0.0.0.0, 127.0.0.1, ::1) and returns `preferred` only if
  // all three are free. `listen(0)` draws from the kernel's ephemeral range (Linux default
  // 32768-60999) — and that is the same pool the kernel assigns as the SOURCE port of every
  // outbound connection. On a CI runner doing network I/O, a just-released ephemeral port can
  // therefore be re-taken on 0.0.0.0 immediately, and every observed failure value (46487,
  // 44409, 34961, 46379) sat inside that range. Retrying with another ephemeral port does NOT
  // help — the replacement is drawn from the same contended pool, which is why an earlier
  // 5-attempt retry loop still failed 5/5 there.
  //
  // So pick from ABOVE the ephemeral range, where the kernel never auto-assigns, and verify
  // the candidate independently (same probe semantics as the function) so a busy port is
  // distinguishable from a broken function instead of being blamed on it.
  it('returns the preferred port when it is free', async () => {
    const p = await findGenuinelyFreePort();
    expect(p, 'no free port in 61000-61039 — the band is saturated, not a findFreePort bug')
      .toBeGreaterThan(0);
    expect(await findFreePort(p)).toBe(p);
  });

  it('falls back to an ephemeral port when preferred is taken (default)', async () => {
    const taken = await occupy();
    const got = await findFreePort(taken);
    expect(got).not.toBe(taken);
    expect(got).toBeGreaterThan(0);
  });

  it('REJECTS instead of drifting when allowFallback=false and the port is taken (E6)', async () => {
    const taken = await occupy();
    await expect(findFreePort(taken, false)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('returns an ephemeral port for preferred<=0', async () => {
    const got = await findFreePort(0);
    expect(got).toBeGreaterThan(0);
  });

  // #67. A sibling clone runs `vite --host 0.0.0.0`, i.e. binds the WILDCARD. Node
  // sets SO_REUSEADDR on every net.Server, and that lets a 127.0.0.1 bind succeed
  // right alongside a 0.0.0.0 one — so the old single-address probe reported the
  // port free and the editor went on to use a port another clone already served.
  // The renderer then loaded the SIBLING's project and failed with an allowed-roots
  // error naming a path that plainly exists.
  it('detects a port held on the WILDCARD address, not just on loopback (#67)', async () => {
    const taken = await occupy('0.0.0.0');
    const got = await findFreePort(taken);
    expect(got, 'a wildcard-bound server must not read as a free port').not.toBe(taken);
  });

  it('still rejects a wildcard-held port when the port is a pinned contract (#67 + E6)', async () => {
    const taken = await occupy('0.0.0.0');
    await expect(findFreePort(taken, false)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  // The guard against over-correcting: probing ONLY the wildcard would have fixed
  // #67 while going blind to a plain 127.0.0.1 bind — which is how our own
  // startDevServer binds Vite, i.e. the much more common clash. Both must be seen.
  it('detects a port held on LOOPBACK too — the fix must not trade one blind spot for another', async () => {
    const taken = await occupy('127.0.0.1');
    const got = await findFreePort(taken);
    expect(got).not.toBe(taken);
  });
});

// The second half of #67, and the one that caused the visible damage: a reachable
// port is NOT proof the server on it is ours. In the field this was a sibling
// clone's Vite; here a decoy stands in for it.
describe('waitForServer — the foreign-server adoption guard (#67)', () => {
  let decoy: http.Server | null = null;
  const decoyUrl = async (): Promise<string> => {
    const srv = http.createServer((_q, s) => { s.end('not yours'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    decoy = srv;
    return `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/`;
  };

  afterEach(() => { decoy?.close(); decoy = null; });

  it('REFUSES a reachable server when our own child has died (would have loaded a foreign project)', async () => {
    const url = await decoyUrl();
    // The guard fires on a SPECIFIC interleaving, and the test has to reproduce it:
    // alive when we enter the loop, dead by the time the probe comes back. That is
    // the real --strictPort race — our Vite exits while the foreign server answers.
    // (A constantly-true abort would throw on the pre-loop check instead and never
    // exercise this branch at all.)
    let checks = 0;
    const abort = () => ++checks > 1;
    await expect(waitForServer(url, 5000, abort)).rejects.toThrow(/NOT our dev server/);
    expect(checks, 'the post-probe check is what must reject').toBe(2);
  });

  it('accepts a reachable server while our child is alive', async () => {
    const url = await decoyUrl();
    await expect(waitForServer(url, 5000, () => false)).resolves.toBeUndefined();
  });

  it('still fails fast when the child dies before anything answers', async () => {
    // Nothing listening here at all — the pre-existing E7 fail-fast path.
    await expect(waitForServer('http://127.0.0.1:1/', 5000, () => true))
      .rejects.toThrow(/exited before becoming reachable/);
  });
});

/**
 * #185 — stopping Vite must take its BUILD TREE with it on Windows.
 *
 * `child.kill()` there is a TerminateProcess on the Vite pid ALONE: Vite runs no handler, so
 * `buildStepShell`'s own shutdown hook never fires and an in-flight build's grandchildren are
 * orphaned. Measured on the win clone — a `gradlew --no-daemon` JVM outlived a hard-killed parent
 * by 60s+, while `taskkill /T` cleared the same tree in 1s.
 *
 * posix is deliberately NOT switched: a real SIGTERM there runs Vite's handlers, which reap the
 * build children properly, and this process's group is Electron's own — signalling it would reach
 * the wrong processes.
 */
describe('needsWinTreeKill — when stopping Vite needs a tree kill (#185)', () => {
  const live = { pid: 4321, exitCode: null, signalCode: null };

  it('is required on win32 for a live child', () => {
    expect(needsWinTreeKill(live, 'win32')).toBe(true);
  });

  it('is NOT used on posix — a real signal there runs Vite handlers, which reap the children', () => {
    expect(needsWinTreeKill(live, 'darwin')).toBe(false);
    expect(needsWinTreeKill(live, 'linux')).toBe(false);
  });

  it('refuses a REAPED child — the pid may already belong to something else, and /T takes its tree', () => {
    expect(needsWinTreeKill({ pid: 4321, exitCode: 0, signalCode: null }, 'win32')).toBe(false);
    expect(needsWinTreeKill({ pid: 4321, exitCode: null, signalCode: 'SIGTERM' }, 'win32')).toBe(false);
  });

  it('refuses a null child or one that never got a pid (spawn failed before exec)', () => {
    expect(needsWinTreeKill(null, 'win32')).toBe(false);
    expect(needsWinTreeKill(undefined, 'win32')).toBe(false);
    expect(needsWinTreeKill({ pid: undefined, exitCode: null, signalCode: null }, 'win32')).toBe(false);
  });
});
