/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder `afterPack` orchestrator. afterPack accepts a SINGLE hook, so this fans out
 * the way `before-pack.cjs` does for beforePack. It runs after the app files are staged but
 * BEFORE signing, so anything written into the staged app here still gets signed.
 */

const copyThreeAddons = require('./copy-three-addons.cjs').default;
const cleanViteConfig = require('./clean-vite-config.cjs').default;

exports.default = async function afterPack(context) {
  await copyThreeAddons(context);
  // Last: it deletes a SOURCE-tree file, so nothing after it may still need one.
  await cleanViteConfig(context);
};
