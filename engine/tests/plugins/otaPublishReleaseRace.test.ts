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
import { execFileSync, spawnSync } from 'child_process';
import { mergeProjectConfig, pruneProjectConfig, DEFAULT_PROJECT_CONFIG, type RawProjectConfig } from '../../project-config';

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
  const gcsUrl = rest[0];
  const localPath = toLocal(gcsUrl);
  // FAKE_GCS_MANIFEST_CAT_UNAUTHORIZED: force a non-404 failure specifically for a
  // VERSIONED bundle manifest.json cat (release.json's own cat, matched separately below
  // via FAKE_GCS_CAT_FAIL, is untouched by this flag) — used to test the version-collision
  // guard's fail-loud branch: "could not check" must NOT be silently treated as "no
  // collision" the way a genuine 404 is.
  if (process.env.FAKE_GCS_MANIFEST_CAT_UNAUTHORIZED && /\\/bundles\\/.+\\/.+\\/manifest\\.json$/.test(gcsUrl)) {
    process.stderr.write('ERROR: (gcloud.storage.cat) HTTPError 401: Unauthorized.\\n');
    process.exit(1);
  }
  if (!fs.existsSync(localPath)) { process.stderr.write('ERROR: (gcloud.storage.cat) not found: 404.\\n'); process.exit(1); }
  // FAKE_GCS_CAT_FAIL: simulate describe succeeding (the object exists) but the
  // subsequent cat failing/erroring — used to test that this is NOT treated as
  // "no existing release".
  if (process.env.FAKE_GCS_CAT_FAIL) { process.stderr.write('ERROR: (gcloud.storage.cat) simulated transient failure.\\n'); process.exit(1); }
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

/** Reads the public half of a keypair written by ota-keygen.mjs (or writeKeyPair below). */
function readKeyPublicKey(rootDir: string, name = 'default'): string {
  return (JSON.parse(fs.readFileSync(path.join(rootDir, 'build', 'ota-keys', `${name}.json`), 'utf8')) as { publicKey: string }).publicKey;
}

/** Writes a scratch project.config.json with just an `ota` block — everything these tests'
 *  guards read. `projectDir` is an ABSOLUTE path (never relative to a `--repo-root` a test
 *  might override), so a test that changes `--repo-root` doesn't accidentally relocate where
 *  the project config is looked for. */
function writeProjectConfig(projectDir: string, ota: { enabled?: boolean; baseUrl?: string; publicKey?: string; bundleName: string; engineApi?: number }): string {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({
    ota: { enabled: true, baseUrl: '', engineApi: 1, ...ota },
  }));
  return projectDir;
}

