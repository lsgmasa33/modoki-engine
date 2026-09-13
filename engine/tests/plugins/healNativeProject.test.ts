/** `healNativeProject` — the ONE native-heal sequence both `/api/build` and `build-web.mjs --target
 *  native` call (#827).
 *
 *  What is under test is the COMPOSITION: which steps run, in what order, what gates the install,
 *  that the stale check is unconditional, and that nothing runs without the build claim. The four
 *  leaf modules are mocked because each is covered by its own suite and each really writes a
 *  project (`npm pack`, `package.json`, pbxproj); the claim gate is NOT mocked — it runs against a
 *  real claims file under a per-test `MODOKI_HOME`, so "claimed" means the store says so.
 *
 *  Before #827 this sequence was pinned by SOURCE slicing in two files at once
 *  (`cliNativeBuildHeals.test.ts`: brace-matching `if (depsChanged || v?.needsInstall)` in one and
 *  `if (depHeal.changed || v.needsInstall)` in the other). Those proved each copy's shape; these
 *  prove the one sequence's behaviour. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const calls: string[] = [];
/** Which project/engine root each step was handed — a swapped pair vendors INTO the engine checkout. */
const roots: string[] = [];
const state = {
  depsChanged: {} as Record<string, boolean>,
  needsInstall: false,
  problems: [] as string[],
  reason: null as null | 'unreadable-package-json',
  fb: { ok: true, notes: [] } as { ok: true; notes: string[] } | { ok: false; lines: string[] },
};

vi.mock('../../plugins/healNativeConfig', () => ({
  healNativeConfig: (root: string) => { calls.push(`healNativeConfig:${path.basename(root)}`); return { notes: ['team'] }; },
}));
vi.mock('../../plugins/addNativeTarget', () => ({
  ensureCapacitorDeps: (root: string, platform: string, editorRoot: string) => {
    calls.push(`ensureCapacitorDeps:${platform}`);
    roots.push(`ensureCapacitorDeps:${root}|${editorRoot}`);
    return { changed: !!state.depsChanged[platform], notes: [] };
  },
}));
vi.mock('../../plugins/vendorPlugins', () => ({
  vendorEnginePlugins: (root: string, editorRoot: string) => {
    calls.push('vendorEnginePlugins');
    roots.push(`vendorEnginePlugins:${root}|${editorRoot}`);
    return { changed: false, needsInstall: state.needsInstall, vendored: [], expectedVendor: { 'capacitor-game-debug': 'file:x.tgz' } };
  },
  writeVendorMarker: (root: string) => { calls.push('writeVendorMarker'); roots.push(`writeVendorMarker:${root}`); },
  verifyInstalledMatchesTarballResult: (root: string) => {
    calls.push('verify');
    roots.push(`verify:${root}`);
    return { problems: state.problems, reason: state.reason };
  },
}));

vi.mock('../../plugins/stripFirebaseAuthFacebook', () => ({
  stripFirebaseAuthFacebook: (root: string) => {
    calls.push('stripFacebook');
    roots.push(`stripFacebook:${root}`);
    return state.fb;
  },
}));

const { healNativeProject, describeStaleNodeModules } = await import('../../plugins/healNativeProject');
const { acquireBuildClaim, resetBuildClaimsForTests } = await import('../../scripts/buildClaimsStore.mjs');

let home: string;
let prevHome: string | undefined;
let project: string;
let release: (() => void) | null;

beforeEach(() => {
  calls.length = 0;
  roots.length = 0;
  state.depsChanged = {};
  state.needsInstall = false;
  state.problems = [];
  state.reason = null;
  state.fb = { ok: true, notes: [] };
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-heal-project-'));
  const claim = acquireBuildClaim(project, 'ios build');
  if (!claim.ok) throw new Error(`fixture could not claim: ${claim.message}`);
  release = claim.release;
});

