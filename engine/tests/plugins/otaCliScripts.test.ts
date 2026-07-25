/** engine/scripts/ota-keygen.mjs and engine/scripts/ota-embed-manifest.mjs — two OTA CLI
 *  scripts that had ZERO test coverage (ota-publish.mjs's release.json retry logic is
 *  covered separately in otaPublishReleaseRace.test.ts, via a fake `gcloud` on PATH — it
 *  shells out to the real CLI, so a plain subprocess test here couldn't exercise it
 *  without touching a real bucket). Both scripts below have no exported functions to unit
 *  test, so this runs them as real subprocesses against a scratch repo layout — the same
 *  integration-test posture as modelPipeline.integration.test.ts's CLI shellouts. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Both scripts resolve paths relative to a repo root two levels up from
 *  engine/scripts/<script>.mjs — build a scratch "repo" with that same shape so we don't
 *  touch the real repo's build/ota-keys/ (which may hold a real, precious private key). */
function makeScratchRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-cli-test-'));
  fs.mkdirSync(path.join(repoRoot, 'engine', 'scripts'), { recursive: true });
  // Mirror engine/scripts/ota-*.mjs + ota/ so the scripts' relative imports resolve.
  fs.cpSync(path.join(engineRoot, 'scripts', 'ota-keygen.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-keygen.mjs'));
  fs.cpSync(path.join(engineRoot, 'scripts', 'ota-embed-manifest.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-embed-manifest.mjs'));
  fs.cpSync(path.join(engineRoot, 'scripts', 'ota'), path.join(repoRoot, 'engine', 'scripts', 'ota'), { recursive: true });
  return repoRoot;
}

function runNode(repoRoot: string, scriptRelPath: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [scriptRelPath, ...args], { cwd: repoRoot, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('ota-keygen.mjs', () => {
  let repoRoot: string;
  beforeEach(() => { repoRoot = makeScratchRepo(); });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  it('writes build/ota-keys/default.json and prints the public key on first run', () => {
    const { status, stdout } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', []);
    expect(status).toBe(0);
    const keyPath = path.join(repoRoot, 'build', 'ota-keys', 'default.json');
    expect(fs.existsSync(keyPath)).toBe(true);
    const keypair = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    expect(typeof keypair.publicKey).toBe('string');
    expect(typeof keypair.privateKey).toBe('string');
    expect(stdout).toContain(keypair.publicKey);
  });

  it('writes a private key file that is not world/group readable', () => {
    runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', []);
    const keyPath = path.join(repoRoot, 'build', 'ota-keys', 'default.json');
    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('honors a custom key name, writing to <name>.json', () => {
    const { status } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['prod']);
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(repoRoot, 'build', 'ota-keys', 'prod.json'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'))).toBe(false);
  });

  it('REFUSES to overwrite an existing key (regenerating would orphan every shipped build)', () => {
    const first = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', []);
    expect(first.status).toBe(0);
    const originalKeypair = fs.readFileSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'), 'utf8');

    const second = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', []);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already exists — refusing to overwrite/);
    // The original key must be byte-for-byte untouched by the refused attempt.
    expect(fs.readFileSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'), 'utf8')).toBe(originalKeypair);
  });

  it('two independently generated keys never collide', () => {
    runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['a']);
    runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['b']);
    const a = JSON.parse(fs.readFileSync(path.join(repoRoot, 'build', 'ota-keys', 'a.json'), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(repoRoot, 'build', 'ota-keys', 'b.json'), 'utf8'));
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe('ota-embed-manifest.mjs', () => {
  let repoRoot: string;
  let distDir: string;
  beforeEach(() => {
    repoRoot = makeScratchRepo();
    distDir = path.join(repoRoot, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1);');
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  it('writes ota-embedded-manifest.json into dist/ with the fixed "embedded" version sentinel', () => {
    const { status } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1']);
    expect(status).toBe(0);
    const manifestPath = path.join(distDir, 'ota-embedded-manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.name).toBe('shell');
    expect(manifest.version).toBe('embedded');
    expect(manifest.engineApi).toBe(1);
    expect(Object.keys(manifest.files).sort()).toEqual(['assets/app.js', 'index.html']);
  });

  it('does NOT include a hash of its own output file (hashes BEFORE writing)', () => {
    runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1']);
    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'ota-embedded-manifest.json'), 'utf8'));
    expect(manifest.files['ota-embedded-manifest.json']).toBeUndefined();
  });

  it('rejects a non-positive-integer --engine-api', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '0']);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/--engine-api/);
  });

  it('rejects a missing --dist directory', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', path.join(repoRoot, 'nope'), '--name', 'shell', '--engine-api', '1']);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/dist dir not found/);
  });
});
