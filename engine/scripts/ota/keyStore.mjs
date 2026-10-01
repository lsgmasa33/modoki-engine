/** Where an OTA signing key lives, and how a key an earlier editor wrote elsewhere reaches it (#1983).
 *
 *  THE KEY LIVES IN THE PROJECT: `<projectRoot>/build/ota-keys/<name>.json`. The folder ignores itself
 *  (`ensureKeyDir` writes a `.gitignore` of `*` into it), because a key can land in any project — one
 *  scaffolded before #1983 has no `.gitignore` of its own — and git must never see it there. It used to live under the
 *  EDITOR's root — the clone in the dev editor, and `<App>.app/Contents/Resources/app.asar.unpacked`
 *  in the packaged one, where an editor update replaces the bundle and the key with it. A lost key is
 *  irreversible: every installed binary has its public half baked in, so no other key can update it.
 *
 *  So the move is a COPY, never a move or a delete. The first read of a project that has no key
 *  (`adoptLegacyKey`, run by the publish preflight, the keygen script and `/api/ota/keys`) looks in the
 *  old places and copies a key it finds into the project, leaving the original where it was:
 *  - the editor's root (`editorRoot/build/ota-keys`): the packaged bundle, or the dev clone;
 *  - every ancestor of the project (`games/<id>` → the repo root), so a packaged editor opening a game
 *    inside a clone still finds the key the dev editor wrote there.
 *  A key is copied only into a project that bakes ITS public half (`ota.publicKey`): that is a project
 *  that shipped with it, and the only kind that can lose anything. A same-named key with another public
 *  half could sign nothing this project's binaries accept, and a project with no public key yet has no
 *  binary that trusts any key — both are reported and left alone, so the private key is not copied
 *  into projects that never used it. A project that shipped with the shared `default` therefore gets a
 *  copy of that same key, never a fresh one; keygen refuses once a copy exists.
 *
 *  ⚠️ What this CANNOT rescue: a key inside a packaged editor's bundle is deleted by the update that
 *  installs the editor carrying this code (the updater replaces the whole bundle first). That key must
 *  be copied out by hand BEFORE updating (docs/ota-updates.md § Signing key).
 *
 *  The machine is the boundary: nothing here syncs keys between machines (docs/ota-updates.md § Signing
 *  key: backup and other machines). */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJsonFile } from '../jsonFile.mjs';

/** The project's key file. */
export function projectKeyPath(projectRoot, name) {
  return path.join(projectRoot, 'build', 'ota-keys', `${name}.json`);
}

/** Create the project's key folder, carrying its own `.gitignore` of `*` (never replacing one that is
 *  there), so the key is ignored in any project, whatever its own ignore rules say. */
export function ensureKeyDir(projectRoot) {
  const dir = path.dirname(projectKeyPath(projectRoot, 'x'));
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) {
    try {
      fs.writeFileSync(ignore, '# OTA signing keys: private, never committed (docs/ota-updates.md § Signing key).\n*\n', { flag: 'wx' });
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e; // a concurrent first read wrote it: the same file
    }
  }
  return dir;
}

/** The directories earlier editors wrote keys to, for this project: the editor's root, then each
 *  ancestor of the project (nearest first). The project's own directory is not one of them. */
export function legacyKeyDirs({ projectRoot, editorRoot }) {
  const dirs = [];
  const add = (root) => {
    const dir = path.join(path.resolve(root), 'build', 'ota-keys');
    if (!dirs.includes(dir)) dirs.push(dir);
  };
  if (editorRoot) add(editorRoot);
  let at = path.resolve(projectRoot);
  for (;;) {
    const up = path.dirname(at);
    if (up === at) break;
    add(up);
    at = up;
  }
  const own = path.dirname(projectKeyPath(path.resolve(projectRoot), 'x'));
  return dirs.filter((d) => d !== own);
}

/** Restrict a private-key file to the current account. POSIX: mode 0600. Windows has no POSIX bits
 *  (Node's `mode` only toggles read-only there), so an ACL: drop inherited ACEs, grant this user full
 *  control. Throws when that cannot be done — the caller decides what to remove, because an
 *  unprotected key that only LOOKS protected is the failure this exists to prevent. */
export function restrictToOwner(file) {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
    return;
  }
  const user = process.env.USERNAME;
  if (!user) throw new Error('USERNAME is not set, so the ACL has no principal to grant to');
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'pipe' });
}

function readPublicHalf(file) {
  try {
    const k = readJsonFile(file);
    return typeof k?.publicKey === 'string' && typeof k?.privateKey === 'string' ? k.publicKey : null;
  } catch {
    return null;
  }
}

