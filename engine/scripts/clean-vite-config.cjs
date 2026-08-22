/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * afterPack cleanup: remove the `engine/vite.config.cjs` that `stage-vite-config.cjs` emitted
 * into the SOURCE tree at beforePack (#326). The staged app already has its own copy by now, so
 * deleting the source one changes nothing about the artifact.
 *
 * Why this is not optional. `build-web.mjs` picks the packaged config by EXISTENCE, so a leftover
 * `.cjs` in a dev clone would be used by every subsequent DEV build — frozen at whenever the last
 * pack happened, and silently diverging from `vite.config.ts` with every edit after it. That is
 * the stale-copy class this repo has been bitten by before (a packaged build shipping a stale
 * test suite; a stale vendored plugin tarball), and it is invisible: the build succeeds.
 * `engine/tests/plugins/packagedViteConfig.test.ts` asserts a dev clone has no `.cjs` — it caught
 * exactly this, on the first `smoke:packaged` run after the stager landed.
 */

const fs = require('fs');
const path = require('path');

exports.default = async function cleanViteConfig(context) {
  const staged = path.join(path.resolve(__dirname, '..', '..'), 'engine', 'vite.config.cjs');
  if (!fs.existsSync(staged)) return;
  fs.rmSync(staged, { force: true });
  console.log('[clean-vite-config] removed the source-tree engine/vite.config.cjs (#326)');
  void context;
};