afterEach(() => {
  release?.();
  resetBuildClaimsForTests();
  if (prevHome === undefined) delete process.env.MODOKI_HOME;
  else process.env.MODOKI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

function ports(installResult = true) {
  const log: string[] = [];
  const warn: string[] = [];
  return {
    log, warn,
    ports: {
      log: (l: string) => { log.push(l); },
      warn: (l: string) => { warn.push(l); },
      install: async (why: string) => { calls.push(`install:${why}`); return installResult; },
    },
  };
}

describe('healNativeProject — the claim gate', () => {
  it('refuses, touching NOTHING, when this process does not hold the claim on that project', async () => {
    release?.();
    release = null;
    const p = ports();
    const r = await healNativeProject(project, '/engine', ['ios'], p.ports);
    expect(r).toMatchObject({ ok: false, reason: 'not-claimed' });
    expect(calls).toEqual([]);
  });

  it('runs when the claim is held (the accept side of the same gate)', async () => {
    const r = await healNativeProject(project, '/engine', ['ios'], ports().ports);
    expect(r).toEqual({ ok: true });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('healNativeProject — the sequence', () => {
  it('runs config → deps per platform → vendor → verify → Facebook strip, in that order, with nothing to install', async () => {
    const r = await healNativeProject(project, '/engine', ['ios', 'android'], ports().ports);
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([
      `healNativeConfig:${path.basename(project)}`,
      'ensureCapacitorDeps:ios',
      'ensureCapacitorDeps:android',
      'vendorEnginePlugins',
      'verify',
      'stripFacebook',
    ]);
  });

  it('with NO platforms still heals config, vendors and verifies — only the per-platform steps (deps, the iOS Facebook strip) are empty', async () => {
    await healNativeProject(project, '/engine', [], ports().ports);
    expect(calls).toEqual([`healNativeConfig:${path.basename(project)}`, 'vendorEnginePlugins', 'verify']);
  });

  it('skips the Facebook strip for an ANDROID-only build — an iOS manifest must not refuse it (#1062)', async () => {
    state.fb = { ok: false, lines: ['would refuse'] };
    const r = await healNativeProject(project, '/engine', ['android'], ports().ports);
    expect(r).toEqual({ ok: true });
    expect(calls).not.toContain('stripFacebook');
  });

  it('installs when a DEPS heal changed something, then writes the marker, then verifies', async () => {
    state.depsChanged = { android: true };
    await healNativeProject(project, '/engine', ['ios', 'android'], ports().ports);
    expect(calls.slice(-4)).toEqual(['install:healed Capacitor plugins', 'writeVendorMarker', 'verify', 'stripFacebook']);
  });

  it('installs when only the VENDOR step needs it — either condition alone is enough', async () => {
    state.needsInstall = true;
    await healNativeProject(project, '/engine', ['ios'], ports().ports);
    expect(calls.slice(-4)).toEqual(['install:engine plugin changed', 'writeVendorMarker', 'verify', 'stripFacebook']);
  });

  it('a failed install stops: no marker, no verify, and says which install', async () => {
    state.needsInstall = true;
    const r = await healNativeProject(project, '/engine', ['ios'], ports(false).ports);
    expect(r).toEqual({ ok: false, reason: 'install-failed', why: 'engine plugin changed' });
    expect(calls).not.toContain('writeVendorMarker');
    expect(calls).not.toContain('verify');
    expect(calls).not.toContain('stripFacebook');
  });

  it('the stale check runs UNCONDITIONALLY and refuses on a mismatch even when nothing was installed (#685)', async () => {
    state.problems = ['capacitor-game-debug: node_modules holds the previous tarball'];
    const r = await healNativeProject(project, '/engine', ['ios'], ports().ports);
    expect(calls.some((c) => c.startsWith('install:'))).toBe(false);
    expect(r).toMatchObject({ ok: false, reason: 'stale-node-modules', problems: state.problems });
    if (r.ok || r.reason !== 'stale-node-modules') throw new Error('unreachable');
    expect(r.lines).toEqual(describeStaleNodeModules(project, state.problems));
  });

  it('an unreadable package.json WARNS and continues — it is not reported as clean, and not as stale (#731)', async () => {
    state.reason = 'unreadable-package-json';
    const p = ports();
    const r = await healNativeProject(project, '/engine', ['ios'], p.ports);
    expect(r).toEqual({ ok: true });
    expect(p.warn).toHaveLength(1);
    expect(p.warn[0]).toContain(path.join(project, 'package.json'));
  });

  it('hands every step the PROJECT root, and the engine root only where the step takes one', async () => {
    state.needsInstall = true;
    await healNativeProject(project, '/engine', ['ios'], ports().ports);
    expect(calls[0]).toBe(`healNativeConfig:${path.basename(project)}`);
    expect(roots).toEqual([
      `ensureCapacitorDeps:${project}|/engine`,
      `vendorEnginePlugins:${project}|/engine`,
      `writeVendorMarker:${project}`,
      `verify:${project}`,
      `stripFacebook:${project}`,
    ]);
  });

  it('strips Facebook AFTER an install, never before it — an install re-extracts the original manifest (#1062)', async () => {
    state.needsInstall = true;
    await healNativeProject(project, '/engine', ['ios'], ports().ports);
    expect(calls.indexOf('stripFacebook')).toBeGreaterThan(calls.indexOf('install:engine plugin changed'));
  });

  it('REFUSES the build when the Facebook strip cannot complete, passing its diagnosis through (#1062)', async () => {
    state.fb = { ok: false, lines: ['still references Facebook', '  • .package(url: facebook-ios-sdk'] };
    const r = await healNativeProject(project, '/engine', ['ios'], ports().ports);
    expect(r).toEqual({ ok: false, reason: 'facebook-sdk-manifest', lines: state.fb.lines });
  });

  it('streams the strip\'s notes through log, tagged [heal]', async () => {
    state.fb = { ok: true, notes: ['stripped the Facebook iOS SDK'] };
    const p = ports();
    await healNativeProject(project, '/engine', ['ios'], p.ports);
    expect(p.log).toContain('[heal] stripped the Facebook iOS SDK');
  });

  it('streams every heal note through log, tagged [heal]', async () => {
    const p = ports();
    await healNativeProject(project, '/engine', ['ios'], p.ports);
    expect(p.log).toContain('[heal] team');
  });
});

describe('describeStaleNodeModules — the one SAFE remedy text (#685)', () => {
  const lines = describeStaleNodeModules('/tmp/fixture-project', ['plugin-a: stale']);
  const text = lines.join('\n');

  it('names the project, the problems and the lockfile step', () => {
    expect(text).toContain('plugin-a: stale');
    expect(text).toContain('/tmp/fixture-project/package-lock.json');
    expect(text).toMatch(/npm install/);
  });

  it('mentions --package-lock-only exactly once, and only inside the warning not to run it', () => {
    // It CAUSES this state (#685, measured 2026-09-05): offered as a STEP it walks the reader into
    // an unrecoverable tree.
    expect((text.match(/--package-lock-only/g) ?? []).length).toBe(1);
    expect(text).toMatch(/Do NOT reach for[^\n]*--package-lock-only/);
  });

  it('keeps the CONDITIONAL rm -rf third step — the only repair for an already-poisoned tree', () => {
    expect(text).toMatch(/rm -rf node_modules/);
    expect(text).toMatch(/ONLY if/);
  });
});