function runNode(cwd: string, env: NodeJS.ProcessEnv, args: string[]): { status: number; stdout: string; stderr: string } {
  // spawnSync, not execFileSync — execFileSync throws (and its catch-block-only branch
  // above USED to discard stderr on every SUCCESSFUL run, returning '' regardless of what
  // the child actually wrote there). Several assertions below need to read `console.warn`
  // output (which goes to stderr) from a run that exits 0, so stderr must be captured on
  // BOTH the success and failure path — spawnSync always returns both.
  const result = spawnSync('node', args, { cwd, env, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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

  // `--project` defaults to a scratch project KEYED BY NAME (`games/testproj-<name>`), whose
  // `ota.bundleName` is written to equal that same `name` and whose `ota.publicKey` is the
  // just-generated signing key's public half — so every EXISTING call in this file (which
  // uses "shell"/"sling" as two arbitrary bundle names to exercise release.json merge
  // mechanics, not real sub-game semantics) keeps satisfying #582's new identity guards
  // automatically, with no per-test config to hand-maintain. Pass `projectOverride: null` to
  // omit --project entirely, or a path/ota-block to test the guards themselves.
  function publish(
    name: string, version: string, envOverrides: NodeJS.ProcessEnv = {}, extraArgs: string[] = [],
    projectOverride?: string | null,
  ) {
    let projectArgs: string[] = [];
    if (projectOverride !== null) {
      const projectDir = projectOverride ?? path.join(repoRoot, 'games', `testproj-${name}`);
      if (!fs.existsSync(path.join(projectDir, 'project.config.json'))) {
        // The signing key this call will actually resolve lives under whichever repo root the
        // script ends up using — the test's own `repoRoot` by default, or an overridden
        // `--repo-root` in extraArgs (several tests here point key resolution elsewhere). If
        // no key exists there yet (a test deliberately pointing --repo-root somewhere with NO
        // key), the script's own key-existence check fails before ever consulting this
        // project's publicKey — so a placeholder is fine in that case.
        const repoRootFlagIdx = extraArgs.indexOf('--repo-root');
        const effectiveKeyRoot = repoRootFlagIdx >= 0 ? extraArgs[repoRootFlagIdx + 1] : repoRoot;
        let publicKey = 'placeholder-no-key-at-effective-root';
        try { publicKey = readKeyPublicKey(effectiveKeyRoot); } catch { /* see comment above */ }
        writeProjectConfig(projectDir, { bundleName: name, publicKey });
      }
      projectArgs = ['--project', projectDir];
    }
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
      ...projectArgs,
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

  it('a describe that succeeds but a cat that fails is a hard error, not "no existing release" (F1)', () => {
    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });

    // First publish creates a real release.json with "shell" in it.
    const first = publish('shell', 'v1');
    expect(first.status).toBe(0);
    const releaseJsonPath = path.join(bucketDir, 'fakebucket', 'testprefix', 'release.json');
    const before = fs.readFileSync(releaseJsonPath, 'utf8');

    // Second publish: describe will succeed (release.json exists) but cat is forced to
    // fail — this must NOT be treated as "no existing release" (which would silently
    // drop the "shell" bundle entry and overwrite release.json with only "sling").
    const second = publish('sling', 'v1', { FAKE_GCS_CAT_FAIL: '1' });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/could not be read|could not be parsed|exists.*could not be read/i);

    // release.json must be untouched.
    const after = fs.readFileSync(releaseJsonPath, 'utf8');
    expect(after).toBe(before);
  });

  it.each([
    ['null', 'null'],
    ['an empty object with no bundles field', '{}'],
    ['an array', '[]'],
  ])('a release.json body that is %s is a hard error, not "no bundles yet" (F4)', (_label, malformedBody) => {
    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });

    // Plant a malformed release.json directly in the fake bucket — describe() will report
    // it exists (generation '0', the fake's default), and cat() will return this body,
    // which parses successfully but has the wrong SHAPE. Without the F4 shape check this
    // would be silently treated as "no bundles yet" and overwritten with a release
    // containing ONLY the bundle this publish is about to stage.
    const releaseDir = path.join(bucketDir, 'fakebucket', 'testprefix');
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, 'release.json'), malformedBody);
    const before = fs.readFileSync(path.join(releaseDir, 'release.json'), 'utf8');

    const result = publish('sling', 'v1');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/malformed/i);

    // release.json must be untouched — the publish aborted rather than overwriting it.
    const after = fs.readFileSync(path.join(releaseDir, 'release.json'), 'utf8');
    expect(after).toBe(before);
  });

  it('#570: preserves another bundle\'s manifests entry across a publish of a different bundle', () => {
    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });

    const first = publish('shell', 'v1');
    expect(first.status).toBe(0);
    const afterFirst = JSON.parse(fs.readFileSync(path.join(bucketDir, 'fakebucket', 'testprefix', 'release.json'), 'utf8'));
    expect(afterFirst.manifests.shell).toMatch(/^[0-9a-f]{64}$/);
    const shellHash = afterFirst.manifests.shell;

    // Publishing a DIFFERENT bundle must not touch "shell"'s already-published entry —
    // the load-bearing merge this test guards against regressing.
    const second = publish('sling', 'v1');
    expect(second.status).toBe(0);
    const afterSecond = JSON.parse(fs.readFileSync(path.join(bucketDir, 'fakebucket', 'testprefix', 'release.json'), 'utf8'));
    expect(afterSecond.manifests.shell).toBe(shellHash);
    expect(afterSecond.manifests.sling).toMatch(/^[0-9a-f]{64}$/);
    expect(afterSecond.bundles).toEqual({ shell: 'v1', sling: 'v1' });
  });

  it('#570: prunes a manifests entry whose bundle is no longer in release.bundles (merge/prune mechanics only, fake hash)', () => {
    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });

    // Seed a release.json directly (simulating a bundle that was removed from `bundles`
    // by some other means, leaving a stale "ghost" entry in `manifests`) — `bundles` has
    // only "shell", but `manifests` also carries an untracked "ghost" key.
    //
    // `manifests.shell` below is `'a'.repeat(64)` — a FAKE hash, deliberately not the real
    // sha256 of any manifest.json. That is standing in ONLY to exercise the merge/prune
    // MECHANICS this test is about (does a publish of a different bundle preserve "shell"'s
    // entry while dropping "ghost"'s) — it is NOT an endorsement of a mismatched/stale
    // manifest hash as a legitimate bucket state. A real bucket with `bundles.shell = 'v1'`
    // and a `manifests.shell` that doesn't hash-match the ACTUAL v1 manifest.json is exactly
    // the poisoned state the version-collision guard in ota-publish.mjs exists to prevent —
    // every client on that bundle version would get `manifest-untrusted` permanently. This
    // test seeds release.json directly, bypassing that guard, purely to isolate the
    // merge/prune logic from real hashing and uploads.
    const releaseDir = path.join(bucketDir, 'fakebucket', 'testprefix');
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, 'release.json'), JSON.stringify({
      schema: 1,
      bundles: { shell: 'v1' },
      mandatory: false,
      minEngineApi: 1,
      manifests: { shell: 'a'.repeat(64), ghost: 'b'.repeat(64) },
      sig: 'not-checked-by-this-fake', // this publish re-signs; the stale sig is never read back as valid
    }));

    const result = publish('sling', 'v1');
    expect(result.status).toBe(0);

    const release = JSON.parse(fs.readFileSync(path.join(releaseDir, 'release.json'), 'utf8'));
    expect(release.bundles).toEqual({ shell: 'v1', sling: 'v1' });
    expect(release.manifests.ghost).toBeUndefined();
    expect(Object.keys(release.manifests).sort()).toEqual(['shell', 'sling']);
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

