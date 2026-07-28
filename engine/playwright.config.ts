import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
// would write changes to disk. Override with MODOKI_E2E_PORT when running e2e from a
// second worktree so each targets its own server (see CLAUDE.md worktree rules).
const PORT = process.env.MODOKI_E2E_PORT ?? '38173';
const BASE_URL = `http://localhost:${PORT}`;

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
  reporter: [['list']],
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
    // conflict) instead of incrementing and mismatching `url`. When a dev server
    // is already up on PORT, reuseExistingServer skips the command entirely.
    command: `npm run dev -- --port ${PORT} --strictPort`,
    cwd: REPO_ROOT,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
