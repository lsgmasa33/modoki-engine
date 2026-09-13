/** The hand-runnable scripts that write a project take its build claim through `claimProjectOrExit`
 *  (#1160). Before this, `vendor-plugins.mjs`, `generate-icons.mjs` and `ota-embed-manifest.mjs`
 *  wrote the project with no claim, and the two smoke scripts deleted `dist/`/`ads/` before their
 *  `build-web` child claimed.
 *
 *  The first three are driven for real: each runs as a subprocess against a scratch project, in a
 *  private `MODOKI_HOME`, while THIS process holds the claim. Every script is tested from both
 *  sides, because the second side is the one the editor depends on:
 *   - **refused**: the token env var is stripped, so the child is a stranger. It must exit 1,
 *     name the holder, and write nothing.
 *   - **inherited**: the holder's token is on the child's env, exactly as the `/api/build` step list
 *     and `build-web.mjs` pass it. It must get past the claim. If this side broke, the editor's own
 *     build would refuse its own icon and manifest steps.
 *
 *  The smoke scripts need Playwright and two real builds, so they get a source assertion instead,
 *  read from the AST (`sourceAst`, #1144): the claim runs before the delete in the script's own
 *  top-level execution order. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireBuildClaim, resetBuildClaimsForTests, BUILD_CLAIM_ENV_VAR } from '../../scripts/buildClaimsStore.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import ts from 'typescript';
import { callsTo, enclosingFunction, parseSource, stringValueOf } from '@modoki/engine/testing/sourceAst';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts');
const repoRoot = path.resolve(scriptsDir, '../..');

let home: string;
let project: string;
let prevHome: string | undefined;
let token: string | undefined;
let release: (() => void) | null = null;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-cli-claim-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-cli-claim-proj-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
  const claim = acquireBuildClaim(project, 'native build (test holder)', { kind: 'cli' });
  if (!claim.ok) throw new Error(claim.message);
  release = claim.release;
  token = process.env[BUILD_CLAIM_ENV_VAR];
  // The store published the token onto THIS process's env; strip it so a child inherits it only when
  // a test says so.
  delete process.env[BUILD_CLAIM_ENV_VAR];
});

afterEach(() => {
  release?.();
  release = null;
  resetBuildClaimsForTests();
  if (prevHome === undefined) delete process.env.MODOKI_HOME;
  else process.env.MODOKI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

function runScript(script: string, args: string[], inherit: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, MODOKI_HOME: home };
  if (inherit) env[BUILD_CLAIM_ENV_VAR] = token;
  else delete env[BUILD_CLAIM_ENV_VAR];
  const r = spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    cwd: repoRoot, env, encoding: 'utf8', timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const REFUSAL = /already holds the build claim for .*native build \(test holder\)/;

describe('ota-embed-manifest.mjs takes the build claim', () => {
  const args = () => ['--dist', path.join(project, 'dist'), '--name', 'shell', '--engine-api', '1', '--project', project];
  const manifest = () => path.join(project, 'dist', 'ota-embedded-manifest.json');
  beforeEach(() => {
    fs.mkdirSync(path.join(project, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(project, 'dist', 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(project, 'project.config.json'), JSON.stringify({ ota: { enabled: true, bundleName: 'shell' } }));
  });

  it('refuses, exit 1, writing no manifest, while a stranger holds the claim', () => {
    const r = runScript('ota-embed-manifest.mjs', args(), false);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(REFUSAL);
    expect(fs.existsSync(manifest())).toBe(false);
  });

  it('passes through on the holder\'s inherited token and writes the manifest', () => {
    const r = runScript('ota-embed-manifest.mjs', args(), true);
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(manifest())).toBe(true);
  });
});

describe('generate-icons.mjs takes the build claim', () => {
  // A missing icon exits 1 with its OWN message, after the claim. That message tells "got past the
  // claim" apart from "refused at it" without ever spawning `@capacitor/assets`.
  const args = ['--platform', 'android', '--icon', 'no/such/icon.png'];

  it('refuses, exit 1, before staging anything, while a stranger holds the claim', () => {
    const r = runScript('generate-icons.mjs', ['--project', project, ...args], false);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(REFUSAL);
    expect(r.out).not.toMatch(/could not read the icon source/);
    expect(fs.existsSync(path.join(project, 'assets'))).toBe(false);
  });

  it('passes through on the holder\'s inherited token (it reaches the icon check)', () => {
    const r = runScript('generate-icons.mjs', ['--project', project, ...args], true);
    expect(r.out).not.toMatch(REFUSAL);
    expect(r.out).toMatch(/could not read the icon source/);
  });
});

describe('vendor-plugins.mjs takes the build claim', () => {
  const pkg = () => path.join(project, 'package.json');
  beforeEach(() => {
    fs.writeFileSync(pkg(), JSON.stringify({ name: 'claim-test', version: '0.0.0', dependencies: {} }));
  });

  it('refuses, exit 1, leaving package.json untouched, while a stranger holds the claim', () => {
    const before = fs.readFileSync(pkg(), 'utf8');
    const r = runScript('vendor-plugins.mjs', [project], false);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(REFUSAL);
    expect(fs.readFileSync(pkg(), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(project, 'plugins'))).toBe(false);
  });

  it('passes through on the holder\'s inherited token and vendors (nothing to vendor: "up to date")', () => {
    const r = runScript('vendor-plugins.mjs', [project], true);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/up to date/);
  });
});

/** The TOP-LEVEL statement of `sf` through which `n` runs: its own statement when `n` is top-level
 *  code, otherwise every top-level statement that calls the named function enclosing it (recursively).
 *  Execution order of a script is the order of its top-level statements, which is what "the claim is
 *  taken before the delete" means. A position comparison would pass on a function DEFINED after the
 *  claim but CALLED before it. */
