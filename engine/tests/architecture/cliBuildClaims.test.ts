/** The three CLI scripts that write `<project>/dist` — `build-web.mjs`, `add-native-targets.mjs`,
 *  `ota-publish.mjs` — must each take the cross-process build claim (#650) BEFORE mutating
 *  anything, and give it back on every exit path. `buildLock.ts`'s in-process slot is invisible to
 *  a CLI script (a separate process), so without this a hand-run one of these can race the
 *  editor's own build/publish/scaffold into the SAME `<project>/dist`, producing a torn bundle.
 *
 *  Why a SOURCE assertion rather than a behavioural one — same posture as
 *  `cliNativeBuildHeals.test.ts` (see its own header): actually running any of these three costs a
 *  real vite/tsc build, `npm install`, or a `gcloud storage` upload, far too heavy for `npm test`.
 *  `buildClaimsStore.test.ts` already covers the STORE's own behaviour (grant/refuse/staleness/
 *  release identity) and proves the cross-process property with two real subprocesses; what has no
 *  other guard is the WIRING — that each script actually calls it, and calls it early enough. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { acquireBuildClaim, readBuildClaim, resetBuildClaimsForTests } from '../../scripts/buildClaimsStore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildWeb = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');
const addNativeTargets = path.join(repoRoot, 'engine', 'scripts', 'add-native-targets.mjs');
const otaPublish = path.join(repoRoot, 'engine', 'scripts', 'ota-publish.mjs');

describe('build-web.mjs takes the cross-process build claim (#650)', () => {
  const src = readScannedSource(buildWeb).code;

  it('imports acquireBuildClaim from buildClaimsStore.mjs', () => {
    expect(src).toMatch(/import\s*\{[^}]*acquireBuildClaim[^}]*\}\s*from\s*'\.\/buildClaimsStore\.mjs'/);
  });

  it('calls acquireBuildClaim, marking itself a CLI holder', () => {
    const idx = src.indexOf('acquireBuildClaim(');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 200)).toMatch(/kind:\s*'cli'/);
  });

  it('refuses and exits non-zero on a held claim, without blocking/waiting', () => {
    const acquireIdx = src.indexOf('const claimed = acquireBuildClaim(');
    expect(acquireIdx).toBeGreaterThan(-1);
    const chunk = src.slice(acquireIdx, acquireIdx + 400);
    expect(chunk).toMatch(/!claimed\.ok/);
    expect(chunk).toMatch(/process\.exit\(1\)/);
    // No retry/wait loop near the refusal — a scripted build must not hang on an interactive editor.
    expect(chunk).not.toMatch(/setTimeout|while\s*\(/);
  });

  it('releases the claim (via .release())', () => {
    expect(src).toMatch(/buildClaim\?\.\s*release\(\)/);
  });

  it('acquires BEFORE validateProjectConfig — the first thing the build pipeline does', () => {
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    const validateIdx = src.indexOf('await validateProjectConfig();');
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeLessThan(validateIdx);
  });
});

describe('add-native-targets.mjs takes the cross-process build claim (#650)', () => {
  const src = readScannedSource(addNativeTargets).code;

  it('imports acquireBuildClaim from buildClaimsStore.mjs', () => {
    expect(src).toMatch(/import\s*\{[^}]*acquireBuildClaim[^}]*\}\s*from\s*'\.\/buildClaimsStore\.mjs'/);
  });

  it('calls acquireBuildClaim, marking itself a CLI holder', () => {
    const idx = src.indexOf('acquireBuildClaim(');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 200)).toMatch(/kind:\s*'cli'/);
  });

  it('refuses (continues to the next project) rather than blocking, and marks the batch non-zero', () => {
    const acquireIdx = src.indexOf('const claimed = acquireBuildClaim(');
    expect(acquireIdx).toBeGreaterThan(-1);
    const chunk = src.slice(acquireIdx, acquireIdx + 400);
    expect(chunk).toMatch(/!claimed\.ok/);
    expect(chunk).toMatch(/continue/);
    expect(chunk).not.toMatch(/setTimeout|while\s*\(/);
    expect(src).toMatch(/REFUSED/);
    expect(src).toMatch(/s\.startsWith\('FAILED'\)\s*\|\|\s*s\.startsWith\('REFUSED'\)/);
  });

  it('releases the claim in a finally, so every SKIP path (continue) still releases it', () => {
    const finallyIdx = src.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(src.slice(finallyIdx, finallyIdx + 400)).toMatch(/claim\?\.\s*release\(\)/);
  });

  it('acquires BEFORE reading project.config.json (any mutation, including scaffoldNativeTarget\'s own heals, follows)', () => {
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    const cfgPathIdx = src.indexOf("const cfgPath = path.join(projectRoot, 'project.config.json');");
    const scaffoldIdx = src.indexOf('scaffoldNativeTarget(');
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(cfgPathIdx).toBeGreaterThan(-1);
    expect(scaffoldIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeLessThan(cfgPathIdx);
    expect(acquireIdx).toBeLessThan(scaffoldIdx);
  });

  it('claims once PER PROJECT, not once for the whole batch — each spec gets its own dist', () => {
    // The acquire call sits INSIDE the `for (const spec of specs)` loop, not before it.
    const forIdx = src.indexOf('for (const spec of specs)');
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    expect(forIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeGreaterThan(forIdx);
  });
});

describe('ota-publish.mjs takes the cross-process build claim (#650)', () => {
  const src = readScannedSource(otaPublish).code;

  it('imports acquireBuildClaim from buildClaimsStore.mjs', () => {
    expect(src).toMatch(/import\s*\{[^}]*acquireBuildClaim[^}]*\}\s*from\s*'\.\/buildClaimsStore\.mjs'/);
  });

  it('calls acquireBuildClaim, marking itself a CLI holder', () => {
    const idx = src.indexOf('acquireBuildClaim(');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 200)).toMatch(/kind:\s*'cli'/);
  });

  it('refuses via fail() (which exits non-zero) rather than blocking/waiting', () => {
    const acquireIdx = src.indexOf('const buildClaim = acquireBuildClaim(');
    expect(acquireIdx).toBeGreaterThan(-1);
    const chunk = src.slice(acquireIdx, acquireIdx + 200);
    expect(chunk).toMatch(/!buildClaim\.ok/);
    expect(chunk).toMatch(/fail\(/);
    expect(chunk).not.toMatch(/setTimeout|while\s*\(/);
  });

  it('releases the claim in a finally', () => {
    expect(src).toMatch(/\}\s*finally\s*\{\s*buildClaim\.release\(\);/);
  });

  it('acquires BEFORE hashing/reading distDir (buildManifestFiles) and before any upload', () => {
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    const hashIdx = src.indexOf('await buildManifestFiles(distDir)');
    const uploadIdx = src.indexOf("gcloud storage rsync");
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeLessThan(hashIdx);
    expect(acquireIdx).toBeLessThan(uploadIdx);
  });

  it('does NOT touch the heal/vendor family, and still parses project.config.json raw (unchanged by #650)', () => {
    // The brief for #650 explicitly calls this out: ota-publish.mjs reaches nothing from the
    // heal/vendor family on purpose (#582) — only the claim was added, not a new dependency on it.
    expect(src).not.toMatch(/healNativeConfig|ensureCapacitorDeps|vendorEnginePlugins|loadEnginePluginModule/);
    expect(src).toMatch(/JSON\.parse\(readFileSync\(projectConfigPath, 'utf8'\)\)/);
  });
});

// ── Everything above is source-text matching: it proves each script CALLS acquireBuildClaim, not
// that the claim actually behaves correctly across a real process boundary. That gap is exactly
// what broke (reproduced): `/api/build`/`/api/ota/publish`/`/api/add-native-target` hold the claim
// for their WHOLE pipeline and then spawn `build-web.mjs` as a CHILD process with the identical
// MODOKI_PROJECT — which resolves the SAME root and, before the re-entrancy fix
// (buildClaimsStore.mjs's own "Re-entrancy through a CHILD PROCESS" section), refused itself
// unconditionally. This spawns the REAL build-web.mjs (not a synthetic runner — precedent:
// `cliNativeBuildHeals.test.ts`'s "no-esbuild" case runs the real loader in a plain node
// subprocess) while THIS test process holds an ancestor claim, proving the child recognizes it and
// proceeds instead of deadlocking — and that an unrelated invocation with no matching token is
// still refused exactly as before. `buildClaimsStore.test.ts` unit-tests the token comparison
// itself, in-process; this is the end-to-end property those units add up to.
describe('build-web.mjs inherits an ancestor claim on the SAME project instead of deadlocking (#650 re-entrancy, reproduced)', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
    prevHome = process.env.MODOKI_HOME;
    process.env.MODOKI_HOME = home;
  });
  afterEach(() => {
    resetBuildClaimsForTests();
    if (prevHome === undefined) delete process.env.MODOKI_HOME;
    else process.env.MODOKI_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Run the REAL build-web.mjs from a throwaway SCRATCH cwd — same technique
   *  `buildWebTargetFlag.test.ts` already established for keeping a genuine invocation fast in a
   *  unit test. With no `engine/plugins/load-project-config.ts` under it, `validateProjectConfig`
   *  degrades to a harmless "no-source" warning (nothing here to validate) and the script presses
   *  on toward `vite build`, which fails FAST with "Cannot find module" — there is no
   *  `node_modules/vite` in scratch either. That failure is this test's "proceeded past the claim
   *  gate" signal; a claim REFUSAL exits well before either check is ever reached. */
  function runBuildWeb(env: NodeJS.ProcessEnv): { status: number; stderr: string } {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-claim-inherit-'));
    try {
      execFileSync(process.execPath, [buildWeb, '--target', 'web'], { cwd: scratch, env, encoding: 'utf8' });
      return { status: 0, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { status: err.status ?? 1, stderr: err.stderr ?? '' };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('a CHILD process inheriting the ancestor token proceeds instead of deadlocking', () => {
    // Never created on disk — the claim (and MODOKI_PROJECT) only ever compares this path STRING;
    // build-web.mjs's own project-config read degrades harmlessly (see runBuildWeb's comment)
    // long before anything would need the directory to exist.
    const projectRoot = path.join(home, 'inherit-project');
    const ancestor = acquireBuildClaim(projectRoot, 'editor build', { kind: 'editor' });
    expect(ancestor.ok).toBe(true);
    try {
      // The env a real spawned build step gets is `{ ...process.env, MODOKI_PROJECT }`
      // (`buildStepEnv`/the CLI scripts' own `runShell`) — and `process.env` in THIS process now
      // carries the token `acquireBuildClaim` just published, exactly as it would for a genuine
      // child of an editor route or of `add-native-targets.mjs`'s own scaffold.
      const { status, stderr } = runBuildWeb({ ...process.env, MODOKI_PROJECT: projectRoot });
      expect(stderr).not.toMatch(/already holds the build claim/);
      // Proceeded PAST the claim gate — failed downstream instead, for the unrelated (scratch-cwd)
      // reason runBuildWeb's own comment explains, not a self-deadlock.
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/Cannot find module/);
    } finally {
      if (ancestor.ok) ancestor.release();
    }
  });

  it('an UNRELATED process (no matching token) is still refused, naming the ancestor claim', () => {
    const projectRoot = path.join(home, 'refuse-project');
    const ancestor = acquireBuildClaim(projectRoot, 'editor build', { kind: 'editor' });
    expect(ancestor.ok).toBe(true);
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MODOKI_PROJECT: projectRoot };
      // A plain second invocation with no ancestor relationship — e.g. a human running
      // `npm run build` by hand from an ordinary shell while the editor's own build is in flight.
      delete env.MODOKI_BUILD_CLAIM_TOKEN;
      const { status, stderr } = runBuildWeb(env);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/already holds the build claim/);
      expect(stderr).toContain('editor build');
      // Refused BEFORE ever reaching the "proceeded" failure mode the previous test exercises.
      expect(stderr).not.toMatch(/Cannot find module/);
    } finally {
      if (ancestor.ok) ancestor.release();
    }
  });

  it("a FOREIGN token (a different project's still-live claim) does not grant a pass-through — refused, not bypassed", () => {
    const otherRoot = path.join(home, 'other-project');
    const other = acquireBuildClaim(otherRoot, 'other build', { kind: 'editor' });
    expect(other.ok).toBe(true);
    const projectRoot = path.join(home, 'foreign-token-project');
    const ancestor = acquireBuildClaim(projectRoot, 'editor build', { kind: 'editor' });
    expect(ancestor.ok).toBe(true);
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MODOKI_PROJECT: projectRoot };
      // Simulate a child that inherited a DIFFERENT project's token — a stale value left over from
      // an earlier build in the same long-lived shell/process, say — rather than this one's own.
      env.MODOKI_BUILD_CLAIM_TOKEN = readBuildClaim(otherRoot)?.token;
      const { status, stderr } = runBuildWeb(env);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/already holds the build claim/);
      expect(stderr).not.toMatch(/Cannot find module/);
    } finally {
      if (ancestor.ok) ancestor.release();
      if (other.ok) other.release();
    }
  });
});