/** `mandatory` is STICKY across publishes (#564) — a routine publish with neither
 *  --mandatory nor --no-mandatory must INHERIT the live release's mandatory value, not
 *  silently clear it. Reuses the same fake-gcloud harness as the race-condition suite
 *  above (FAKE_GCLOUD_SRC + runNode are module-scoped there). */
describe('ota-publish.mjs mandatory stickiness', () => {
  let repoRoot: string;
  let binDir: string;
  let bucketDir: string;
  let distDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-mandatory-repo-'));
    fs.mkdirSync(path.join(repoRoot, 'engine', 'scripts'), { recursive: true });
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota-publish.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-publish.mjs'));
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota-keygen.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-keygen.mjs'));
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota'), path.join(repoRoot, 'engine', 'scripts', 'ota'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'build', 'ota-keys'), { recursive: true });

    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-gcloud-mandatory-'));
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'gcloud.cjs'), FAKE_GCLOUD_SRC);
      fs.writeFileSync(path.join(binDir, 'gcloud.cmd'), `@node "%~dp0gcloud.cjs" %*\r\n`);
    } else {
      const gcloudPath = path.join(binDir, 'gcloud');
      fs.writeFileSync(gcloudPath, FAKE_GCLOUD_SRC);
      fs.chmodSync(gcloudPath, 0o755);
    }

    bucketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-bucket-mandatory-'));
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-mandatory-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html>mandatory-test</html>');

    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(bucketDir, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  function publish(version: string, extraArgs: string[] = [], engineApi = '1') {
    const projectDir = path.join(repoRoot, 'games', 'testproj-shell');
    if (!fs.existsSync(path.join(projectDir, 'project.config.json'))) {
      writeProjectConfig(projectDir, { bundleName: 'shell', publicKey: readKeyPublicKey(repoRoot) });
    }
    return runNode(repoRoot, {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GCS_BUCKET_DIR: bucketDir,
    }, [
      'engine/scripts/ota-publish.mjs',
      '--dist', distDir, '--bucket', 'gs://fakebucket/testprefix',
      '--name', 'shell', '--version', version, '--engine-api', engineApi, '--key', 'default',
      '--project', projectDir,
      ...extraArgs,
    ]);
  }

  function readRelease() {
    return JSON.parse(fs.readFileSync(path.join(bucketDir, 'fakebucket', 'testprefix', 'release.json'), 'utf8'));
  }

  it('stays mandatory across a routine publish with neither flag (regression for #564)', () => {
    const first = publish('v1', ['--mandatory']);
    expect(first.status).toBe(0);
    expect(readRelease().mandatory).toBe(true);

    const second = publish('v2');
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/mandatory=true/);
    expect(readRelease().mandatory).toBe(true);
  });

  it('--no-mandatory explicitly clears a sticky mandatory release', () => {
    const first = publish('v1', ['--mandatory']);
    expect(first.status).toBe(0);
    expect(readRelease().mandatory).toBe(true);

    const second = publish('v2', ['--no-mandatory']);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/mandatory=false/);
    expect(readRelease().mandatory).toBe(false);
  });

  it('a first-ever publish with neither flag defaults to false', () => {
    const result = publish('v1');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/mandatory=false/);
    expect(readRelease().mandatory).toBe(false);
  });

  it('bundles still merge and minEngineApi still ratchets up while mandatory stays sticky', () => {
    const first = publish('v1', ['--mandatory'], '1');
    expect(first.status).toBe(0);

    // A second bundle name published alongside, at a HIGHER engine-api, with neither flag —
    // its own scratch project (bundleName "sling"), matching this "sling" --name.
    const slingProjectDir = path.join(repoRoot, 'games', 'testproj-sling');
    writeProjectConfig(slingProjectDir, { bundleName: 'sling', publicKey: readKeyPublicKey(repoRoot) });
    const second = runNode(repoRoot, {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GCS_BUCKET_DIR: bucketDir,
    }, [
      'engine/scripts/ota-publish.mjs',
      '--dist', distDir, '--bucket', 'gs://fakebucket/testprefix',
      '--name', 'sling', '--version', 'v1', '--engine-api', '2', '--key', 'default',
      '--project', slingProjectDir,
    ]);
    expect(second.status).toBe(0);

    const release = readRelease();
    expect(release.bundles).toEqual({ shell: 'v1', sling: 'v1' });
    expect(release.minEngineApi).toBe(2);
    expect(release.mandatory).toBe(true);
  });
});

