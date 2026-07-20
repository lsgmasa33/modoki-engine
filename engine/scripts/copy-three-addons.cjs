/* eslint-disable @typescript-eslint/no-require-imports */
// electron-builder afterPack hook.
//
// electron-builder's node_modules collection STRIPS directories named "examples"
// (a built-in slimming default that a `files` entry can't override). But the
// runtime imports three/examples/jsm/* (GLTFLoader, HDRLoader, OrbitControls,
// MeshoptDecoder, …) under "run Vite in prod", so the stripped tree breaks GLB/HDR
// loading and no scene renders. Copy three/examples/jsm back into the packed app's
// (unpacked) three. Runs after files are staged but BEFORE signing, so the copied
// files get signed too.
const fs = require('fs');
const path = require('path');

exports.default = async function copyThreeAddons(context) {
  const { appOutDir, packager } = context;
  const productFilename = packager.appInfo.productFilename;
  const resourcesDir =
    context.electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');

  const src = path.join(packager.projectDir, 'node_modules', 'three', 'examples', 'jsm');
  const dest = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'three', 'examples', 'jsm');

  if (!fs.existsSync(src)) {
    console.warn(`[copy-three-addons] source not found, skipping: ${src}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  const n = fs.readdirSync(path.join(dest, 'loaders')).length;
  console.log(`[copy-three-addons] copied three/examples/jsm → app.asar.unpacked (${n} loaders)`);
};
