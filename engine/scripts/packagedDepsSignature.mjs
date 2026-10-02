/**
 * A content hash of everything the packaged editor's pre-bundled Vite deps are built FROM that Vite
 * itself does not key on (#2064). It covers the root lockfiles and the source of every LINKED
 * workspace package.
 *
 * The packaged editor's Vite pre-bundles `@modoki/engine`, the capacitor-* plugins and the
 * registry deps (react, three, koota, …) into `userData/vite-cache`. In dev, Vite keys that cache
 * on `node_modules/.package-lock.json` plus its config. **In the packaged app it keys on NO
 * lockfile at all.** electron-builder ships neither `package-lock.json` nor the hidden
 * `node_modules/.package-lock.json`, so Vite's `getLockfileHash` finds nothing and records the hash
 * of the empty string (`"lockfileHash": "e3b0c442"` in every packaged `_metadata.json`, observed
 * 2026-10-03). Every dependency change therefore has to reach the cache bust through this signature
 * instead, and there are two kinds:
 *
 * - **Registry deps** are pinned by `package-lock.json`, plus `node_modules/.package-lock.json`,
 *   npm's record of what is actually installed. Their bytes are hashed, so a version bump moves the
 *   signature.
 * - **Workspace packages** (`"link": true` in the lockfile) are NOT pinned by it. In the repo they
 *   are symlinks (`node_modules/@modoki/engine -> engine/packages/modoki`), and electron-builder
 *   turns each link into a COPY of the working tree. So their content changes with every engine
 *   edit while the lockfile stays byte-identical. Their files are hashed directly. The set is
 *   DERIVED from the lockfile, so a new workspace package joins it without an edit here.
 *
 * Skipped inside a linked package, and why each is safe to skip:
 * - `node_modules/` — a nested dependency is a lockfile entry, hashed above.
 * - dot-directories (`.build`, `.swiftpm`, …) — tool state, not source, and no bundler resolves
 *   into them. SwiftPM's `.build` caches are thousands of files that change on every native build.
 * Everything else is hashed, including files the optimizer never reads (tests, native sources).
 * Hashing too much only costs one extra re-optimize after a rebuild; hashing too little is the
 * crash this exists to prevent.
 *
 * Runs at BUILD time (electronBuildOpts.mjs bakes it into main.cjs as a define), never at boot.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './jsonFile.mjs';

/** The lockfiles whose bytes pin the registry deps. The first is required, the second hashed when present. */
const LOCKFILES = ['package-lock.json', 'node_modules/.package-lock.json'];

/** The lockfile's linked packages: `[lockfile key, absolute package dir]`, sorted by key. */
export function linkedPackages(repoRoot) {
  const lock = readJsonFile(path.join(repoRoot, 'package-lock.json'));
  return Object.entries(lock.packages ?? {})
    .filter(([key, entry]) => key && entry && entry.link === true && typeof entry.resolved === 'string')
    .map(([key, entry]) => [key, path.resolve(repoRoot, entry.resolved)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every file under `dir` that the signature covers, as sorted POSIX-relative paths. Symlinks are
 *  listed, not followed. */
function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        walk(path.join(abs, ent.name), childRel);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

const digest = (body) => createHash('sha256').update(body).digest();

/** The signature: 16 hex chars over the lockfiles' bytes and every linked package's key, file paths
 *  and file bytes. */
export function packagedDepsSignature(repoRoot) {
  const h = createHash('sha256');
  for (const rel of LOCKFILES) {
    const abs = path.join(repoRoot, rel);
    h.update(`lock\0${rel}\0`);
    h.update(fs.existsSync(abs) ? digest(fs.readFileSync(abs)) : 'absent');
  }
  for (const [key, dir] of linkedPackages(repoRoot)) {
    if (!fs.existsSync(dir)) {
      throw new Error(`packagedDepsSignature: package-lock.json links ${key} to ${dir}, which does not exist — run npm install`);
    }
    h.update(`pkg\0${key}\0`);
    for (const rel of listFiles(dir)) {
      const abs = path.join(dir, rel);
      h.update(`file\0${rel}\0`);
      h.update(digest(fs.lstatSync(abs).isSymbolicLink() ? `->${fs.readlinkSync(abs)}` : fs.readFileSync(abs)));
    }
  }
  return h.digest('hex').slice(0, 16);
}
