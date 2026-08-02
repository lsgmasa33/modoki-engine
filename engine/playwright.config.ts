import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { clonePort } from './tests/e2e/clonePort';

// Repo root (parent of engine/). Playwright runs webServer.command with cwd = this
// config file's dir (engine/), which has no package.json — so `npm run dev` must be
// launched from here instead.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** E2E smoke suite for the visual editor — real-browser WebGL click-to-select and
 *  DOM selection wiring. Runs against the Vite dev server (the editor needs the
 *  live /api/* endpoints). Headless WebGL2 via ANGLE/SwiftShader; WebGPU is forced
 *  off per-test by deleting navigator.gpu so the renderer takes its WebGL2 path. */

// Dedicated high port (NOT the editor's 5173) so the e2e suite always spins up its
// OWN isolated dev server and can never hijack a live editor session — these specs
// mutate scenes + POST /api/write-file, so running them against your real editor
// would write changes to disk.
//
// PER-CLONE by default (#20). One hardcoded port shared by every clone meant two
// clones could not run e2e at the same time: with `reuseExistingServer: false` below
// the second run at least fails LOUDLY rather than testing the first clone's tree,
// but "wait your turn" is a poor gate for a 4-clone setup, and this is the one gate
// with no remote counterpart.
//
// The offset is derived from the REPO PATH, not from MODOKI_BACKEND_PORT as #20
// proposed: that variable is set by launch-editor.sh for the EDITOR process only, so
// it is unset in the plain shell that runs `npm run test:e2e` and every clone would
// have collapsed back onto the same default. The repo path is the clone's identity,
// is always available here, and needs no setup — which is the point.
//
// MODOKI_E2E_PORT still wins, for CI or a deliberate pin.
// Derivation + its rationale live in ./tests/e2e/clonePort.ts so they are unit-testable
// without importing this config.
const PORT = process.env.MODOKI_E2E_PORT ?? String(clonePort(REPO_ROOT));

const BASE_URL = `http://localhost:${PORT}`;

// Announce it: the port is derived, so it is no longer a number you can memorise, and
// the documented recovery for a stale orphan ("kill whatever holds the port") needs to
// know which one. The config is loaded more than once per run (the runner, then the
// webServer child, which inherits env) — guard so it prints ONCE and doesn't read like
// a stutter.
if (!process.env.__MODOKI_E2E_PORT_LOGGED) {
  process.env.__MODOKI_E2E_PORT_LOGGED = '1';
  console.log(`[e2e] dev server port ${PORT} (this clone: ${REPO_ROOT})`);
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // SERIAL ON PURPOSE — do not raise this back to 4 for speed.
  //
  // `webServer` below spins up ONE dev server, so every worker drives the SAME editor
  // instance: one scene, one selection, one undo stack, one asset manifest. Specs that
  // load scenes, select entities and POST /api/write-file therefore stomp on each other,
  // and at `workers: 4` the suite failed nondeterministically — measured on one commit,
  // back to back: 2 failed / 44 passed, then 46/46 green, no code change between them.
  // The flakes were never one bad spec (editor-collider-mode, editor-assets:153 twice,
  // editor-2d-ui:12, editor-model-import:53 have all taken a turn) and every one passed
  // when re-run alone — the signature of contention, not of a broken test.
  //
  // That cost real time twice, in separate sessions, because a red e2e run is
  // indistinguishable from a genuine regression until you re-run it. e2e is also
  // deliberately NOT CI-gated (see CLAUDE.md), so it is the only thing watching editor
  // interaction — a gate you have to second-guess is worse than a slow one.
  //
  // And serial costs ~6%: measured 4m51s for all 46 specs here, vs 4.5-4.9m at `workers: 4`.
  // The parallelism was buying almost nothing precisely BECAUSE the workers were contending.
  //
  // `retries` stays 0 deliberately: retrying would paper over exactly the signal this
  // suite exists to give. The real fix is per-worker isolation (a dev server each), which
  // would let this go parallel again; until then, serial. See docs/todo.md.
  workers: 1,
  retries: 0,
  // `list` for humans, plus a guard that fails a run which reported success while covering only
  // part of the suite (observed once: 17 passed of 46, exit 0). See runCompleteReporter.ts.
  reporter: [['list'], ['./tests/e2e/runCompleteReporter.ts']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    // --strictPort so a freshly-spawned server binds exactly PORT (fail fast on
    // conflict) instead of incrementing and mismatching `url`.
    command: `npm run dev -- --port ${PORT} --strictPort`,
    cwd: REPO_ROOT,
    url: BASE_URL,
    // NEVER adopt a server this run did not start. `true` cost a long debugging session on
    // 2026-07-29: an ORPHANED vite was bound to 38173, Playwright silently adopted it, and it
    // died mid-run — producing a wall of `net::ERR_CONNECTION_REFUSED` whose failure point moved
    // between runs (test 38, then 13, then 5), plus at least one run that finished EARLY and
    // still reported success. Measured, same commit and tree: adopted orphan -> 41 failed / 5
    // passed; port cleared first -> 46 passed, exit 0, clean teardown.
    //
    // Reuse bought almost nothing here — 38173 is a dedicated port that exists precisely so e2e
    // never touches a live editor, so there is rarely a server on it worth reusing. With
    // `false` + `--strictPort`, a stale orphan now fails the run LOUDLY at startup ("Port … is
    // already in use") instead of corrupting it silently. Clear it with `lsof -ti :<port>`,
    // taking the port from the `[e2e] dev server port …` line the config prints at startup —
    // it is per-clone now (#20), so it is no longer always 38173.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
