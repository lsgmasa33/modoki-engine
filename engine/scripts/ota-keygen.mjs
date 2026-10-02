#!/usr/bin/env node
/** Generates the Ed25519 keypair OTA releases are signed with (Phase 0 of
 *  docs/ota-updates.md).
 *
 *  Run ONCE per signing identity. The PRIVATE key is written into the PROJECT's gitignored
 *  `build/ota-keys/<name>.json` (#1983) — never commit it, never let it leave this machine
 *  except as a backup (docs/ota-updates.md § Signing key: backup and other machines). The
 *  PUBLIC key is printed for the project's `ota.publicKey`.
 *
 *  Usage:
 *    node engine/scripts/ota-keygen.mjs [name] --project <dir> [--editor-root <dir>] [--rotate]
 *  `name` defaults to "default". `--editor-root` (default: this checkout) is only where an
 *  earlier editor may have written the key; see keyStore.mjs.
 *
 *  Refuses to overwrite an existing key (a silent regenerate would orphan every app build
 *  that already has the old public key baked in), and refuses to mint one when an earlier
 *  editor's key of that name can be copied in instead: a project that signed with it must
 *  keep signing with it.
 *
 *  And refuses to mint while the project bakes an `ota.publicKey` that NO key it holds is the pair
 *  of (#1993): a second machine, a project copied out of the repo, an earlier key that could not be
 *  read. Not finding the shipped key is not the same as there being none, and a new key's public
 *  half is one OTA Keys "Sync" away from replacing the shipped one, which strands every installed
 *  build. Once the shipped key IS held, another name is a deliberate second identity and is minted.
 *  `--rotate` mints anyway — the one deliberate way to give a shipped project a new key; the editor
 *  route never passes it.
 */
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeypair } from './ota/signing.mjs';
import { adoptLegacyKey, ensureKeyDir, heldKeyFor, projectKeyPath, restrictToOwner } from './ota/keyStore.mjs';
import { readRawOtaBlock } from './ota/publishPreflight.mjs';
import { OTA_SAFE_TOKEN, isOtaKeyName } from './ota/otaSafeTokens.mjs';

const defaultEditorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rawArgs = process.argv.slice(2);
let projectRoot = null;
let editorRoot = defaultEditorRoot;
let rotate = false;
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  const flag = rawArgs[i];
  if (flag === '--') { positional.push(...rawArgs.slice(i + 1)); break; } // the route passes the name after it
  if (flag === '--project' || flag === '--editor-root') {
    // A bare trailing flag would otherwise reach `path.resolve(undefined)` — for a flag that decides
    // WHERE a private key lands, say what is wrong instead of crashing.
    const value = rawArgs[++i];
    if (!value) {
      console.error(`[ota-keygen] ${flag} requires a directory argument.`);
      process.exit(1);
    }
    if (flag === '--project') projectRoot = path.resolve(value);
    else editorRoot = path.resolve(value);
    continue;
  }
  if (flag === '--rotate') {
    rotate = true;
    continue;
  }
  if (flag === '--repo-root') {
    console.error('[ota-keygen] --repo-root is gone: the key now lives in the project (#1983). Pass --project <dir>.');
    process.exit(1);
  }
  if (flag.startsWith('--')) {
    console.error(`[ota-keygen] unknown flag ${flag}.`);
    process.exit(1);
  }
  positional.push(flag);
}
if (!projectRoot) {
  console.error('[ota-keygen] --project <dir> is required: the key is written into that project\'s build/ota-keys/.');
  process.exit(1);
}
const name = positional[0] || 'default';
// A name is a file name, never a flag: the route used to put `?name=--rotate` straight into argv, which
// this loop then read as the flag that mints past a shipped key (#1993 review).
if (positional.length > 1 || !isOtaKeyName(name)) {
  console.error(`[ota-keygen] the key name must be ONE name matching ${OTA_SAFE_TOKEN} that does not start with "-" (got ${JSON.stringify(positional)}).`);
  process.exit(1);
}
const keyPath = projectKeyPath(projectRoot, name);