/** A key folder that already holds a key gets its `.gitignore` if it lacks one (a key copied in by hand
 *  to a second machine, per the docs). Best effort: the key is already there and valid, so failing a
 *  publish over a hygiene write would protect nothing — a failure is logged. A SYMLINKED folder is left
 *  alone: it points somewhere the user chose (a backup repo, say), where a `*` would silently stop new
 *  keys reaching it. */
function healKeyDir(projectRoot, log) {
  const dir = path.dirname(projectKeyPath(projectRoot, 'x'));
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return;
    ensureKeyDir(projectRoot);
  } catch (e) {
    log(`[ota-keys] warning: could not write ${path.join(dir, '.gitignore')} (${e instanceof Error ? e.message : String(e)}); make sure git ignores this folder`);
  }
}

/** Make sure the project has its key, copying one an earlier editor wrote (see the header). Never
 *  overwrites, never moves or deletes the original, and checks the copy is byte-identical before it
 *  counts. Returns `{ keyPath, copiedFrom }` (`copiedFrom` null when nothing was copied) plus
 *  `passedOver`: same-named keys found but not copied, with why. Throws when `configReadable` is false
 *  and a same-named earlier key exists (whether the project shipped with it is unknown), and when a
 *  copy was started and could not be completed safely (the partial copy is removed; the original is
 *  untouched). `configReadable` is REQUIRED: defaulting it would read "could not read the config" as
 *  "no public key", the one confusion that mints over a shipped key. */
export function adoptLegacyKey({ projectRoot, editorRoot, name, expectedPublicKey, configReadable, log = (line) => console.log(line) }) {
  if (typeof configReadable !== 'boolean') throw new TypeError('adoptLegacyKey: configReadable is required (true/false)');
  const keyPath = projectKeyPath(projectRoot, name);
  const passedOver = [];
  if (fs.existsSync(keyPath)) {
    healKeyDir(projectRoot, log);
    return { keyPath, copiedFrom: null, passedOver };
  }
  const expected = typeof expectedPublicKey === 'string' && expectedPublicKey ? expectedPublicKey : null;
  let source = null;
  for (const dir of legacyKeyDirs({ projectRoot, editorRoot })) {
    const candidate = path.join(dir, `${name}.json`);
    if (!fs.existsSync(candidate)) continue;
    const pub = readPublicHalf(candidate);
    if (pub === null) { passedOver.push({ from: candidate, reason: 'not a readable keypair' }); continue; }
    // UNKNOWN is not EMPTY: with an unreadable project.config.json this may be the key the project
    // shipped with, and the caller's next step (keygen) would mint over it. Refuse instead.
    if (!configReadable) {
      throw new Error(`${path.join(projectRoot, 'project.config.json')} could not be read, so whether this project shipped with ${candidate} is unknown. Fix the config first; nothing was copied or minted.`);
    }
    if (!expected) { passedOver.push({ from: candidate, reason: 'this project bakes no ota.publicKey yet, so no build of it trusts this key' }); continue; }
    if (pub !== expected) { passedOver.push({ from: candidate, reason: "its public key is not this project's ota.publicKey" }); continue; }
    source = candidate;
    break;
  }
  for (const p of passedOver) log(`[ota-keys] not copying ${p.from} into ${keyPath}: ${p.reason}`);
  if (!source) return { keyPath, copiedFrom: null, passedOver };

  ensureKeyDir(projectRoot);
  try {
    // EXCL: a key that appeared meanwhile (another editor, a keygen) is never overwritten.
    fs.copyFileSync(source, keyPath, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e?.code === 'EEXIST') return { keyPath, copiedFrom: null, passedOver };
    throw e;
  }
  try {
    restrictToOwner(keyPath);
    if (!fs.readFileSync(keyPath).equals(fs.readFileSync(source))) throw new Error('the copy is not byte-identical to its source');
  } catch (e) {
    fs.rmSync(keyPath, { force: true });
    throw new Error(`could not copy the OTA key ${source} into ${keyPath} safely (${e instanceof Error ? e.message : String(e)}). `
      + `The original is untouched. Copy it there yourself and restrict it to your account (on Windows, in cmd.exe: icacls "${keyPath}" /inheritance:r /grant:r "%USERNAME%:F").`, { cause: e });
  }
  log(`[ota-keys] copied ${name}.json into ${path.dirname(keyPath)} from ${source} (the original stays where it was)`);
  return { keyPath, copiedFrom: source, passedOver };
}
