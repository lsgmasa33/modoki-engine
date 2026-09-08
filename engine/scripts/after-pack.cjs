/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder `afterPack` orchestrator. afterPack accepts a SINGLE hook, so this fans out
 * the way `before-pack.cjs` does for beforePack. It runs after the app files are staged but
 * BEFORE signing, so anything written into the staged app here still gets signed.
 */

const copyThreeAddons = require('./copy-three-addons.cjs').default;
const cleanViteConfig = require('./clean-vite-config.cjs').default;

exports.default = async function afterPack(context) {
  // ⚠️ **`finally`, because a step above can now THROW** (#945 B4 gave `copyThreeAddons` a
  // fail-the-pack path where it previously warned and returned). `cleanViteConfig` deletes the
  // `engine/vite.config.cjs` that `beforePack` emitted into the SOURCE tree, and its own header
  // explains why that is not optional: `build-web.mjs` picks the packaged config by EXISTENCE,
  // so a leftover freezes every subsequent DEV build at whenever the failed pack happened, and
  // `packagedViteConfig.test.ts` then reddens `npm run verify` until a human deletes the file by
  // hand. Without this, the failure branch of the new throw punishes the developer twice — once
  // for the broken pack, and again with a poisoned tree.
  //
  // The original error still propagates: `finally` does not swallow it, and the pack must fail.
  try {
    await copyThreeAddons(context);
  } finally {
    // Last: it deletes a SOURCE-tree file, so nothing after it may still need one.
    //
    // ⚠️ **Its own failure must not REPLACE the error we are unwinding.** `fs.rmSync(…, {force})`
    // suppresses only ENOENT — an EPERM/EBUSY (Windows: the file held open by a concurrent dev
    // server; a read-only tree) throws from inside this `finally` and substitutes itself for the
    // real cause, so the pack would fail with `EPERM … unlink vite.config.cjs` and the actual
    // `three/examples/jsm not found — refusing to pack` would be gone.
    try {
      await cleanViteConfig(context);
    } catch (e) {
      console.warn('[after-pack] could not remove the staged engine/vite.config.cjs — delete it by '
        + `hand before the next dev build, or it will be used instead of vite.config.ts: ${e instanceof Error ? e.message : e}`);
    }
  }
};
