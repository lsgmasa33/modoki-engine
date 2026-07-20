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
  workers: 4,
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
