/** devServer.findFreePort — port selection + the pinned-port fail-loud contract
 *  (E6). Binds a real loopback listener to occupy a port.
 *  Plus waitForServer's #67 guard against adopting somebody else's dev server. */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import {
  findFreePort, waitForServer, needsWinTreeKill,
  parseDevServerIdentity, classifyPortHolder, samePath, exitDisposition,
  probeDevServerPort, isProcessAlive, startDevServer, stopChild, type DevServerIdentity,
} from '../../electron/devServer';

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

/**
 * #190 — the editor served the WRONG project after every switch but the first.
 *
 * Measured on the win clone with the installed v0.4.0 editor. `main.log`, opening video-demo:
 *   07:22:00.606  dev server up at http://127.0.0.1:5173 (project ...\demos\video-demo)
 *   07:22:02.699  dev server exited unexpectedly (code 1)
 * "up" landed 17ms after the spawn — a Vite boot is ~2s — because `waitForServer` was answered
 * by the server ALREADY on the port, while ours died on `--strictPort` two seconds later. The
 * renderer then loaded games/court's `game.ts` and assets under video-demo's name.
 *
 * The chain, and what each group below pins:
 *   - `stopDevServer` resolved when `taskkill` returned, not when the child exited;
 *   - so the predecessor's `exit` arrived AFTER the replacement was spawned, and the
 *     module-global `intentionalStop` had already been reset to false → it logged a false
 *     "exited unexpectedly" and nulled `child`, orphaning the live Vite (`exitDisposition`);
 *   - the next switch had nothing to stop, and the #67 guard could not see it because that
 *     guard is TIMING-based — it only catches a child that has already died (`waitForServer`
 *     with `expect.pid`, and `classifyPortHolder` for the pre-spawn check).
 */
