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

  // The same guarantee — "only this account can read the private key" — is enforced by a
  // different mechanism per platform, so it takes one test each. POSIX gets mode 0600;
  // Windows has no POSIX bits (Node's `mode` only toggles read-only there, so the file
  // would land 0o666) and gets an icacls ACL instead.
  it.skipIf(process.platform === 'win32')('writes a private key file that is not world/group readable', () => {
    runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', []);
    const keyPath = path.join(repoRoot, 'build', 'ota-keys', 'default.json');
    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.runIf(process.platform === 'win32')('restricts the private key to the current account (Windows ACL)', () => {
    const { status } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', []);
    expect(status).toBe(0); // a failed ACL is a hard error — keygen deletes the key and exits 1
    const keyPath = path.join(repoRoot, 'build', 'ota-keys', 'default.json');
    expect(fs.existsSync(keyPath)).toBe(true);
    // `icacls <file>` lists the ACEs. Assert the actual security property — no ORDINARY
    // account can read the key — rather than "icacls was invoked".
    //
    // SYSTEM and Administrators are deliberately tolerated: they are root-equivalent, and
    // the POSIX 0600 this mirrors doesn't exclude root either. They can also survive
    // `/inheritance:r`, which strips INHERITED ACEs but not explicit ones — measured on the
    // CI runner, where the temp dir carries an explicit SYSTEM ACE and this test originally
    // failed by demanding sole ownership.
    //
    // What must be gone are the broad grants. At the real key location (repo `build/`) the
    // inherited default is `BUILTIN\Users:(RX)` + `NT AUTHORITY\Authenticated Users:(M)` —
    // i.e. every local account could READ and even REPLACE the signing key. That is the
    // exposure this guards, and it is why mode 0o600 being a Windows no-op actually matters.
    const acl = execFileSync('icacls', [keyPath], { encoding: 'utf8' });
    const aces = acl
      .split(/\r?\n/)
      .map((l) => l.match(/^(?:.*\.json)?\s*([^:]+):(\([A-Z]+\))+/i))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ principal: m[1].trim().toLowerCase(), flags: m[0] }));
    expect(aces.length).toBeGreaterThan(0);

    // PRIMARY assertion — proves `/inheritance:r` actually ran, independent of what the
    // surrounding directory happens to grant. icacls marks an INHERITED ace with `(I)`;
    // after /inheritance:r none may remain. Without this, the test would pass vacuously in
    // a temp dir (whose defaults are already just SYSTEM/Administrators/owner) even if the
    // ACL step were skipped entirely — which is precisely the vacuous-pass this replaces.
    for (const ace of aces) expect(ace.flags).not.toContain('(I)');

    // The broad grants must be absent. At the REAL key location (repo `build/`) the
    // inherited default is `BUILTIN\Users:(RX)` + `NT AUTHORITY\Authenticated Users:(M)`:
    // every local account could read AND replace the signing key. That is the exposure.
    for (const ace of aces) {
      expect(ace.principal).not.toBe('builtin\\users');
      expect(ace.principal).not.toBe('nt authority\\authenticated users');
    }

    // Any remaining non-root principal must be this account. SYSTEM/Administrators are
    // tolerated as root-equivalent — the POSIX 0600 this mirrors doesn't exclude root
    // either, and an EXPLICIT (non-inherited) SYSTEM ace survives /inheritance:r, which is
    // how this test first failed on the CI runner by demanding sole ownership.
    const user = process.env.USERNAME!.toLowerCase();
    for (const ace of aces) {
      if (ace.principal === 'nt authority\\system' || ace.principal === 'builtin\\administrators') continue;
      expect(ace.principal).toContain(user);
    }
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

  // #582's "Related" finding: `/api/ota/keygen` passes `--repo-root` explicitly now, the same
  // value `/api/ota/keys` reads back with — before that flag existed the two agreed only
  // because the route happened to invoke this script by a cwd-relative path. Prove the
  // override actually takes effect (mirrors the publish-side "--repo-root points key
  // resolution somewhere else" test in otaPublishReleaseRace.test.ts) rather than being
  // silently ignored in favor of import.meta.url's own guess.
  it('--repo-root writes the key under THAT root, not the script\'s own default root', () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-keygen-other-root-'));
    try {
      const { status } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['--repo-root', otherRoot]);
      expect(status).toBe(0);
      expect(fs.existsSync(path.join(otherRoot, 'build', 'ota-keys', 'default.json'))).toBe(true);
      // If --repo-root were silently ignored, the key would land at the script's own default
      // root (the scratch repo it actually lives in) instead.
      expect(fs.existsSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'))).toBe(false);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('a bare trailing --repo-root fails with a message, not a TypeError stack', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['--repo-root']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/--repo-root requires a directory argument/);
    expect(stderr).not.toMatch(/TypeError/);
    // And it wrote nothing anywhere: a flag that decides WHERE the private key lands must not
    // fall back to the default root when its own value is missing.
    expect(fs.existsSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'))).toBe(false);
  });

  it('a positional name plus --repo-root still names the file <name>.json (backward-compatible parsing)', () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-keygen-other-root-named-'));
    try {
      const { status } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['prod', '--repo-root', otherRoot]);
      expect(status).toBe(0);
      expect(fs.existsSync(path.join(otherRoot, 'build', 'ota-keys', 'prod.json'))).toBe(true);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe('ota-embed-manifest.mjs', () => {
  let repoRoot: string;
  let distDir: string;
  let projectDir: string;
  beforeEach(() => {
    repoRoot = makeScratchRepo();
    distDir = path.join(repoRoot, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1);');
    // #582's sibling guard: `--project <dir>` is required and its `ota.bundleName` must match
    // `--name`. `distDir` lives at `<repoRoot>/dist`, so a `--project <repoRoot>` keeps it
    // INSIDE the project for the happy-path cases below. `enabled: true` is here for #649's
    // separate gate — tests below that are about a DIFFERENT guard shouldn't also have to
    // think about the enabled check; the tests that ARE about #649 override this explicitly.
    projectDir = repoRoot;
    fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ ota: { enabled: true, bundleName: 'shell' } }));
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  it('writes ota-embedded-manifest.json into dist/ with the fixed "embedded" version sentinel', () => {
    const { status } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1', '--project', projectDir]);
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
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1', '--project', projectDir]);
    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'ota-embedded-manifest.json'), 'utf8'));
    expect(manifest.files['ota-embedded-manifest.json']).toBeUndefined();
  });

  it('rejects a non-positive-integer --engine-api', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '0', '--project', projectDir]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/--engine-api/);
  });

  it('rejects a missing --dist directory', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', path.join(repoRoot, 'nope'), '--name', 'shell', '--engine-api', '1', '--project', projectDir]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/dist dir not found/);
  });

  it('#582: rejects a missing --project', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1']);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/--project is required/);
  });

  it('#582: rejects --name not matching the project\'s resolved bundleName', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'other', '--engine-api', '1', '--project', projectDir]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/does not match/);
  });

  it('#582: rejects a --dist outside --project', () => {
    const outsideDist = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-embed-outside-dist-'));
    try {
      fs.writeFileSync(path.join(outsideDist, 'index.html'), '<html></html>');
      const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
        ['--dist', outsideDist, '--name', 'shell', '--engine-api', '1', '--project', projectDir]);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/is not inside --project/);
    } finally {
      fs.rmSync(outsideDist, { recursive: true, force: true });
    }
  });

  it('#582: an absent ota.bundleName resolves to the default ("shell") and succeeds under --name shell', () => {
    // `enabled: true` explicit here (unlike the bare `{}` this test used pre-#649) — this
    // test is about bundleName defaulting specifically, not about the enabled gate, which is
    // covered on its own below.
    fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ ota: { enabled: true } }));
    const { status } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1', '--project', projectDir]);
    expect(status).toBe(0);
  });

  it('#649: rejects a project whose ota.enabled is explicitly false', () => {
    fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ ota: { enabled: false, bundleName: 'shell' } }));
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1', '--project', projectDir]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/ota\.enabled is not true/);
    expect(fs.existsSync(path.join(distDir, 'ota-embedded-manifest.json'))).toBe(false);
  });

  it('#649: rejects a project whose ota.enabled is ABSENT (defaults to false, not "unguarded")', () => {
    fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ ota: { bundleName: 'shell' } }));
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1', '--project', projectDir]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/ota\.enabled is not true/);
    expect(fs.existsSync(path.join(distDir, 'ota-embedded-manifest.json'))).toBe(false);
  });

  it('#649: succeeds and embeds a manifest when ota.enabled is true', () => {
    fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ ota: { enabled: true, bundleName: 'shell' } }));
    const { status } = runNode(repoRoot, 'engine/scripts/ota-embed-manifest.mjs',
      ['--dist', distDir, '--name', 'shell', '--engine-api', '1', '--project', projectDir]);
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(distDir, 'ota-embedded-manifest.json'))).toBe(true);
  });
});
