/** engine/scripts/ota-keygen.mjs and engine/scripts/ota-embed-manifest.mjs — two OTA CLI
 *  scripts that had ZERO test coverage (ota-publish.mjs's release.json retry logic is
 *  covered separately in otaPublishReleaseRace.test.ts, via a fake `gcloud` on PATH — it
 *  shells out to the real CLI, so a plain subprocess test here couldn't exercise it
 *  without touching a real bucket). Both scripts below have no exported functions to unit
 *  test, so this runs them as real subprocesses against a scratch repo layout — the same
 *  integration-test posture as modelPipeline.integration.test.ts's CLI shellouts. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { generateKeypair } from '../../scripts/ota/signing.mjs';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Both scripts resolve paths relative to a repo root two levels up from
 *  engine/scripts/<script>.mjs — build a scratch "repo" with that same shape so we don't
 *  touch the real repo's build/ota-keys/ (which may hold a real, precious private key). */
function makeScratchRepo(): string {
  const repoRoot = makeScratchDir('modoki-ota-cli-test-');
  fs.mkdirSync(path.join(repoRoot, 'engine', 'scripts'), { recursive: true });
  // Mirror engine/scripts/ota-*.mjs + ota/ so the scripts' relative imports resolve.
  fs.cpSync(path.join(engineRoot, 'scripts', 'ota-keygen.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-keygen.mjs'));
  fs.cpSync(path.join(engineRoot, 'scripts', 'ota-embed-manifest.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-embed-manifest.mjs'));
  fs.cpSync(path.join(engineRoot, 'scripts', 'ota'), path.join(repoRoot, 'engine', 'scripts', 'ota'), { recursive: true });
  // ota-embed-manifest takes the project's build claim (#1160), through this import chain.
  for (const dep of ['cliBuildClaim.mjs', 'buildClaimsStore.mjs', 'deviceClaimsStore.mjs', 'pathIdentity.mjs', 'jsonFile.mjs']) {
    fs.cpSync(path.join(engineRoot, 'scripts', dep), path.join(repoRoot, 'engine', 'scripts', dep));
  }
  return repoRoot;
}

