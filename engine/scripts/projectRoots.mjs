/**
 * The repo's PROJECT ROOT DIRECTORIES — the folders directly under the repo root
 * that hold self-contained Modoki projects (one project = one game, #29).
 *
 *   games/  — internal projects: the owner's testbed (`3d-test`), native-heavy
 *             showcases, and anything whose assets aren't cleared for redistribution.
 *   demos/  — the CURATED, PUBLISHABLE set. A project lives here if and only if we
 *             intend to publish it: owned/CC0 assets, web-only, public docs.
 *             The folder IS the curation. See docs/plans/public-demos-plan.md.
 *
 * SINGLE SOURCE OF TRUTH: every site that enumerates projects derives from this
 * list — the postinstall bootstrap, the web build's tsconfig scoping, the texture
 * cache cleaner, and the Vite asset scanner. Two sites can't derive from it because
 * they are static config and must be kept in sync BY HAND (both carry a pointer
 * comment back here):
 *   - `engine/tsconfig.app.json`  → `include`
 *   - `engine/vite.config.ts`     → `test.include`
 *
 * Adding a fourth root should be a one-line change here plus those two configs.
 *
 * This is a `.mjs` (with a `.d.mts` sidecar) rather than a `.ts` on purpose: three
 * of its consumers are plain Node scripts run directly by npm lifecycle hooks, and
 * they cannot import TypeScript.
 */
import fs from 'node:fs';
import path from 'node:path';

/** @type {readonly string[]} */
export const PROJECT_ROOT_DIRS = ['games', 'demos'];

/**
 * Every project directory under every known root, in root order.
 * Missing roots are skipped — not all checkouts ship both (the public OSS repo
 * ships neither), so callers never have to existence-check first.
 */
export function discoverProjects(repoRoot) {
  const out = [];
  for (const root of PROJECT_ROOT_DIRS) {
    const rootDir = path.join(repoRoot, root);
    if (!fs.existsSync(rootDir)) continue;
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      out.push({ root, name: entry.name, dir: path.join(rootDir, entry.name) });
    }
  }
  return out;
}

/**
 * URL-prefix ↔ absolute-dir pairs for every project that has `runtime/assets`,
 * e.g. `{ urlPrefix: '/demos/3d-physics-demo/assets', absDir: '<abs>/runtime/assets' }`.
 *
 * NOTE this is the MULTI-project (monorepo dev-server) form. A project opened
 * standalone is flat and serves its assets at `/assets` with no root segment —
 * see the flat branch in `engine/plugins/vite-asset-scanner.ts`.
 */
export function projectAssetRoots(repoRoot) {
  const roots = [];
  for (const proj of discoverProjects(repoRoot)) {
    const assets = path.join(proj.dir, 'runtime/assets');
    if (fs.existsSync(assets)) {
      roots.push({ urlPrefix: `/${proj.root}/${proj.name}/assets`, absDir: assets });
    }
  }
  return roots;
}

/**
 * True when `abs` is a project directory — i.e. a DIRECT child of one of the
 * project roots (`<repoRoot>/games/foo`, not `<repoRoot>/games/foo/runtime`).
 * Used to decide whether an in-repo project joins the tsconfig graph.
 */
export function isProjectDir(repoRoot, abs) {
  return PROJECT_ROOT_DIRS.some((root) => {
    const rootDir = path.join(repoRoot, root);
    return abs.startsWith(rootDir + path.sep) && path.dirname(abs) === rootDir;
  });
}