/** The version-collision guard (A1/A2, adversarial review round 2) — covers what the
 *  `manifests` merge/prune tests above do NOT: the collision guard itself (retry-is-safe
 *  vs genuine-collision vs cannot-check) and the unprotected-bundle warning. Each of these
 *  was verified, per the review brief, to actually FAIL if its corresponding source fix is
 *  reverted (checked manually by temporarily reverting each fix, running this file, then
 *  restoring — `git diff --stat` on the source files is clean after). Reuses the same
 *  fake-gcloud harness as the race-condition suite above (FAKE_GCLOUD_SRC + runNode are
 *  module-scoped there). */
describe('ota-publish.mjs version-collision guard', () => {
  let repoRoot: string;
  let binDir: string;
  let bucketDir: string;
  let distDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-collision-repo-'));
    fs.mkdirSync(path.join(repoRoot, 'engine', 'scripts'), { recursive: true });
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota-publish.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-publish.mjs'));
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota-keygen.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-keygen.mjs'));
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota'), path.join(repoRoot, 'engine', 'scripts', 'ota'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'build', 'ota-keys'), { recursive: true });

    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-gcloud-collision-'));
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'gcloud.cjs'), FAKE_GCLOUD_SRC);
      fs.writeFileSync(path.join(binDir, 'gcloud.cmd'), `@node "%~dp0gcloud.cjs" %*\r\n`);
    } else {
      const gcloudPath = path.join(binDir, 'gcloud');
      fs.writeFileSync(gcloudPath, FAKE_GCLOUD_SRC);
      fs.chmodSync(gcloudPath, 0o755);
    }

    bucketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-bucket-collision-'));
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-collision-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html>collision-test</html>');

    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(bucketDir, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  // Same name-keyed scratch-project default as the race-condition describe above (this block
  // also publishes both "shell" and "sling" as arbitrary bundle-name test doubles).
  function publish(name: string, version: string, envOverrides: NodeJS.ProcessEnv = {}) {
    const projectDir = path.join(repoRoot, 'games', `testproj-${name}`);
    if (!fs.existsSync(path.join(projectDir, 'project.config.json'))) {
      writeProjectConfig(projectDir, { bundleName: name, publicKey: readKeyPublicKey(repoRoot) });
    }
    return runNode(repoRoot, {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GCS_BUCKET_DIR: bucketDir,
      ...envOverrides,
    }, [
      'engine/scripts/ota-publish.mjs',
      '--dist', distDir, '--bucket', 'gs://fakebucket/testprefix',
      '--name', name, '--version', version, '--engine-api', '1', '--key', 'default',
      '--project', projectDir,
    ]);
  }

  it('A1: retrying an already-published version with IDENTICAL contents succeeds and logs it', () => {
    const first = publish('shell', 'v1');
    expect(first.status).toBe(0);

    // Same name/version, same dist contents — this is what a retry after a failure in the
    // release.json loop (which runs AFTER the manifest/zip/files upload) looks like. Before
    // A1, the guard could not tell this apart from a genuine collision and refused it,
    // permanently burning the version string on the exact failure class it exists to let a
    // publisher recover from.
    const second = publish('shell', 'v1');
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already published with identical contents — resuming/);
  });

  it('A1: re-publishing an already-published version with DIFFERENT contents is a genuine collision', () => {
    const first = publish('shell', 'v1');
    expect(first.status).toBe(0);

    // Change what "shell@v1" would contain between the two publishes.
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html>DIFFERENT contents</html>');

    const second = publish('shell', 'v1');
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/Version collision/);
  });

  it('A1: a version-collision check that cannot be verified fails LOUDLY, not open', () => {
    const first = publish('shell', 'v1');
    expect(first.status).toBe(0);

    // Simulate an auth/permissions failure reading the EXISTING versioned manifest.json —
    // this is the one path where a wrong regex in engine/scripts/ota/gcloud.mjs's
    // isGcloudObjectNotFoundError (or any other "treat unknown as safe" bug) would silently
    // disable the guard entirely, and nothing else in the suite pins it.
    const second = publish('shell', 'v1', { FAKE_GCS_MANIFEST_CAT_UNAUTHORIZED: '1' });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/could not check for a version collision/i);
  });

  it('A2 + fix 4: a pre-#570 release.json (no manifests field) names the OTHER bundle as unprotected on publish', () => {
    // Seed a release.json shaped like one written before #570 ever existed: `bundles` has
    // two entries, `manifests` is entirely absent.
    const releaseDir = path.join(bucketDir, 'fakebucket', 'testprefix');
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, 'release.json'), JSON.stringify({
      schema: 1,
      bundles: { shell: 'v1', sling: 'v1' },
      mandatory: false,
      minEngineApi: 1,
      sig: 'stale-sig-not-checked-by-this-fake', // this publish re-signs; the fake never verifies it
    }));

    // Publishing "sling" only ever writes manifests["sling"] — "shell" has no bundle
    // manifest.json in the bucket at all yet (it was never actually published by this
    // test, only listed in bundles), so it stays uncovered and the warning must name it.
    const result = publish('sling', 'v1');
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/WARNING: manifest verification is NOT enabled for: shell/);
  });
});