describe('#190 — proving the server on the port is OURS', () => {
  const OUR_EDITOR_PID = 16268;
  const ours: DevServerIdentity = {
    pid: 4242,
    ppid: OUR_EDITOR_PID,
    projectRoot: 'E:\\Projects\\modoki\\demos\\video-demo',
    repoRoot: 'C:\\Program Files\\Modoki Editor\\resources\\app.asar.unpacked',
  };
  const body = (o: Partial<DevServerIdentity> & { modoki?: unknown }) => JSON.stringify({ modoki: true, ...o });

  describe('parseDevServerIdentity — only OUR payload counts as an answer', () => {
    it('accepts the real payload', () => {
      expect(parseDevServerIdentity(body(ours))).toEqual(ours);
    });

    // The exact body that made this bug invisible: Vite answers an unknown path with its SPA
    // fallback, 200 + index.html. A parser that shrugged at that would read "no one is there".
    it('rejects the SPA HTML fallback', () => {
      expect(parseDevServerIdentity('<!doctype html>\n<html lang="en">')).toBeNull();
    });

    it('rejects the JSON 404 an older build\'s /api catch-all emits', () => {
      expect(parseDevServerIdentity(JSON.stringify({
        error: 'no such API route: GET /api/dev-server-identity',
        hint: 'Check the path and method.',
      }))).toBeNull();
    });

    it('rejects a body that omits the modoki marker, however complete it otherwise looks', () => {
      expect(parseDevServerIdentity(JSON.stringify({ ...ours }))).toBeNull();
    });

    it('rejects partial or wrongly-typed fields — a half-answer must not authorise a kill', () => {
      expect(parseDevServerIdentity(body({ pid: 1, projectRoot: 'p' }))).toBeNull();       // no repoRoot
      expect(parseDevServerIdentity(body({ ...ours, pid: 0 }))).toBeNull();                 // pid 0
      expect(parseDevServerIdentity(body({ ...ours, pid: 1.5 }))).toBeNull();               // not a pid
      expect(parseDevServerIdentity(body({ ...ours, pid: '4242' as unknown as number }))).toBeNull();
      expect(parseDevServerIdentity(body({ ...ours, repoRoot: '' }))).toBeNull();
      // No ppid ⇒ no ownership check is possible, so the kill cannot be authorised either.
      expect(parseDevServerIdentity(body({ ...ours, ppid: undefined }))).toBeNull();
    });
  });

  describe('classifyPortHolder — reclaim is a KILL, so gate it on install AND ownership', () => {
    const self = { repoRoot: ours.repoRoot, pid: OUR_EDITOR_PID };
    const dead = () => false;
    const alive = () => true;
    const win = (isAlive: (p: number) => boolean) => ({ platform: 'win32' as const, isAlive });

    it('nothing on the port ⇒ free', () => {
      expect(classifyPortHolder({ state: 'empty' }, self)).toEqual({ action: 'free' });
    });

    // The #190 stray: spawned by THIS process and then lost track of. Nothing else will ever
    // clean it up, so "is its editor alive" must not be allowed to protect it — its editor is us.
    it('a stray WE spawned ⇒ reclaim, even though its editor (us) is alive', () => {
      expect(classifyPortHolder({ state: 'modoki', identity: ours }, self, win(alive)))
        .toEqual({ action: 'reclaim', pid: 4242, projectRoot: ours.projectRoot });
    });

    it('a leaked server whose editor is GONE ⇒ reclaim', () => {
      const orphan = { ...ours, ppid: 99999 };
      expect(classifyPortHolder({ state: 'modoki', identity: orphan }, self, win(dead)).action).toBe('reclaim');
    });

    // Same install is NOT enough. A second editor window is legitimately using its own dev
    // server, and stealing its port is the same class of harm as killing a sibling clone's.
    it('ANOTHER LIVE editor of this same install ⇒ refuse', () => {
      const otherWindow = { ...ours, ppid: 12345 };
      const v = classifyPortHolder({ state: 'modoki', identity: otherWindow }, self, win(alive));
      expect(v.action).toBe('refuse');
      expect(v.action === 'refuse' && v.why).toContain('another editor of this install is running');
      expect(v.action === 'refuse' && v.why).toContain('12345');
    });

    // The rule that keeps a reclaim safe. Four clones share this machine; taking a port from
    // one of them is the same failure `reapScoping.test.ts` bans for pkill patterns, and being
    // handed a pid does not make it ours to kill. Checked BEFORE ownership: a dead sibling
    // clone's server is still not ours.
    it('ANOTHER install/clone\'s dev server ⇒ refuse, never kill — even if its editor is dead', () => {
      const sibling = { ...ours, repoRoot: 'E:\\Projects\\modoki-ai2', pid: 999 };
      const v = classifyPortHolder({ state: 'modoki', identity: sibling }, self, win(dead));
      expect(v.action).toBe('refuse');
      expect(v.action === 'refuse' && v.why).toContain('different install/clone');
      expect(v.action === 'refuse' && v.why).toContain('999');
    });

    // 'foreign' and 'empty' must NOT collapse: one means spawn, the other means stop. A
    // nullable identity would have merged them and spawned straight into an occupied port.
    it('an unidentified server ⇒ refuse — that is NOT the same as an empty port', () => {
      const v = classifyPortHolder({ state: 'foreign' }, self);
      expect(v.action).toBe('refuse');
      expect(classifyPortHolder({ state: 'empty' }, self).action).toBe('free');
    });

    // Both sides of the comparison come from different worlds — `path` on one, JSON from
    // another process on the other. On Windows a raw === would refuse our OWN install and
    // turn every reclaim into a hard failure to open a project.
    it('matches our install across separator and case differences (Windows)', () => {
      const mixed = { ...ours, repoRoot: 'c:/program files/modoki editor/resources/app.asar.unpacked/' };
      expect(classifyPortHolder({ state: 'modoki', identity: mixed }, self, win(alive)).action).toBe('reclaim');
      // …and posix must stay case-SENSITIVE: there, those are genuinely different directories.
      expect(classifyPortHolder({ state: 'modoki', identity: mixed }, self, { platform: 'linux', isAlive: alive }).action)
        .toBe('refuse');
    });

    // EPERM from `kill(pid, 0)` means the process EXISTS but is not ours to signal. Reading
    // that as "dead" is exactly how an ownership check ends up authorising a kill it shouldn't.
    it('isProcessAlive treats an unsignallable process as alive, and a bad pid as dead', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(1.5)).toBe(false);
    });

    it('samePath normalises separators and trailing slashes', () => {
      expect(samePath('/a/b', '/a/b/', 'linux')).toBe(true);
      expect(samePath('C:\\a\\b', 'C:/a/b', 'win32')).toBe(true);
      expect(samePath('/a/b', '/a/bc', 'linux')).toBe(false);
    });
  });

  describe('exitDisposition — a dying predecessor must not clobber its replacement', () => {
    // THE bug. On Windows the old child's exit lands after the new spawn; under the old global
    // flag it read as "unexpected" and set child = null, so the NEXT stopDevServer() had
    // nothing to stop and the stale server kept the port.
    it('an intentionally-stopped child that exits after its replacement does NOTHING', () => {
      expect(exitDisposition({ intentional: true, isCurrent: false }))
        .toEqual({ logUnexpected: false, clearState: false });
    });

    it('the current child dying on its own clears the state and says so', () => {
      expect(exitDisposition({ intentional: false, isCurrent: true }))
        .toEqual({ logUnexpected: true, clearState: true });
    });

    it('a superseded child dying on its own is reported but touches no state', () => {
      expect(exitDisposition({ intentional: false, isCurrent: false }))
        .toEqual({ logUnexpected: true, clearState: false });
    });

    it('an intentional stop of the current child is silent — we asked for it', () => {
      expect(exitDisposition({ intentional: true, isCurrent: true }))
        .toEqual({ logUnexpected: false, clearState: false });
    });
  });

  describe('stopChild — a kill being ISSUED is not the process being GONE', () => {
    /** The half of #190 that the Windows fix left behind, and the one that reaches macOS.
     *
     *  `stopDevServer` learned to await the real `exit` on its normal path, but its
     *  force-kill branch still resolved in the same tick as the kill. posix reaches that
     *  branch whenever Vite ignores SIGTERM for the grace period; the SIGKILL that follows is
     *  uncatchable but the kernel still needs a moment to reap the process and release its
     *  listening socket. Resolving there hands the caller a port that is still held, and the
     *  pre-spawn probe then reads our own dying child as a `foreign` holder and REFUSES to
     *  start — "a server that is not a Modoki dev server is already on this port", about our
     *  own Vite, where waiting ~1ms would have succeeded. */
    const fakeChild = () => {
      let onExit: (() => void) | null = null;
      return {
        c: { once: (ev: string, fn: () => void) => { if (ev === 'exit') onExit = fn; } },
        exit: () => onExit?.(),
      };
    };

    it('resolves on exit during the grace period, and never force-kills', async () => {
      const { c, exit } = fakeChild();
      let forced = 0;
      const p = stopChild(c, { initial: () => {}, force: () => { forced++; } }, { graceMs: 50, reapMs: 50 });
      exit();
      expect(await p).toBe('exited');
      expect(forced).toBe(0);
    });

    it('KEEPS WAITING after the force kill — an exit that lands later still counts', async () => {
      // The regression guard. Against the old code this resolved the instant `force` ran, so
      // the assertion below that it has NOT settled yet is what discriminates.
      const { c, exit } = fakeChild();
      let forcedAt = 0;
      const p = stopChild(
        c,
        { initial: () => {}, force: () => { forcedAt = Date.now(); } },
        { graceMs: 20, reapMs: 500 },
      );
      let settled: string | null = null;
      void p.then((r) => { settled = r; });

      await new Promise((r) => setTimeout(r, 60));
      expect(forcedAt).toBeGreaterThan(0);       // the force kill HAS run
      expect(settled).toBeNull();                // ...and we are still waiting for the reap

      exit();
      expect(await p).toBe('exited');
    });

    it('gives up after reapMs rather than hanging, and says which way it ended', async () => {
      const { c } = fakeChild();                 // never exits
      const p = stopChild(c, { initial: () => {}, force: () => {} }, { graceMs: 10, reapMs: 20 });
      expect(await p).toBe('abandoned');
    });

    it('a force kill that throws does not strand the caller', async () => {
      const { c, exit } = fakeChild();
      const p = stopChild(
        c,
        { initial: () => {}, force: () => { throw new Error('already gone'); } },
        { graceMs: 10, reapMs: 200 },
      );
      exit();
      expect(await p).toBe('exited');
    });
  });

  describe('waitForServer with expect.pid — identity beats timing', () => {
    let server: http.Server | null = null;
    afterEach(() => { server?.close(); server = null; });

    /** A dev server that answers the identity route as `pid`. */
    const serve = async (pid: number | null): Promise<string> => {
      const srv = http.createServer((q, s) => {
        if (q.url === '/api/dev-server-identity' && pid !== null) {
          s.setHeader('Content-Type', 'application/json');
          s.end(body({ ...ours, pid }));
          return;
        }
        s.end('<!doctype html><html></html>'); // Vite's SPA fallback, the real 404 shape
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      server = srv;
      return `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/`;
    };

    it('accepts the server when the pid on the port is the one we spawned', async () => {
      const url = await serve(4242);
      await expect(waitForServer(url, 5000, () => false, { pid: 4242 })).resolves.toBeUndefined();
    });

    // The regression that matters: our child is ALIVE (abort false — it takes ~2s to die on
    // its bind) and a stale server is answering instantly. The old code returned success here
    // and the editor went on to serve that other project.
    it('REFUSES a stale server answering on our port while our child is still alive', async () => {
      const url = await serve(1111); // somebody else's dev server, still up
      await expect(waitForServer(url, 1200, () => false, { pid: 4242 }))
        .rejects.toThrow(/still held by a DIFFERENT Modoki dev server .*pid 1111/s);
    });

    it('names the project the stale server is rooted at — that is the whole diagnosis', async () => {
      const url = await serve(1111);
      await expect(waitForServer(url, 1200, () => false, { pid: 4242 }))
        .rejects.toThrow(/video-demo/);
    });

    // Without expect.pid the behaviour must be exactly as before, or every existing caller
    // and the #67 guard above change meaning.
    it('is unchanged when no pid is expected', async () => {
      const url = await serve(null);
      await expect(waitForServer(url, 5000, () => false)).resolves.toBeUndefined();
    });

    // The message must not contradict the check that produced it: we only reach the timeout
    // via a POSITIVE `reachable` probe, so "not reachable" is the one thing that cannot be
    // true — and it points the reader at a network problem instead of at the squatter.
    it('does not report "not reachable" about a port that is answering', async () => {
      const url = await serve(null); // answers, but never identifies (no identity route)
      await expect(waitForServer(url, 900, () => false, { pid: 4242 }))
        .rejects.toThrow(/answering .* but not as our dev server/s);
    });
  });

  // The wiring, not just the decision: startDevServer must CONSULT the probe and refuse before
  // it spawns anything. Without this, classifyPortHolder could be perfect and never called —
  // which is precisely the shape of the original bug (a guard that existed and lost its race).
  describe('startDevServer — refuses an occupied port instead of adopting what is on it', () => {
    let server: http.Server | null = null;
    afterEach(() => { server?.close(); server = null; });

    const listen = async (handler: http.RequestListener): Promise<string> => {
      const srv = http.createServer(handler);
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      server = srv;
      return `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/`;
    };

    // repoRoot/projectRoot are never touched on this path — it throws before spawn — so the
    // paths only need to be distinguishable, not real.
    const start = (url: string) => startDevServer({ repoRoot: ours.repoRoot, projectRoot: 'X', url });

    it('a NON-Modoki server on the port ⇒ loud failure, not a silent adoption', async () => {
      const url = await listen((_q, s) => s.end('not yours'));
      await expect(start(url)).rejects.toThrow(/not a Modoki dev server/);
    });

    it('another LIVE editor of this install ⇒ loud failure naming it', async () => {
      // ppid = our parent: a real, live pid that is not this process, so the ownership check
      // must protect it. (Reclaiming here would kill a colleague's working editor.)
      const url = await listen((_q, s) => {
        s.setHeader('Content-Type', 'application/json');
        s.end(body({ ...ours, ppid: process.ppid }));
      });
      await expect(start(url)).rejects.toThrow(/another editor of this install is running/);
    });
  });

  describe('probeDevServerPort — the live tri-state', () => {
    let server: http.Server | null = null;
    afterEach(() => { server?.close(); server = null; });

    const listen = async (handler: http.RequestListener): Promise<string> => {
      const srv = http.createServer(handler);
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      server = srv;
      return `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/`;
    };

    it('reports a Modoki dev server', async () => {
      const url = await listen((_q, s) => { s.setHeader('Content-Type', 'application/json'); s.end(body(ours)); });
      expect(await probeDevServerPort(url)).toEqual({ state: 'modoki', identity: ours });
    });

    it('reports a server that will not identify itself as foreign, not as empty', async () => {
      const url = await listen((_q, s) => s.end('<!doctype html><html></html>'));
      expect(await probeDevServerPort(url)).toEqual({ state: 'foreign' });
    });

    it('reports a dead port as empty', async () => {
      // Bind then close, so the port is real but nothing is on it (ECONNREFUSED).
      const url = await listen((_q, s) => s.end('x'));
      server?.close(); server = null;
      expect(await probeDevServerPort(url, 800)).toEqual({ state: 'empty' });
    });

    // 'empty' AUTHORISES A SPAWN and 'foreign' refuses one, so a hung server misfiled as empty
    // sends the caller straight into an occupied port: --strictPort kills the new Vite, and the
    // editor then reports "not reachable" about a port that is plainly answering. That wrong
    // diagnosis is the exact failure mode of #190, reintroduced one layer down.
    it('a server that ACCEPTS the connection and never answers is foreign, not empty', async () => {
      const url = await listen(() => { /* accept, then hang forever */ });
      expect(await probeDevServerPort(url, 300)).toEqual({ state: 'foreign' });
    });

    // ⚠️ NOT a regression guard for the 64KB cap, and mutation-testing says so: deleting the cap
    // leaves this green, because a 320KB body fails JSON.parse either way. The cap bounds MEMORY,
    // which has no observable verdict to assert on. Kept as a smoke test that a streaming
    // stranger is classified and does not hang the probe — don't read it as covering the cap.
    it('a streaming stranger is still just foreign (and does not hang the probe)', async () => {
      const url = await listen((_q, s) => {
        s.writeHead(200, { 'Content-Type': 'application/json' });
        for (let i = 0; i < 40; i++) s.write('x'.repeat(8 * 1024)); // 320KB > the 64KB cap
        s.end();
      });
      expect(await probeDevServerPort(url, 3000)).toEqual({ state: 'foreign' });
    });
  });
});