// A key an earlier editor wrote outside the project is copied in, never replaced by a new one.
const raw = readRawOtaBlock(projectRoot);
// An unreadable config is not "no public key": whether this project shipped with some key is unknown,
// and a new public half could not be written into it anyway. Refuse before deciding anything.
if (!raw.ok && raw.reason !== 'missing') {
  console.error(`[ota-keygen] ${raw.file} could not be read (${raw.error}). Fix it first; nothing was minted.`);
  process.exit(1);
}
let adopted;
try {
  adopted = adoptLegacyKey({ projectRoot, editorRoot, name, expectedPublicKey: raw.ok ? raw.ota?.publicKey : undefined, configReadable: raw.ok || raw.reason === 'missing' });
} catch (e) {
  console.error(`[ota-keygen] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
if (adopted.copiedFrom) {
  console.error(`[ota-keygen] ${keyPath} now exists — copied from ${adopted.copiedFrom}, the key whose public half this project's ota.publicKey bakes. Not minting a new one.`);
  console.error('[ota-keygen] Pass a different name to create a second identity.');
  process.exit(1);
}
if (existsSync(keyPath)) {
  console.error(`[ota-keygen] ${keyPath} already exists — refusing to overwrite.`);
  console.error('[ota-keygen] Regenerating orphans every app build that already has the old public key baked in.');
  console.error('[ota-keygen] Pass a different name to create a second identity: node engine/scripts/ota-keygen.mjs <name> --project <dir>');
  process.exit(1);
}

const shipped = raw.ok && typeof raw.ota?.publicKey === 'string' && raw.ota.publicKey ? raw.ota.publicKey : null;
if (shipped && !rotate && !heldKeyFor(projectRoot, shipped)) {
  console.error(`[ota-keygen] This project's ota.publicKey (${shipped}) is baked into every build it shipped, and no key in`);
  console.error(`[ota-keygen] ${path.dirname(keyPath)} is its pair. Not minting: a new key would sign nothing those builds accept.`);
  for (const p of adopted.passedOver) console.error(`[ota-keygen]   passed over ${p.from}: ${p.reason}`);
  console.error('[ota-keygen] Copy the original key in from your backup or the machine that made it (docs/ota-updates.md § Signing key).');
  console.error('[ota-keygen] To replace it deliberately — every installed build then stops receiving updates until a new store');
  console.error(`[ota-keygen] release — run: node engine/scripts/ota-keygen.mjs ${name} --project ${JSON.stringify(projectRoot)} --rotate`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeypair();
ensureKeyDir(projectRoot);
try {
  // EXCL, not just the existsSync above: a second keygen (the dialog and an agent at once) can write
  // between that check and this line, and its key must not be silently replaced.
  writeFileSync(keyPath, JSON.stringify({ publicKey, privateKey }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
  console.error(`[ota-keygen] ${keyPath} appeared while this key was being made (another keygen?) — refusing to overwrite it.`);
  process.exit(1);
}

// An ERROR path, not a warning: an unprotected private signing key that only *looks* protected
// is the silent-failure class this guards (Windows has no POSIX bits — `restrictToOwner` uses an
// ACL there). On failure remove the key, so the outcome is atomic: a protected key, or none.
try {
  restrictToOwner(keyPath);
  if (process.platform === 'win32') console.log(`[ota-keygen] Restricted to ${process.env.USERNAME} via icacls (POSIX mode 0600 is a no-op on Windows).`);
} catch (e) {
  rmSync(keyPath, { force: true });
  console.error('[ota-keygen] FAILED to restrict the private key to this account, so it would have been');
  console.error('[ota-keygen] readable by other local accounts. The key was DELETED rather than left');
  console.error(`[ota-keygen] unprotected. Cause: ${e instanceof Error ? e.message : e}`);
  console.error(`[ota-keygen] Fix the cause, or create it manually and run:`);
  console.error(`[ota-keygen]   icacls "${keyPath}" /inheritance:r /grant:r "%USERNAME%:F"`);
  process.exit(1);
}
// Reported AFTER the ACL step, not before it: on Windows a failed ACL deletes the key, so
// announcing the write first would claim a file that no longer exists.
console.log(`[ota-keygen] Wrote ${keyPath} (private — do not commit, do not share; back it up: losing it ends OTA for every shipped build).`);
console.log('[ota-keygen] Public key (bake this into the app / native trust store):');
console.log(`  ${publicKey}`);
