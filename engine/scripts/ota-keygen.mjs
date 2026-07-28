#!/usr/bin/env node
/** Generates the Ed25519 keypair OTA releases are signed with (Phase 0 of
 *  docs/ota-updates.md).
 *
 *  Run ONCE per signing identity (e.g. once for the whole engine, or once per
 *  game if you want independent trust roots). The PRIVATE key is written under
 *  the gitignored `build/ota-keys/` — never commit it, never let it leave this
 *  machine/CI secret store. The PUBLIC key is printed so you can paste it into
 *  whatever constant/config the native app + ota-publish.mjs read it from
 *  (Phase 1 wires the app-side constant; ota-publish.mjs already reads it from
 *  the same file this script writes).
 *
 *  Usage:
 *    node engine/scripts/ota-keygen.mjs [name]
 *  `name` defaults to "default" — the key file is build/ota-keys/<name>.json.
 *  Refuses to overwrite an existing key file (a silent regenerate would orphan
 *  every app build that already has the old public key baked in).
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeypair } from './ota/signing.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const name = process.argv[2] || 'default';
const keyDir = path.join(repoRoot, 'build', 'ota-keys');
const keyPath = path.join(keyDir, `${name}.json`);

if (existsSync(keyPath)) {
  console.error(`[ota-keygen] ${path.relative(repoRoot, keyPath)} already exists — refusing to overwrite.`);
  console.error('[ota-keygen] Regenerating orphans every app build that already has the old public key baked in.');
  console.error('[ota-keygen] Pass a different name to create a second identity: node engine/scripts/ota-keygen.mjs <name>');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeypair();
mkdirSync(keyDir, { recursive: true });
writeFileSync(keyPath, JSON.stringify({ publicKey, privateKey }, null, 2) + '\n', { mode: 0o600 });

// Windows has no POSIX permission bits — Node's `mode` above can only toggle the
// read-only flag there, so the key would land readable by EVERY local account. Restrict
// it with an ACL instead: `/inheritance:r` drops the inherited ACEs that grant other
// principals access, and `/grant:r <user>:F` re-grants full control to just this account
// (`:F`, not `:R`, so the owner can still rotate/delete their own key).
//
// This is an ERROR path, not a warning: an unprotected private signing key that only
// *looks* protected is precisely the silent-failure class this guard exists to prevent.
// On failure remove the key so the outcome is atomic — a protected key, or none at all.
// (Leaving it would also trip the "refusing to overwrite" guard above on the next run.)
if (process.platform === 'win32') {
  const user = process.env.USERNAME;
  try {
    if (!user) throw new Error('USERNAME is not set, so the ACL has no principal to grant to');
    execFileSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'pipe' });
    console.log(`[ota-keygen] Restricted to ${user} via icacls (POSIX mode 0600 is a no-op on Windows).`);
  } catch (e) {
    rmSync(keyPath, { force: true });
    console.error('[ota-keygen] FAILED to restrict the private key with an ACL, so it would have been');
    console.error('[ota-keygen] readable by other local accounts. The key was DELETED rather than left');
    console.error(`[ota-keygen] unprotected. Cause: ${e instanceof Error ? e.message : e}`);
    console.error(`[ota-keygen] Fix the cause, or create it manually and run:`);
    console.error(`[ota-keygen]   icacls "${keyPath}" /inheritance:r /grant:r "%USERNAME%:F"`);
    process.exit(1);
  }
}
// Reported AFTER the ACL step, not before it: on Windows a failed ACL deletes the key, so
// announcing the write first would claim a file that no longer exists.
console.log(`[ota-keygen] Wrote ${path.relative(repoRoot, keyPath)} (private — do not commit, do not share).`);
// The 0o600 above is a POSIX no-op on Windows (Node's `mode` can only toggle read-only
// there), so the key lands readable by every local account. Say so rather than implying
// a protection that isn't there; restricting it needs an ACL, e.g.
//   icacls "<file>" /inheritance:r /grant:r "%USERNAME%:R"
if (process.platform === 'win32') {
  console.warn('[ota-keygen] WARNING (Windows): file permissions were NOT restricted — POSIX mode 0600 is');
  console.warn('[ota-keygen] not enforceable here, so this key is readable by other local accounts.');
  console.warn(`[ota-keygen] To lock it down: icacls "${keyPath}" /inheritance:r /grant:r "%USERNAME%:R"`);
}
console.log('[ota-keygen] Public key (bake this into the app / native trust store):');
console.log(`  ${publicKey}`);