function topLevelRunners(sf: ts.SourceFile, n: ts.Node, seen = new Set<ts.Node>()): ts.Statement[] {
  const fn = enclosingFunction(n);
  if (ts.isSourceFile(fn)) {
    let cur: ts.Node = n;
    while (cur.parent && !ts.isSourceFile(cur.parent)) cur = cur.parent;
    return [cur as ts.Statement];
  }
  if (seen.has(fn)) return [];
  seen.add(fn);
  const name = ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text
    : fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined;
  if (!name) throw new Error(`an anonymous function at ${sf.fileName} holds the delete; this guard cannot order it`);
  return callsTo(sf, name).flatMap((c) => topLevelRunners(sf, c, seen));
}

describe('the smoke scripts claim BEFORE they delete build output', () => {
  for (const [script, target] of [
    ['smoke-debug-build-flag.mjs', 'distDir'],
    ['smoke-playable.mjs', 'ads'],
  ] as const) {
    it(`${script}: the top-level claimProjectOrExit( runs before every rmSync of ${target}`, () => {
      const sf = parseSource(readScannedSource(path.join(scriptsDir, script)).code, script);
      const claims = callsTo(sf, 'claimProjectOrExit');
      expect(claims, 'expected exactly one claimProjectOrExit( call').toHaveLength(1);
      expect(ts.isSourceFile(enclosingFunction(claims[0])), 'the claim must be top-level code, taken once').toBe(true);
      const claimAt = topLevelRunners(sf, claims[0])[0].getStart(sf);
      const deletes = callsTo(sf, 'rmSync').filter((c) => {
        const a = c.arguments[0];
        return !!a && (a.getText(sf) === target || callsTo(a, 'join').some((j) => j.arguments.some((x) => stringValueOf(x) === target)));
      });
      expect(deletes.length, `no rmSync of ${target} found — the script changed shape`).toBeGreaterThan(0);
      for (const d of deletes) {
        const runners = topLevelRunners(sf, d);
        expect(runners.length, 'a delete nothing runs').toBeGreaterThan(0);
        for (const r of runners) expect(r.getStart(sf), `${r.getText(sf).slice(0, 60)} runs before the claim`).toBeGreaterThan(claimAt);
      }
    });
  }
});