function runNode(repoRoot: string, scriptRelPath: string, args: string[], nodeArgs: string[] = [], env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [...nodeArgs, scriptRelPath, ...args], { cwd: repoRoot, encoding: 'utf8', ...(env ? { env } : {}) });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('ota-keygen.mjs', () => {
  // The key is the PROJECT's (#1983): `<project>/build/ota-keys/<name>.json`. The scratch repo stands in
  // for the editor root, where earlier editors wrote keys.
  let repoRoot: string;
  let projectDir: string;
  const keyAt = (root: string, name = 'default') => path.join(root, 'build', 'ota-keys', `${name}.json`);
  const keygen = (args: string[]) => runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', [...args, '--project', projectDir]);
  const plantKey = (root: string, keypair: { publicKey: string; privateKey: string }, name = 'default') => {
    fs.mkdirSync(path.dirname(keyAt(root, name)), { recursive: true });
    fs.writeFileSync(keyAt(root, name), JSON.stringify(keypair, null, 2) + '\n', { mode: 0o600 });
    return fs.readFileSync(keyAt(root, name));
  };
  const bake = (publicKey: string) => fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ ota: { enabled: true, publicKey } }));
  beforeEach(() => {
    repoRoot = makeScratchRepo();
    projectDir = path.join(repoRoot, 'games', 'p');
    fs.mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  it('writes the PROJECT\'s build/ota-keys/default.json and prints the public key on first run', () => {
    const { status, stdout } = keygen([]);
    expect(status).toBe(0);
    expect(fs.existsSync(keyAt(projectDir))).toBe(true);
    expect(fs.existsSync(keyAt(repoRoot))).toBe(false); // never the editor root any more
    const keypair = JSON.parse(fs.readFileSync(keyAt(projectDir), 'utf8'));
    expect(typeof keypair.publicKey).toBe('string');
    expect(typeof keypair.privateKey).toBe('string');
    expect(stdout).toContain(keypair.publicKey);
  });

  // The same guarantee — "only this account can read the private key" — is enforced by a
  // different mechanism per platform, so it takes one test each. POSIX gets mode 0600;
  // Windows has no POSIX bits (Node's `mode` only toggles read-only there, so the file
  // would land 0o666) and gets an icacls ACL instead.
  it.skipIf(process.platform === 'win32')('writes a private key file that is not world/group readable', () => {
    keygen([]);
    const keyPath = keyAt(projectDir);
    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.runIf(process.platform === 'win32')('restricts the private key to the current account (Windows ACL)', () => {
    const { status } = keygen([]);
    expect(status).toBe(0); // a failed ACL is a hard error — keygen deletes the key and exits 1
    const keyPath = keyAt(projectDir);
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
    // What must be gone are the broad grants. At a real key location (a project's `build/`) the
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

    // The broad grants must be absent. At a REAL key location (a project's `build/`) the
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

  it('the minted key\'s folder ignores itself, in a git project with no ignore rules of its own (#1983)', () => {
    expect(execFileSync('git', ['init', '-q'], { cwd: projectDir, encoding: 'utf8' })).toBe('');
    expect(keygen([]).status).toBe(0);
    expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(false);
    // `check-ignore` exits 0 when ignored, 1 when not (execFileSync throws on 1).
    execFileSync('git', ['check-ignore', '-q', path.join('build', 'ota-keys', 'default.json')], { cwd: projectDir });
  });

  it('honors a custom key name, writing to <name>.json', () => {
    const { status } = keygen(['prod']);
    expect(status).toBe(0);
    expect(fs.existsSync(keyAt(projectDir, 'prod'))).toBe(true);
    expect(fs.existsSync(keyAt(projectDir))).toBe(false);
  });

  it('REFUSES to overwrite an existing key (regenerating would orphan every shipped build)', () => {
    const first = keygen([]);
    expect(first.status).toBe(0); // the accept side: no key yet, so one is minted
    const originalKeypair = fs.readFileSync(keyAt(projectDir), 'utf8');

    const second = keygen([]);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already exists — refusing to overwrite/);
    // The original key must be byte-for-byte untouched by the refused attempt.
    expect(fs.readFileSync(keyAt(projectDir), 'utf8')).toBe(originalKeypair);
  });

  it('two independently generated keys never collide', () => {
    keygen(['a']);
    keygen(['b']);
    const a = JSON.parse(fs.readFileSync(keyAt(projectDir, 'a'), 'utf8'));
    const b = JSON.parse(fs.readFileSync(keyAt(projectDir, 'b'), 'utf8'));
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('--project is required, and without it nothing is written anywhere', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', []);
    expect(status).toBe(1);
    expect(stderr).toMatch(/--project <dir> is required/);
    expect(fs.existsSync(path.join(repoRoot, 'build'))).toBe(false);
  });

  it('a bare trailing --project fails with a message, not a TypeError stack', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['--project']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/--project requires a directory argument/);
    expect(stderr).not.toMatch(/TypeError/);
    expect(fs.existsSync(path.join(repoRoot, 'build'))).toBe(false);
  });

  it('the old --repo-root is refused with the reason, not read as a key name', () => {
    const { status, stderr } = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['--repo-root', repoRoot]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/--repo-root is gone.*--project/);
    expect(fs.existsSync(path.join(repoRoot, 'build'))).toBe(false);
  });

  describe('a key an earlier editor wrote outside the project (#1983)', () => {
    const LEGACY = generateKeypair();

    // The scratch repo is both the script's default editor root and the project's ancestor; the
    // ancestor walk on its own is pinned by otaKeyRoutes.test.ts.
    it('the shared default at the repo root is COPIED in, never minted over, and the original stays', () => {
      const original = plantKey(repoRoot, LEGACY);
      bake(LEGACY.publicKey);
      const r = keygen([]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/copied from .*Not minting a new one/);
      expect(fs.readFileSync(keyAt(projectDir)).equals(original)).toBe(true); // byte-identical
      expect(fs.readFileSync(keyAt(repoRoot)).equals(original)).toBe(true); // left in place
    });

    it('an --editor-root key (the packaged bundle\'s) is found too', () => {
      const bundle = makeScratchDir('modoki-ota-keygen-bundle-');
      try {
        const original = plantKey(bundle, LEGACY, 'prod');
        bake(LEGACY.publicKey);
        const r = keygen(['prod', '--editor-root', bundle]);
        expect(r.status).toBe(1);
        expect(fs.readFileSync(keyAt(projectDir, 'prod')).equals(original)).toBe(true);
        expect(fs.readFileSync(keyAt(bundle, 'prod')).equals(original)).toBe(true);
      } finally {
        fs.rmSync(bundle, { recursive: true, force: true });
      }
    });

    it('an UNREADABLE project.config.json is not "no public key": keygen refuses, mints nothing, copies nothing', () => {
      const original = plantKey(repoRoot, LEGACY);
      fs.writeFileSync(path.join(projectDir, 'project.config.json'), '<<<<<<< HEAD\n{ "ota": {} }\n');
      const r = keygen([]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/could not be read .*Fix it first; nothing was minted/);
      expect(fs.existsSync(keyAt(projectDir))).toBe(false);
      expect(fs.readFileSync(keyAt(repoRoot)).equals(original)).toBe(true);
    });

    it('an unreadable config refuses even with NO earlier key: a new public half could not be written into it', () => {
      fs.writeFileSync(path.join(projectDir, 'project.config.json'), '{ nope');
      const r = keygen([]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/could not be read/);
      expect(fs.existsSync(keyAt(projectDir))).toBe(false);
    });

    it('NO project.config.json at all is "no public key", not "unknown": the shared key is passed over and a key minted', () => {
      const original = plantKey(repoRoot, LEGACY);
      const r = keygen([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/not copying .*bakes no ota.publicKey yet/);
      expect(fs.readFileSync(keyAt(repoRoot)).equals(original)).toBe(true);
    });

    it('a project that bakes no ota.publicKey yet does not adopt the shared key: it mints its own', () => {
      const original = plantKey(repoRoot, LEGACY);
      bake('');
      const r = keygen([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/not copying .*bakes no ota.publicKey yet/);
      expect(JSON.parse(fs.readFileSync(keyAt(projectDir), 'utf8')).publicKey).not.toBe(LEGACY.publicKey);
      expect(fs.readFileSync(keyAt(repoRoot)).equals(original)).toBe(true);
    });

    it('a same-named key whose public half is NOT the project\'s is left alone — and nothing is minted past the shipped key (#1993)', () => {
      const original = plantKey(repoRoot, LEGACY);
      bake(generateKeypair().publicKey);
      const r = keygen([]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/passed over .*is not this project's ota.publicKey/);
      expect(fs.existsSync(keyAt(projectDir))).toBe(false);
      expect(fs.readFileSync(keyAt(repoRoot)).equals(original)).toBe(true);
    });
  });

  describe('a project that bakes an ota.publicKey it does not hold the key for (#1993)', () => {
    const SHIPPED = generateKeypair();

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an UNREADABLE earlier key is not "no key": keygen mints no blocker, and copies the key in once it can read it', () => {
      const original = plantKey(repoRoot, SHIPPED);
      fs.chmodSync(keyAt(repoRoot), 0o000);
      bake(SHIPPED.publicKey);
      try {
        const r = keygen([]);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/is baked into every build it shipped[^]*is its pair/);
        expect(r.stderr).toMatch(/passed over .*default\.json: not a readable keypair/);
        expect(fs.existsSync(keyAt(projectDir))).toBe(false);
      } finally {
        fs.chmodSync(keyAt(repoRoot), 0o600);
      }
      // Readable again: the real key comes in — it used to be blocked for good by the minted one.
      const again = keygen([]);
      expect(again.stderr).toMatch(/copied from .*Not minting a new one/);
      expect(fs.readFileSync(keyAt(projectDir)).equals(original)).toBe(true);
    });

    it('a second machine (the key is nowhere here) refuses, and --rotate is the one deliberate way to mint', () => {
      bake(SHIPPED.publicKey);
      const r = keygen([]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Copy the original key in from your backup/);
      expect(r.stderr).toMatch(/--rotate/);
      expect(fs.existsSync(keyAt(projectDir))).toBe(false);
      const rotated = keygen(['--rotate']);
      expect(rotated.status, rotated.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(keyAt(projectDir), 'utf8')).publicKey).not.toBe(SHIPPED.publicKey);
    });

    it('a name after `--` is a name, never a flag: `-- --rotate` is refused, not read as --rotate (#1993 review)', () => {
      bake(SHIPPED.publicKey);
      const r = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['--project', projectDir, '--', '--rotate']);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/key name must be ONE name/);
      expect(fs.existsSync(path.join(projectDir, 'build', 'ota-keys'))).toBe(false);
    });

    it('a project that HOLDS its shipped key may still mint a second identity under another name', () => {
      plantKey(projectDir, SHIPPED);
      bake(SHIPPED.publicKey);
      const r = keygen(['release']);
      expect(r.status, r.stderr).toBe(0);
      expect(fs.existsSync(keyAt(projectDir, 'release'))).toBe(true);
    });

    it('holding a file that only CLAIMS the shipped public half is not holding the key', () => {
      plantKey(projectDir, { publicKey: SHIPPED.publicKey, privateKey: generateKeypair().privateKey });
      bake(SHIPPED.publicKey);
      const r = keygen(['release']);
      expect(r.status).toBe(1);
      expect(fs.existsSync(keyAt(projectDir, 'release'))).toBe(false);
    });
  });

  it('a keygen that loses the race to another one never replaces the winner\'s key (flag wx, #1993)', () => {
    // A preloaded hook stands in for the second keygen: it writes the key file in the window between
    // keygen's existsSync refusal and its own write — the only window `wx` guards.
    const hook = path.join(repoRoot, 'rival-hook.mjs');
    fs.writeFileSync(hook, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const real = fs.writeFileSync;',
      'fs.writeFileSync = function (file, ...rest) {',
      "  if (file === process.env.RIVAL_AT && !fs.existsSync(file)) real.call(fs, file, 'the rival keygen\\'s key');",
      '  return real.call(this, file, ...rest);',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'));
    const r = runNode(repoRoot, 'engine/scripts/ota-keygen.mjs', ['--project', projectDir], ['--import', pathToFileURL(hook).href], { ...process.env, RIVAL_AT: keyAt(projectDir) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/appeared while this key was being made .*refusing to overwrite/);
    expect(fs.readFileSync(keyAt(projectDir), 'utf8')).toBe('the rival keygen\'s key');
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
    const outsideDist = makeScratchDir('modoki-ota-embed-outside-dist-');
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