/** #582: ota-publish.mjs's own publish-identity guards — the by-hand path the editor's
 *  `/api/ota/publish` route's refusal message sends a human to (a sub-game publish) used to
 *  have NEITHER the signing-key guard nor a dist-kind guard the route itself enforces. Reuses
 *  the same fake-gcloud harness (FAKE_GCLOUD_SRC + runNode are module-scoped above). */
describe('ota-publish.mjs publish-identity guards (#582)', () => {
  let repoRoot: string;
  let binDir: string;
  let bucketDir: string;
  let distDir: string;
  let projectDir: string;
  let realPublicKey: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-guards-repo-'));
    fs.mkdirSync(path.join(repoRoot, 'engine', 'scripts'), { recursive: true });
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota-publish.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-publish.mjs'));
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota-keygen.mjs'), path.join(repoRoot, 'engine', 'scripts', 'ota-keygen.mjs'));
    fs.cpSync(path.join(engineRoot, 'scripts', 'ota'), path.join(repoRoot, 'engine', 'scripts', 'ota'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'build', 'ota-keys'), { recursive: true });

    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-gcloud-guards-'));
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'gcloud.cjs'), FAKE_GCLOUD_SRC);
      fs.writeFileSync(path.join(binDir, 'gcloud.cmd'), `@node "%~dp0gcloud.cjs" %*\r\n`);
    } else {
      const gcloudPath = path.join(binDir, 'gcloud');
      fs.writeFileSync(gcloudPath, FAKE_GCLOUD_SRC);
      fs.chmodSync(gcloudPath, 0o755);
    }

    bucketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-bucket-guards-'));
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-guards-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html>guards-test</html>');

    const keygenEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    execFileSync('node', ['engine/scripts/ota-keygen.mjs'], { cwd: repoRoot, env: keygenEnv });
    realPublicKey = readKeyPublicKey(repoRoot);

    projectDir = path.join(repoRoot, 'games', 'testproj');
    writeProjectConfig(projectDir, { bundleName: 'shell', publicKey: realPublicKey });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(bucketDir, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  /** Bucket dir starts empty (mkdtempSync); any successful gcloud write creates
   *  `<bucketDir>/fakebucket/...` — so its absence proves nothing reached the bucket. */
  function bucketIsEmpty(): boolean {
    return !fs.existsSync(path.join(bucketDir, 'fakebucket'));
  }

  function publish(name: string, extraArgs: string[] = [], dist = distDir) {
    return runNode(repoRoot, {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GCS_BUCKET_DIR: bucketDir,
    }, [
      'engine/scripts/ota-publish.mjs',
      '--dist', dist, '--bucket', 'gs://fakebucket/testprefix',
      '--name', name, '--version', 'v1', '--engine-api', '1', '--key', 'default',
      ...extraArgs,
    ]);
  }

  it('a) omitting --project exits non-zero and touches nothing in the bucket', () => {
    const result = publish('shell');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--project is required/);
    expect(bucketIsEmpty()).toBe(true);
  });

  it('b) a --project whose project.config.json does not exist exits non-zero with a distinct message', () => {
    const missingProjectDir = path.join(repoRoot, 'games', 'nope');
    const result = publish('shell', ['--project', missingProjectDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/project\.config\.json not found/);
    expect(bucketIsEmpty()).toBe(true);
  });

  it('b-bis) an ota block with NO bundleName key (what pruneProjectConfig actually writes for the ' +
    'placeholder default) publishes successfully under --name shell — the regression case', () => {
    // Build the fixture through the repo's OWN writer, not by hand — this is the seam the
    // regression hid in. This is exactly what `/api/project-settings` does
    // (editorBackendRouter.ts): merge a patch onto the resolved config, then PRUNE it against
    // the pre-edit on-disk file + DEFAULT_PROJECT_CONFIG. `DEFAULT_PROJECT_CONFIG.ota.bundleName`
    // is "shell", and the on-disk file below never had an `ota` key at all, so pruning a
    // resolved config whose bundleName is left at that same default omits the key entirely —
    // an absent `bundleName` means "the default", not "malformed".
    const noNameDir = path.join(repoRoot, 'games', 'testproj-no-bundlename');
    fs.mkdirSync(noNameDir, { recursive: true });
    const onDisk = {} as RawProjectConfig; // no `ota` key at all before this "save"
    const resolved = mergeProjectConfig({
      ota: { enabled: true, baseUrl: 'https://storage.googleapis.com/fakebucket/testprefix', publicKey: realPublicKey, bundleName: 'shell', engineApi: 1 },
    });
    const pruned = pruneProjectConfig(resolved as unknown as RawProjectConfig, onDisk, DEFAULT_PROJECT_CONFIG as unknown as RawProjectConfig);
    fs.writeFileSync(path.join(noNameDir, 'project.config.json'), JSON.stringify(pruned));

    // Prove the fixture actually exercises the regression: the written file must genuinely
    // have no `ota.bundleName` key, or this test proves nothing if prune's behavior ever changes.
    const writtenOta = (pruned as { ota?: Record<string, unknown> }).ota;
    expect(writtenOta).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(writtenOta, 'bundleName')).toBe(false);

    const result = publish('shell', ['--project', noNameDir]);
    expect(result.status).toBe(0);
  });

  it('b-ter) an ota.bundleName PRESENT but malformed (not a non-empty string) is refused with the config-defect message', () => {
    const badNameDir = path.join(repoRoot, 'games', 'testproj-bad-bundlename');
    writeProjectConfig(badNameDir, { bundleName: 42 as unknown as string, publicKey: realPublicKey });
    const result = publish('shell', ['--project', badNameDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ota\.bundleName is present but not a non-empty string/);
    expect(bucketIsEmpty()).toBe(true);
  });

  it('h) ota.enabled explicitly false refuses before any upload', () => {
    const disabledDir = path.join(repoRoot, 'games', 'testproj-disabled');
    writeProjectConfig(disabledDir, { enabled: false, bundleName: 'shell', publicKey: realPublicKey });
    const result = publish('shell', ['--project', disabledDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ota\.enabled is not true/);
    expect(bucketIsEmpty()).toBe(true);
  });

  it('i) ota.enabled ABSENT (defaults to false) also refuses before any upload', () => {
    const noEnabledDir = path.join(repoRoot, 'games', 'testproj-no-enabled');
    fs.mkdirSync(noEnabledDir, { recursive: true });
    fs.writeFileSync(path.join(noEnabledDir, 'project.config.json'), JSON.stringify({ ota: { bundleName: 'shell', publicKey: realPublicKey } }));
    const result = publish('shell', ['--project', noEnabledDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ota\.enabled is not true/);
    expect(bucketIsEmpty()).toBe(true);
  });

  it('c) an ota.publicKey that does NOT match the signing key refuses before any upload', () => {
    const mismatchProjectDir = path.join(repoRoot, 'games', 'testproj-mismatch');
    writeProjectConfig(mismatchProjectDir, { bundleName: 'shell', publicKey: 'not-the-real-key' });
    const result = publish('shell', ['--project', mismatchProjectDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does NOT match/);
    expect(bucketIsEmpty()).toBe(true);
  });

  it('d) an empty ota.publicKey refuses with the project-public-key-empty message', () => {
    const emptyKeyProjectDir = path.join(repoRoot, 'games', 'testproj-empty-key');
    writeProjectConfig(emptyKeyProjectDir, { bundleName: 'shell', publicKey: '' });
    const result = publish('shell', ['--project', emptyKeyProjectDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ota\.publicKey is EMPTY/);
    expect(bucketIsEmpty()).toBe(true);
  });

  it('e) --name subgame-x with a plain dist (no subgame.json) is refused', () => {
    const result = publish('subgame-x', ['--project', projectDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does not match/);
    expect(bucketIsEmpty()).toBe(true);
  });

  it('f) --name subgame-x with a real subgame-dist (subgame.json present) publishes successfully — ' +
    'a verbatim port of the route\'s equality guard would have wrongly refused this', () => {
    const subgameDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-guards-subgame-dist-'));
    try {
      fs.writeFileSync(path.join(subgameDistDir, 'index.html'), '<html>subgame</html>');
      fs.writeFileSync(path.join(subgameDistDir, 'subgame.json'), JSON.stringify({ engineApi: 1 }));
      const result = publish('subgame-x', ['--project', projectDir], subgameDistDir);
      expect(result.status).toBe(0);
      const release = JSON.parse(fs.readFileSync(path.join(bucketDir, 'fakebucket', 'testprefix', 'release.json'), 'utf8'));
      expect(release.bundles).toEqual({ 'subgame-x': 'v1' });
    } finally {
      fs.rmSync(subgameDistDir, { recursive: true, force: true });
    }
  });

  it('g) --name shell (matching the project\'s own bundleName) with a subgame-dist is refused', () => {
    const subgameDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-guards-subgame-dist-shell-'));
    try {
      fs.writeFileSync(path.join(subgameDistDir, 'index.html'), '<html>subgame</html>');
      fs.writeFileSync(path.join(subgameDistDir, 'subgame.json'), JSON.stringify({ engineApi: 1 }));
      const result = publish('shell', ['--project', projectDir], subgameDistDir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/matches.*own ota\.bundleName/);
      expect(bucketIsEmpty()).toBe(true);
    } finally {
      fs.rmSync(subgameDistDir, { recursive: true, force: true });
    }
  });
});
