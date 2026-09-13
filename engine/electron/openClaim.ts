/**
 * The build claim around Electron's heal-on-open (#1160): the DECISION half, kept out of main.ts so
 * it is unit-testable without Electron, a real claims file, or a real wait.
 *
 * Opening a project heals its native config and installs its deps (`healProjectOnOpen` +
 * `ensureProjectDeps`). Both write the same files a native build heals, and until #1160 the open
 * took no claim, so opening a project while a CLI build healed it raced the build. The editor's own
 * `/api/build` claim does not cover it either: that claim is held by the Vite child, while the heal
 * runs in Electron main, a different pid.
 *
 * So the open takes the claim, and when something else holds it the answer is the one the owner
 * chose on #1160, the hybrid:
 *  - **a completed install is present**: SKIP the heal and the install, and say so. The editor opens
 *    immediately, on the deps as they are. ⚠️ Nothing promises the holder repairs them: a native
 *    build does (`healNativeProject`), but a web build, `generate-icons` or a smoke script does not.
 *    A stale plugin extraction the open would have re-installed then waits for the next open. That
 *    is the price of opening instantly, and the log says "left as they are", not "healed".
 *  - **an install is genuinely needed**: WAIT for the claim, telling the user who holds it, then
 *    heal under it. `ensureProjectDeps` re-checks after acquiring and does nothing if the holder
 *    finished its install. If the holder died mid-install instead, the plan's `waited` lets the
 *    caller force the install that `ensureProjectDeps`' bare existence check would skip.
 *  - **the claim could not be read at all** (an unreadable claims file, or the store threw): SKIP,
 *    warn with the store's own message, and put it on the status line too. There is no holder to
 *    wait for, and the message names the file to fix.
 *
 * ⚠️ **"Present" means a COMPLETED install, and once the open starts waiting it waits for the CLAIM,
 * never for the files.** The first version re-asked "are deps missing?" every poll and treated a
 * `node_modules` directory as present. The #1160 review showed that ends a wait while the holder's
 * install is still running, so the editor starts Vite on a half-extracted tree. Measured on a fresh
 * `npm install` of three + typescript: `node_modules` appears at +1.1s, the last package at +4.9s,
 * and npm's hidden lockfile `node_modules/.package-lock.json` at +5.0s, last of all. So the question
 * is asked with `completedInstall` (the hidden lockfile) and asked once, before the wait. A
 * `build:plugins` run AFTER the holder's install is still invisible to it. That residue is
 * accepted and stated in `docs/build.md`.
 *
 * There is no timeout on the wait on purpose. A dead holder's claim goes stale by pid, and a live
 * one past `BUILD_CLAIM_TTL_MS` by age; either way the next poll's acquire succeeds. What does stop
 * it is `superseded`: the user opening another project mid-wait. The caller answers that with an
 * open GENERATION, not a root comparison, because A → B → A would otherwise read as "still current"
 * for the first A.
 */

import { createSupersessionToken } from '../packages/modoki/src/runtime/core/liveness';

/** The subset of `acquireBuildClaim`'s result this needs. `held` is absent for UNKNOWN. */
export type OpenClaimAcquire =
  | { ok: true; release: () => void }
  | { ok: false; message: string; held?: { label: string; pid: number; kind?: string } };

export interface OpenClaimPorts {
  /** `acquireBuildClaim(projectRoot, label, { kind: 'editor' })`. May throw. */
  acquire: () => OpenClaimAcquire;
  /** Read-only: does opening need an install, counting an unfinished one as missing
   *  (`projectDepsMissing(root, fs, { completedInstall: true })`)? Asked ONCE, before any wait. */
  depsMissing: () => boolean;
  /** True once this open no longer matters (another project was opened meanwhile). Checked every poll. */
  superseded: () => boolean;
  /** Resolves after `ms`. Injected so a test never waits. */
  sleep: (ms: number) => Promise<void>;
  /** A user-visible progress line (the splash on launch, the title bar on Open Project). */
  status: (line: string) => void;
  log: (line: string) => void;
  warn: (line: string) => void;
}

export type OpenClaimPlan =
  /** Heal and install, then call `release`. `waited` is true when a holder had to finish first, so a
   *  tree it left incomplete (it died mid-install) is the caller's to re-install. */
  | { heal: true; release: () => void; waited: boolean }
  /** Leave the project alone. `why` has already been logged. */
  | { heal: false; why: 'held' | 'unknown' | 'superseded' };

export const OPEN_CLAIM_POLL_MS = 2000;

