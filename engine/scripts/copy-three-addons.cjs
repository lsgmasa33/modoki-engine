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

  // ⚠️ **FAIL the pack — do not warn and return** (#945 B4). This used to skip silently, and a
  // skip here ships an app in which three/examples/jsm is absent: no GLTFLoader, no HDRLoader,
  // no OrbitControls, so NO GLB OR HDR LOADS AND NO SCENE RENDERS. Nothing downstream catches
  // it — the app starts, the window opens, and the viewport is empty — so the only signal was a
  // warning in a packaging log nobody reads.
  //
  // Unlike the toolchain stagers in before-pack.cjs, "absent" is not a legitimate state here:
  // those stage OPTIONAL native tools that a build machine may genuinely lack (the app degrades
  // to source textures), whereas `three` is a hard dependency that npm install always provides.
  // Its absence means the packing environment is broken, and a broken pack must not be signed.
  if (!fs.existsSync(src)) {
    throw new Error(
      `[copy-three-addons] three/examples/jsm not found at ${src} — refusing to pack. `
        + 'Without it the packed app cannot load any GLB or HDR and renders nothing. '
        + 'Run `npm install` in the project dir before packing.',
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  const n = fs.readdirSync(path.join(dest, 'loaders')).length;
  console.log(`[copy-three-addons] copied three/examples/jsm → app.asar.unpacked (${n} loaders)`);
};
