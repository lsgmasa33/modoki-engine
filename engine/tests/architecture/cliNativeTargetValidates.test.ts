/** The CLI's `add-native-targets.mjs` must run the SAME project-settings validation the
 *  editor's `/api/add-native-target` route runs before it scaffolds (#589).
 *
 *  Both reach the identical `scaffoldNativeTarget`, but only the route validated the merged
 *  config first — `projectConfigUnionErrors` + `validateBuildConfig`, the pair described at
 *  `vite-asset-scanner.ts` around the `/api/add-native-target` handler. The CLI loaded the
 *  config and scaffolded straight through it, so a hand-edited `project.config.json` carrying
 *  `"appId": "com.example.my game"` (or `""`) — refused by the editor — was accepted by the
 *  CLI and written into `capacitor.config.json`, then the iOS bundle identifier / Android
 *  `applicationId`. Sibling of #582: a guard the route enforces before spawning a CLI that the
 *  CLI itself lacked.
 *
 *  Why a SOURCE assertion for the wiring half, not a behavioural one. Driving
 *  `add-native-targets.mjs` end to end runs esbuild, `npm install` and `npx cap add` against a
 *  real project — the same weight `cliNativeBuildHeals.test.ts` already declined to pay for
 *  `build-web.mjs`, and for the same reason: far too heavy for `npm test`. What a source
 *  assertion cannot prove — that the validator functions actually reject a bad config and pass
 *  a good one — is covered separately below by importing and driving them directly, so the
 *  source check only has to prove they are REACHABLE and ORDERED correctly, not that they work.
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectConfigUnionErrors, validateBuildConfig, loadProjectConfig, loadProjectUserConfig } from '../../plugins/load-project-config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptPath = path.join(repoRoot, 'engine', 'scripts', 'add-native-targets.mjs');

describe('the two-part project-config validation actually rejects bad configs (#589)', () => {
  const tmpDirs: string[] = [];
  const makeProject = (config: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-cli-native-validate-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'project.config.json'), JSON.stringify(config, null, 2));
    return dir;
  };

  afterAll(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const errorsFor = (root: string): string[] => {
    const cfg = loadProjectConfig(root);
    return [...projectConfigUnionErrors(root), ...validateBuildConfig(cfg, loadProjectUserConfig(root))];
  };

  it('rejects an appId containing a space', () => {
    const dir = makeProject({ app: { appId: 'com.example.my game' } });
    const errors = errorsFor(dir);
    expect(errors.some((e) => e.includes('appId'))).toBe(true);
  });

  it('rejects an empty appId', () => {
    const dir = makeProject({ app: { appId: '' } });
    const errors = errorsFor(dir);
    expect(errors.some((e) => e.includes('appId'))).toBe(true);
  });

  it('a valid minimal config (a sparse override of the defaults) produces NO errors', () => {
    // Negative control — without this, the two assertions above could pass because the
    // validator errors on everything, not because it caught the bad values specifically.
    // An empty file is a legitimately valid project.config.json: absent fields resolve to
    // DEFAULT_PROJECT_CONFIG (app.appId defaults to 'com.modokiengine.prototype', which
    // matches the Bundle ID pattern), not to a malformed state.
    const dir = makeProject({});
    const errors = errorsFor(dir);
    expect(errors).toEqual([]);
  });

  it('a real shipped project (games/sling) also produces no errors', () => {
    const slingRoot = path.join(repoRoot, 'games', 'sling');
    if (!fs.existsSync(path.join(slingRoot, 'project.config.json'))) return; // fixture absent on this checkout
    const errors = errorsFor(slingRoot);
    expect(errors).toEqual([]);
  });
});

describe('add-native-targets.mjs wires the validation in before scaffolding (#589)', () => {
  const src = fs.readFileSync(scriptPath, 'utf8');

  it('destructures projectConfigUnionErrors and validateBuildConfig from loadPluginModules()', () => {
    const destructure = src.slice(0, src.indexOf('await loadPluginModules()'));
    expect(destructure).toMatch(/projectConfigUnionErrors/);
    expect(destructure).toMatch(/validateBuildConfig/);
  });

  it('calls both validators', () => {
    expect(src).toMatch(/projectConfigUnionErrors\(/);
    expect(src).toMatch(/validateBuildConfig\(/);
  });

  it('runs the check BEFORE the first scaffoldNativeTarget( call and before the DRY branch', () => {
    // Loose about HOW the check is written; strict about the two facts that were broken —
    // reachable at all, and ordered before the scaffold/dry-run report so `--dry-run` cannot
    // claim a project is scaffoldable that the real run would refuse.
    const checkCall = src.indexOf('validateBuildConfig(cfg');
    const scaffoldCall = src.indexOf('scaffoldNativeTarget(');
    const dryBranch = src.indexOf('if (DRY) {');
    expect(checkCall).toBeGreaterThan(-1);
    expect(scaffoldCall).toBeGreaterThan(-1);
    expect(dryBranch).toBeGreaterThan(-1);
    expect(checkCall).toBeLessThan(scaffoldCall);
    expect(checkCall).toBeLessThan(dryBranch);
  });

  it('skips the project (does not scaffold) when validation fails, without a --force-style bypass', () => {
    const checkCall = src.indexOf('validateBuildConfig(cfg');
    const nextChunk = src.slice(checkCall, checkCall + 400);
    expect(nextChunk).toMatch(/cfgErrors\.length/);
    expect(nextChunk).toMatch(/continue/);
    // The issue explicitly leaves a bypass as an owner call — this check must not grow one.
    expect(nextChunk).not.toMatch(/--force/);
  });
});
