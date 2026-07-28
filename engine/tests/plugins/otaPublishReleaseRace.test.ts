/** ota-publish.mjs's release.json optimistic-concurrency retry loop (added 2026-07-26 after
 *  a code review found the original read-merge-write had no guard: two publishes racing for
 *  DIFFERENT bundle names could silently drop one's just-published entry).
 *
 *  Manually verified once against the REAL `gs://modoki-www-site` bucket (confirmed
 *  `gcloud storage cp --if-generation-match` fails with `GcsPreconditionFailedError` on a
 *  stale generation — exactly the string the retry loop matches). This test exercises the
 *  actual retry CONTROL FLOW deterministically, without touching real GCS: a fake `gcloud`
 *  executable on PATH emulates a GCS bucket on local disk and injects exactly one
 *  concurrent-write race on the first release.json upload attempt. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FAKE_GCLOUD_SRC = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const BUCKET_DIR = process.env.FAKE_GCS_BUCKET_DIR;
const RACE_FLAG_PATH = process.env.FAKE_GCS_RACE_FLAG; // present + unconsumed = "inject one race"

function toLocal(gcsUrl) {
  return path.join(BUCKET_DIR, gcsUrl.replace(/^gs:\\/\\//, ''));
}
function genPath(localPath) {
  return localPath + '.generation';
}
function readGeneration(localPath) {
  const g = genPath(localPath);
  return fs.existsSync(g) ? fs.readFileSync(g, 'utf8').trim() : '0';
}
function bumpGeneration(localPath) {
  const current = fs.existsSync(genPath(localPath)) ? Number(readGeneration(localPath)) : 0;
  fs.writeFileSync(genPath(localPath), String(current + 1));
}

const argv = process.argv.slice(2);
const [group, cmd, ...rest] = argv;

if (group === 'storage' && cmd === 'objects' && rest[0] === 'describe') {
  const localPath = toLocal(rest[1]);
  const formatArg = rest.find((a) => a.startsWith('--format='));
  if (!fs.existsSync(localPath)) { process.stderr.write('ERROR: not found: 404.\\n'); process.exit(1); }
  if (formatArg && formatArg.includes('value(generation)')) {
    process.stdout.write(readGeneration(localPath) + '\\n');
    process.exit(0);
  }
  process.exit(0);
}

if (group === 'storage' && cmd === 'objects' && rest[0] === 'update') {
  process.exit(0); // cache-control update — no-op in the fake
}

if (group === 'storage' && cmd === 'cat') {
  const localPath = toLocal(rest[0]);
  if (!fs.existsSync(localPath)) { process.stderr.write('ERROR: (gcloud.storage.cat) not found: 404.\\n'); process.exit(1); }
  process.stdout.write(fs.readFileSync(localPath));
  process.exit(0);
}

if (group === 'storage' && cmd === 'rsync') {
  const src = rest[rest.length - 2];
  const dst = toLocal(rest[rest.length - 1]);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  process.exit(0);
}

if (group === 'storage' && cmd === 'cp') {
  const src = rest[0];
  const dstUrl = rest[1];
  const localDst = toLocal(dstUrl);
  const genArg = rest.find((a) => a.startsWith('--if-generation-match='));

  if (genArg) {
    const expected = genArg.slice('--if-generation-match='.length);
    // Inject exactly one race: right before honoring the caller's precondition, pretend a
    // concurrent writer just landed a change — bump the generation out from under them.
    if (RACE_FLAG_PATH && fs.existsSync(RACE_FLAG_PATH)) {
      fs.unlinkSync(RACE_FLAG_PATH); // consume — only once
      fs.mkdirSync(path.dirname(localDst), { recursive: true });
      fs.writeFileSync(localDst, fs.existsSync(localDst) ? fs.readFileSync(localDst) : '{}');
      bumpGeneration(localDst);
    }
    const actual = readGeneration(localDst);
    if (actual !== expected) {
      process.stderr.write("ERROR: Task '" + dstUrl + "#0' failed: GcsPreconditionFailedError('')\\n");
      process.exit(1);
    }
  }

  fs.mkdirSync(path.dirname(localDst), { recursive: true });
  fs.copyFileSync(src, localDst);
  bumpGeneration(localDst);
  process.exit(0);
}

process.stderr.write('fake gcloud: unhandled command ' + argv.join(' ') + '\\n');
process.exit(1);
`;

function runNode(cwd: string, env: NodeJS.ProcessEnv, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', args, { cwd, env, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('ota-publish.mjs release.json optimistic concurrency', () => {
  let repoRoot: string;
  let binDir: string;
  let bucketDir: string;
  let distDir: string;
  let raceFlag: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-race-repo-'));
    fs.mkdirSync(path.join(repoRoot, 'engine', 'scripts'), { recursive: true });
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota-publish.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-publish.mjs'));
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota-keygen.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-keygen.mjs'));
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota'), path.join(repoRoot, 'engine', 'scripts', 'ota'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'build', 'ota-keys'), { recursive: true });

    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-gcloud-'));
    // The fake `gcloud` must be executable by NAME off PATH on both platforms.
    // POSIX: an extensionless shebang script chmod +x. Windows: cmd.exe cannot run a
    // shebang script and ignores the +x bit entirely, and only resolves names carrying
    // a PATHEXT extension — so ship the body as .cjs plus a .cmd shim that invokes node.
    if (process.platform === 'win32') {
      // .cjs, not .mjs — FAKE_GCLOUD_SRC is CommonJS (it uses require()).
      fs.writeFileSync(path.join(binDir, 'gcloud.cjs'), FAKE_GCLOUD_SRC);
      fs.writeFileSync(path.join(binDir, 'gcloud.cmd'), `@node "%~dp0gcloud.cjs" %*\r\n`);
    } else {
      const gcloudPath = path.join(binDir, 'gcloud');
      fs.writeFileSync(gcloudPath, FAKE_GCLOUD_SRC);
      fs.chmodSync(gcloudPath, 0o755);
    }

    bucketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-bucket-'));
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-race-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html>race-test</html>');
    raceFlag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-race-flag-')), 'race');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(bucketDir, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  function publish(name: string, version: string, envOverrides: NodeJS.ProcessEnv = {}, extraArgs: string[] = []) {
    return runNode(repoRoot, {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GCS_BUCKET_DIR: bucketDir,
      FAKE_GCS_RACE_FLAG: raceFlag,
      ...envOverrides,
    }, [
      'engine/scripts/ota-publish.mjs',
      '--dist', distDir, '--bucket', 'gs://fakebucket/testprefix',
      '--name', name, '--version', version, '--engine-api', '1', '--key', 'default',
      ...extraArgs,
    ]);
  }

  /** Writes a real Ed25519 keypair (via the actual signing.mjs, not a fake) straight to
   *  `<root>/build/ota-keys/<name>.json` — used instead of running ota-keygen.mjs when the
   *  target root isn't where ota-keygen.mjs itself lives (it derives ITS OWN repoRoot from
   *  import.meta.url too, so running it with a different cwd doesn't relocate its output). */
  function writeKeyPair(root: string, name = 'default') {
    const keyDir = path.join(root, 'build', 'ota-keys');
    fs.mkdirSync(keyDir, { recursive: true });
    const signingPath = path.join(repoRoot, 'engine', 'scripts', 'ota', 'signing.mjs');
    // MUST be a file:// URL, not the raw fs path. On Windows an absolute path like
    // `E:\…\signing.mjs` is not a valid ESM specifier — Node reads the drive letter as a
    // URL scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME — and its backslashes would
    // additionally be mangled as escape sequences inside the generated source string.
    const signingUrl = pathToFileURL(signingPath).href;
    const out = execFileSync('node', ['--input-type=module', '-e',
      `import { generateKeypair } from ${JSON.stringify(signingUrl)}; process.stdout.write(JSON.stringify(generateKeypair()));`,
    ], { encoding: 'utf8' });
    fs.writeFileSync(path.join(keyDir, `${name}.json`), out);
  }

  it('retries once and merges correctly when a concurrent writer races the first upload attempt', () => {
    // Seed a real key via the actual ota-keygen.mjs (it's cheap and exercises real code).
    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });

    // First publish: creates release.json fresh (no race — flag absent).
    const first = publish('shell', 'v1');
    expect(first.status).toBe(0);

    // Arm exactly one race for the SECOND publish's first release.json cp attempt.
    fs.writeFileSync(raceFlag, '');
    const second = publish('sling', 'v1');

    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/release\.json changed concurrently \(attempt 1\/5\)/);

    const releaseJson = JSON.parse(fs.readFileSync(path.join(bucketDir, 'fakebucket', 'testprefix', 'release.json'), 'utf8'));
    // Both bundles present — the retry re-read the LATEST release.json (with "shell"
    // already in it) rather than clobbering it with a stale pre-race copy.
    expect(releaseJson.bundles).toEqual({ shell: 'v1', sling: 'v1' });
  });

  it('publishes cleanly with no retry when nothing races it', () => {
    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });

    const result = publish('shell', 'v1');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/changed concurrently/);
    const releaseJson = JSON.parse(fs.readFileSync(path.join(bucketDir, 'fakebucket', 'testprefix', 'release.json'), 'utf8'));
    expect(releaseJson.bundles).toEqual({ shell: 'v1' });
  });

  it('--repo-root points key resolution somewhere else, and a key ONLY at the default location is not found', () => {
    // A key generated at the script's own default repoRoot must NOT be visible when an
    // explicit --repo-root points elsewhere — proving the override actually takes effect
    // rather than being silently ignored in favor of import.meta.url's own guess.
    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-other-root-'));
    try {
      // If --repo-root were silently ignored, the key generated above (at the script's
      // own default repoRoot) would be found and this would succeed instead.
      const result = publish('shell', 'v1', {}, ['--repo-root', otherRoot]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Signing key not found/);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('--repo-root points key resolution somewhere else, and a key THERE is found and used', () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-other-root-with-key-'));
    try {
      writeKeyPair(otherRoot);
      const result = publish('shell', 'v1', {}, ['--repo-root', otherRoot]);
      expect(result.status).toBe(0);
      const releaseJson = JSON.parse(fs.readFileSync(path.join(bucketDir, 'fakebucket', 'testprefix', 'release.json'), 'utf8'));
      expect(releaseJson.bundles).toEqual({ shell: 'v1' });
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
