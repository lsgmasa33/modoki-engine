/**
 * Assert a packaged app did not write into its OWN bundle (#326).
 *
 * The packaged editor's REPO_ROOT is the app's own `app.asar.unpacked`, so any build-chain or
 * backend write rooted there lands inside the signed application. Nothing errors when it does —
 * on macOS a bundle is writable and the signature is an integrity seal, so the damage is silent
 * and only `codesign --verify` / `spctl --assess` ever notice, at which point notarization is
 * already gone. Three separate writers shipped this way before anyone looked (`3df0e65d4`,
 * `ed17ff8a2`, `#326`), each found by hand long after the fact.
 *
 * So compare the bundle's file list before and after a run. Content is deliberately NOT hashed:
 * an added or deleted path is what breaks the seal AND what a reader can act on, while a hash
 * diff over ~17k files would be slow and would flag mtime-only churn as a defect.
 *
 *   node assertBundleUnchanged.mjs snapshot <appDir> <listFile>
 *   node assertBundleUnchanged.mjs assert   <appDir> <listFile>
 *
 * `assert` exits 1 and names the paths on any difference.
 *
 * ⚠️ Written and measured on macOS only. If this fires on Windows it has most likely found a
 * real platform-specific writer — read the paths before assuming the guard is wrong.
 */
import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Every file under `dir`, as app-relative POSIX paths, sorted. Symlinks are listed, not
 *  followed — a macOS .app is full of them (`Versions/Current`) and following them would both
 *  double-count and risk a cycle. */
function listFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, e.name);
      if (e.isDirectory()) walk(child);
      // A DIRECTORY is not listed: codesign does not seal an empty one, so an empty
      // `node_modules/.vite-temp` left by a completed build is NOT a signature break and must
      // not be reported as one (measured 2026-08-22 — that mistake sent an investigation after
      // the wrong writer for a day).
      else out.push(path.relative(dir, child).split(path.sep).join('/'));
    }
  };
  walk(dir);
  // .DS_Store is Finder's, not the app's — and it appears only if a human opened the folder.
  return out.filter((p) => !p.endsWith('/.DS_Store') && p !== '.DS_Store').sort();
}

const [mode, appDir, listFile] = process.argv.slice(2);
if (!mode || !appDir || !listFile) {
  console.error('usage: assertBundleUnchanged.mjs snapshot|assert <appDir> <listFile>');
  process.exit(2);
}

if (mode === 'snapshot') {
  writeFileSync(listFile, listFiles(appDir).join('\n'));
  process.exit(0);
}

if (mode === 'assert') {
  const before = new Set(readFileSync(listFile, 'utf8').split('\n').filter(Boolean));
  // An empty snapshot would make every comparison below trivially true — the exact shape of
  // "a guard that passes because it measured nothing". Fail instead.
  if (before.size === 0) {
    console.error(`[bundle] FAIL: snapshot ${listFile} is empty — this check would pass vacuously.`);
    process.exit(1);
  }
  const after = listFiles(appDir);
  const added = after.filter((p) => !before.has(p));
  const removed = [...before].filter((p) => !after.includes(p));
  if (!added.length && !removed.length) {
    console.log(`[bundle] ok: the app wrote nothing into its own bundle (${after.length} files)`);
    process.exit(0);
  }
  console.error('[bundle] FAIL: the app modified its OWN bundle — this breaks the code signature (#326).');
  for (const p of added) console.error(`    + ${p}`);
  for (const p of removed) console.error(`    - ${p}`);
  console.error('  Route the write outside the bundle (see modokiStateDir() / chooseViteConfig()),');
  console.error('  do not relax this check. docs/build.md § "must not write inside its own bundle".');
  process.exit(1);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
