#!/usr/bin/env node
/** Generates the Ed25519 keypair OTA releases are signed with (Phase 0 of
 *  docs/plans/mobile-ota-updates-plan.md).
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

console.log(`[ota-keygen] Wrote ${path.relative(repoRoot, keyPath)} (private — do not commit, do not share).`);
console.log('[ota-keygen] Public key (bake this into the app / native trust store):');
console.log(`  ${publicKey}`);