export async function claimProjectForOpen(
  projectName: string,
  ports: OpenClaimPorts,
  pollMs: number = OPEN_CLAIM_POLL_MS,
): Promise<OpenClaimPlan> {
  let waiting = false;
  for (;;) {
    // BEFORE the acquire, every iteration: a superseded open that acquired first would heal and
    // install a project the user has left, holding its claim against a CLI build (#1160 review).
    if (ports.superseded()) {
      ports.log(`heal: stopped for ${projectName}, since another project was opened`);
      return { heal: false, why: 'superseded' };
    }
    let r: OpenClaimAcquire;
    try {
      r = ports.acquire();
    } catch (e) {
      r = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (r.ok) {
      if (waiting) ports.log(`heal: ${projectName}'s build claim is free, healing now`);
      return { heal: true, release: r.release, waited: waiting };
    }
    if (!r.held) {
      ports.warn(`heal: SKIPPED for ${projectName}, since its build claim could not be taken (native config and deps left as they are): ${r.message}`);
      ports.status(`${projectName}: open-time repair skipped, since the build claim could not be read (see the log)`);
      return { heal: false, why: 'unknown' };
    }
    const who = `${r.held.kind === 'cli' ? 'a command-line build' : 'another editor'} ("${r.held.label}", pid ${r.held.pid})`;
    if (!waiting) {
      if (!ports.depsMissing()) {
        ports.log(`heal: skipped for ${projectName}, since ${who} holds its build claim. A completed install is present, so the editor opens now with native config and deps left as they are.`);
        ports.status(`${projectName}: ${who} holds it, so the open-time repair was skipped`);
        return { heal: false, why: 'held' };
      }
      ports.log(`heal: waiting for ${projectName}, which needs its deps installed but ${who} holds its build claim`);
      waiting = true;
    }
    ports.status(`Waiting for ${who} to finish before installing ${projectName}'s dependencies…`);
    await ports.sleep(pollMs);
  }
}

/** One project open's handle on the sequence (`createOpenSequencer`). */
export interface OpenTicket {
  /** False once a later open has been requested. Checked by the claim wait before every acquire, and
   *  by the open itself before each step that touches shared state (`state.root`, the dev server). */
  isCurrent: () => boolean;
}

/**
 * Serializes project opens (#1160). The editor has ONE dev server and ONE `state.root`, and an open
 * restarts both, so two opens running at once corrupt each other. One open's `startDevServer`
 * begins by stopping the other's child mid-start, which surfaced as a spurious "Open Project failed"
 * or, on the launch path, as the app quitting.
 *
 * The heal-on-open's claim wait made that window minutes long, and #1160's first two fixes guarded
 * one moment inside it (a generation check before Vite). Review showed the race lives in every await
 * of the open: provisioning, the install, Vite's own start. So the fix is structural. Every open runs
 * AFTER the previous one has fully settled, and requesting a newer open supersedes every older one
 * immediately. That turns an older open's claim wait into an early return (`OpenTicket.isCurrent`)
 * instead of leaving the newer open queued behind a CLI build.
 *
 * A superseded open that has not started yet still runs its turn. It must check `isCurrent()` first
 * and return without touching anything, which is what keeps A → B → C from ever rooting at B.
 */
export function createOpenSequencer() {
  // The supersession half is the shared liveness token (#573, docs/async-lifetime.md), not a
  // hand-rolled counter: each open's `begin()` stales every earlier open's check at once.
  const supersession = createSupersessionToken();
  let tail: Promise<unknown> = Promise.resolve();
  /** Take a place in the sequence NOW and supply the body later. The launch needs this: the menu is
   *  live long before the launch reaches its heal, so an Open Project in between must queue behind
   *  the launch rather than be superseded by it. ⚠️ A reservation whose `run` is never called blocks
   *  every later open forever. */
  function reserve<T>(): { ticket: OpenTicket; run: (body: (ticket: OpenTicket) => Promise<T>) => Promise<T> } {
    const ticket: OpenTicket = { isCurrent: supersession.begin() };
    let supply!: (body: (ticket: OpenTicket) => Promise<T>) => void;
    const bodyReady = new Promise<(ticket: OpenTicket) => Promise<T>>((resolve) => { supply = resolve; });
    const result = tail.then(() => bodyReady, () => bodyReady).then((body) => body(ticket));
    tail = result.then(() => undefined, () => undefined);
    return { ticket, run: (body) => { supply(body); return result; } };
  }
  return {
    reserve,
    /** Queue an open. `body` runs once every earlier open has settled, resolved or rejected, and its
     *  result or rejection is this call's. */
    open<T>(body: (ticket: OpenTicket) => Promise<T>): Promise<T> {
      return reserve<T>().run(body);
    },
    /** Resolves once every open requested so far, and any requested while waiting, has settled. */
    async idle(): Promise<void> {
      for (let seen: Promise<unknown> | null = null; seen !== tail;) { seen = tail; await seen; }
    },
  };
}
