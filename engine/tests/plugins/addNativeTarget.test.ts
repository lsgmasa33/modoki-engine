/** addNativeTarget pure helpers — Capacitor dep/config scaffolding + Firebase
 *  detection, exercised against temp project dirs. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensureCapacitorDeps, ensureCapacitorConfig, detectMissingFirebase, isPlausibleProjectDir, isNativeTargetScaffolded, scaffoldNativeTarget } from '../../plugins/addNativeTarget';
import { mergeProjectConfig } from '../../project-config';

let root: string;
let editorRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ant-'));
  editorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ant-ed-'));
  // Mark root as a real Modoki project so the D8 containment guard allows scaffolding.
  fs.writeFileSync(path.join(root, 'project.config.json'), '{}');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(editorRoot, { recursive: true, force: true });
});

function writePkg(deps: Record<string, string> = {}) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'g', dependencies: deps }, null, 2) + '\n');
}
function readDeps(): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies;
}

describe('isPlausibleProjectDir (D8 containment)', () => {
  it('accepts a dir with project.config.json / game.ts / package.json', () => {
    expect(isPlausibleProjectDir(root)).toBe(true); // has project.config.json
  });
  it('rejects a non-existent path', () => {
    expect(isPlausibleProjectDir(path.join(root, 'nope'))).toBe(false);
  });
  it('rejects a dir with no project markers', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-bare-'));
    try {
      expect(isPlausibleProjectDir(bare)).toBe(false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
  it('ensureCapacitorDeps refuses to scaffold a non-project dir', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-bare-'));
    try {
      expect(() => ensureCapacitorDeps(bare, 'ios', editorRoot)).toThrow(/doesn't look like a Modoki project/);
      expect(fs.existsSync(path.join(bare, 'package.json'))).toBe(false); // nothing written
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('ensureCapacitorDeps', () => {
  it('adds core/cli/<platform> + engine-runtime plugins + game-debug when missing (ios)', () => {
    writePkg();
    const r = ensureCapacitorDeps(root, 'ios', editorRoot);
    expect(r.changed).toBe(true);
    const deps = readDeps();
    // Includes the engine-runtime native plugins (app/haptics/keyboard/preferences) — omitting
    // one ships a JS proxy with no native impl → "plugin is not implemented on <platform>" at
    // launch. `@capacitor/haptics` joined the list when runtime/haptics/ landed, because the
    // engine imports it statically: "this game does not use haptics" is not a state the bundle
    // can be in.
    expect(Object.keys(deps).sort()).toEqual(
      ['@capacitor/app', '@capacitor/cli', '@capacitor/core', '@capacitor/haptics', '@capacitor/ios', '@capacitor/keyboard', '@capacitor/preferences', '@capacitor/splash-screen', 'capacitor-game-debug'],
    );
  });

  it('pins each engine-runtime plugin to the editor\'s OWN version (proxy must match the native plugin)', () => {
    fs.writeFileSync(path.join(editorRoot, 'package.json'), JSON.stringify({
      dependencies: { '@capacitor/core': '^8.3.0', '@capacitor/app': '^8.1.0', '@capacitor/keyboard': '^8.0.3', '@capacitor/preferences': '^8.0.1', '@capacitor/splash-screen': '^8.0.1' },
    }));
    writePkg();
    ensureCapacitorDeps(root, 'android', editorRoot);
    const deps = readDeps();
    expect(deps['@capacitor/app']).toBe('^8.1.0');
    expect(deps['@capacitor/keyboard']).toBe('^8.0.3');
    expect(deps['@capacitor/preferences']).toBe('^8.0.1');
    expect(deps['@capacitor/splash-screen']).toBe('^8.0.1');
  });

  it('creates a minimal package.json when the project has none', () => {
    // no writePkg() — chess-style flat game with no package.json
    const r = ensureCapacitorDeps(root, 'android', editorRoot);
    expect(r.changed).toBe(true);
    expect(r.notes).toContain('created package.json');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe(`@modoki-game/${path.basename(root)}`);
    expect(pkg.workspaces).toEqual(['packages/*']);
    expect(pkg.dependencies['@capacitor/android']).toBeDefined();
  });

  it('uses @capacitor/android for the android platform', () => {
    writePkg();
    ensureCapacitorDeps(root, 'android', editorRoot);
    expect(readDeps()['@capacitor/android']).toBeDefined();
    expect(readDeps()['@capacitor/ios']).toBeUndefined();
  });

  it('pins the editor\'s @capacitor/core range', () => {
    fs.writeFileSync(path.join(editorRoot, 'package.json'), JSON.stringify({ dependencies: { '@capacitor/core': '^8.9.9' } }));
    writePkg();
    ensureCapacitorDeps(root, 'ios', editorRoot);
    expect(readDeps()['@capacitor/core']).toBe('^8.9.9');
  });

  it('does not downgrade / re-add existing deps (idempotent)', () => {
    writePkg({ '@capacitor/core': '^8.1.0' });
    const first = ensureCapacitorDeps(root, 'ios', editorRoot);
    expect(first.changed).toBe(true);
    expect(readDeps()['@capacitor/core']).toBe('^8.1.0'); // kept
    const second = ensureCapacitorDeps(root, 'ios', editorRoot);
    expect(second.changed).toBe(false);
  });
});

describe('ensureCapacitorConfig', () => {
  const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game', iconSource: '' } });

  it('creates capacitor.config.json from project config', () => {
    const r = ensureCapacitorConfig(root, cfg);
    expect(r.changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
    expect(written.appId).toBe('com.x.y');
    expect(written.appName).toBe('My Game');
    expect(written.webDir).toBe('dist');
  });

  it('does not clobber an existing config', () => {
    fs.writeFileSync(path.join(root, 'capacitor.config.json'), '{"appId":"keep.me"}');
    const r = ensureCapacitorConfig(root, cfg);
    expect(r.changed).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8')).appId).toBe('keep.me');
  });
});

describe('isNativeTargetScaffolded', () => {
  it('is false when the platform folder does not exist at all', () => {
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(false);
    expect(isNativeTargetScaffolded(root, 'android')).toBe(false);
  });

  it('is false when the folder exists but is empty (killed at the very start of extraction)', () => {
    fs.mkdirSync(path.join(root, 'ios', 'App'), { recursive: true });
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(false);
    fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
    expect(isNativeTargetScaffolded(root, 'android')).toBe(false);
  });

  it('is false when only the EARLY-archive file landed before the kill (#581 F1 — the bug this predicate exists to catch)', () => {
    // project.pbxproj is entry 2/20 in the real iOS template; debug.xcconfig is entry 20/20.
    // A kill straight after entry 2 leaves exactly this shape — the old single-marker predicate
    // read it as "scaffolded" even though 18 of 20 template files never landed.
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), '// stub');
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(false);

    // build.gradle is entry 3/52 in the real Android template; variables.gradle is entry 52/52.
    fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'android', 'app', 'build.gradle'), '// stub');
    expect(isNativeTargetScaffolded(root, 'android')).toBe(false);
  });

  it('is true once both the early- and late-archive markers are present', () => {
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), '// stub');
    fs.writeFileSync(path.join(root, 'ios', 'debug.xcconfig'), '// stub');
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(true);

    fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'android', 'app', 'build.gradle'), '// stub');
    fs.writeFileSync(path.join(root, 'android', 'variables.gradle'), '// stub');
    expect(isNativeTargetScaffolded(root, 'android')).toBe(true);
  });
});

describe('isNativeTargetScaffolded markers match the real @capacitor/cli templates (#581)', () => {
  // Loaded via createRequire, not a static `import 'tar'`, matching the existing pattern for this
  // exact package elsewhere in the repo (engine/toolchain/index.ts) — this file is only ever run
  // directly under vitest, never esbuild-bundled, but there's no reason to diverge from the
  // established way this repo loads `tar`.
  const require = createRequire(import.meta.url);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  function templateEntries(archiveName: string): string[] {
    const tar = require('tar');
    const entries: string[] = [];
    tar.list({
      file: path.join(repoRoot, 'node_modules', '@capacitor', 'cli', 'assets', archiveName),
      sync: true,
      onentry: (e: { path: string }) => entries.push(e.path),
    });
    return entries;
  }

  it('iOS SPM template: project.pbxproj is present, debug.xcconfig is the LAST entry', () => {
    const entries = templateEntries('ios-spm-template.tar.gz');
    expect(entries).toContain('App/App.xcodeproj/project.pbxproj');
    expect(entries[entries.length - 1]).toBe('debug.xcconfig');
  });

  it('Android template: app/build.gradle is present, variables.gradle is the LAST entry', () => {
    const entries = templateEntries('android-template.tar.gz');
    expect(entries).toContain('app/build.gradle');
    expect(entries[entries.length - 1]).toBe('variables.gradle');
  });
});

describe('scaffoldNativeTarget repair (#581)', () => {
  it('removes an incomplete platform folder before calling cap add, then proceeds', async () => {
    writePkg();
    const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game', iconSource: '' } });
    // Simulate a `cap add ios` killed right after the early-archive marker landed (#581 F1 shape).
    const pbxproj = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.mkdirSync(path.dirname(pbxproj), { recursive: true });
    fs.writeFileSync(pbxproj, 'stale — from an interrupted extraction');
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(false);

    const sent: string[] = [];
    const runShell = async (label: string, cmd: string) => {
      sent.push(label);
      if (cmd.startsWith('npx cap add')) {
        // The real `cap add` would fatal here if the stale folder were still present —
        // assert the repair step already cleared it before this runs.
        expect(fs.existsSync(pbxproj)).toBe(false);
        // Simulate a full, successful extraction (both markers) so isNativeTargetScaffolded
        // reads true afterward.
        fs.mkdirSync(path.dirname(pbxproj), { recursive: true });
        fs.writeFileSync(pbxproj, '// stub');
        fs.writeFileSync(path.join(root, 'ios', 'debug.xcconfig'), '// stub');
      }
      return true;
    };

    const { warnings } = await scaffoldNativeTarget({
      projectRoot: root, platform: 'ios', buildCwd: editorRoot, cfg,
      send: (m) => sent.push(m), runShell,
    });

    expect(warnings).toEqual([]);
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(true);
    expect(sent.some((m) => /Removing incomplete/.test(m))).toBe(true);
  });

  it('refuses to delete an incomplete folder that contains a Firebase config file (#581 F2)', async () => {
    writePkg();
    const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game', iconSource: '' } });
    const pbxproj = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.mkdirSync(path.dirname(pbxproj), { recursive: true });
    fs.writeFileSync(pbxproj, 'stale — extraction never finished');
    const plist = path.join(root, 'ios', 'App', 'App', 'GoogleService-Info.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, 'real Firebase config — must survive');
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(false);

    const runShell = async () => true; // must never be reached for the cap-add step
    await expect(scaffoldNativeTarget({
      projectRoot: root, platform: 'ios', buildCwd: editorRoot, cfg, send: () => {}, runShell,
    })).rejects.toThrow(/GoogleService-Info\.plist/);

    expect(fs.existsSync(plist)).toBe(true); // never deleted
  });

  it('does NOT touch a directory that already contains a complete target', async () => {
    writePkg();
    const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game', iconSource: '' } });
    const pbxproj = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.mkdirSync(path.dirname(pbxproj), { recursive: true });
    fs.writeFileSync(pbxproj, '// real project file, keep me');
    fs.writeFileSync(path.join(root, 'ios', 'debug.xcconfig'), '// stub');
    const marker = path.join(root, 'ios', 'App', 'App.xcodeproj', 'sentinel');
    fs.writeFileSync(marker, 'must survive');

    // Callers only invoke scaffoldNativeTarget when isNativeTargetScaffolded() is already false;
    // this test still confirms the repair step itself won't wipe a directory that turns out to
    // already be complete (e.g. a race), by asserting the sentinel file survives the run.
    const runShell = async () => true;
    await scaffoldNativeTarget({ projectRoot: root, platform: 'ios', buildCwd: editorRoot, cfg, send: () => {}, runShell });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('removes an incomplete ANDROID platform folder before calling cap add, then proceeds', async () => {
    writePkg();
    const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game', iconSource: '' } });
    const buildGradle = path.join(root, 'android', 'app', 'build.gradle');
    fs.mkdirSync(path.dirname(buildGradle), { recursive: true });
    fs.writeFileSync(buildGradle, 'stale — from an interrupted extraction');
    expect(isNativeTargetScaffolded(root, 'android')).toBe(false);

    const runShell = async (_label: string, cmd: string) => {
      if (cmd.startsWith('npx cap add')) {
        expect(fs.existsSync(buildGradle)).toBe(false);
        fs.mkdirSync(path.dirname(buildGradle), { recursive: true });
        fs.writeFileSync(buildGradle, '// stub');
        fs.writeFileSync(path.join(root, 'android', 'variables.gradle'), '// stub');
      }
      return true;
    };
    const { warnings } = await scaffoldNativeTarget({
      projectRoot: root, platform: 'android', buildCwd: editorRoot, cfg, send: () => {}, runShell,
    });
    expect(warnings).toEqual([]);
    expect(isNativeTargetScaffolded(root, 'android')).toBe(true);
  });

  it('refuses to delete an incomplete ANDROID folder that contains google-services.json (#581 F2)', async () => {
    writePkg();
    const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game', iconSource: '' } });
    const buildGradle = path.join(root, 'android', 'app', 'build.gradle');
    fs.mkdirSync(path.dirname(buildGradle), { recursive: true });
    fs.writeFileSync(buildGradle, 'stale');
    const gsJson = path.join(root, 'android', 'app', 'google-services.json');
    fs.writeFileSync(gsJson, 'real Firebase config — must survive');
    expect(isNativeTargetScaffolded(root, 'android')).toBe(false);

    const runShell = async () => true;
    await expect(scaffoldNativeTarget({
      projectRoot: root, platform: 'android', buildCwd: editorRoot, cfg, send: () => {}, runShell,
    })).rejects.toThrow(/google-services\.json/);
    expect(fs.existsSync(gsJson)).toBe(true);
  });

  it('force:true removes an ALREADY-COMPLETE target and regenerates it (#581 finding 1)', async () => {
    writePkg();
    const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game', iconSource: '' } });
    const pbxproj = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.mkdirSync(path.dirname(pbxproj), { recursive: true });
    fs.writeFileSync(pbxproj, 'ORIGINAL — must be gone after force-regeneration');
    fs.writeFileSync(path.join(root, 'ios', 'debug.xcconfig'), 'ORIGINAL');
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(true); // genuinely complete before this run

    const sent: string[] = [];
    const runShell = async (label: string, cmd: string) => {
      sent.push(label);
      if (cmd.startsWith('npx cap add')) {
        expect(fs.existsSync(pbxproj)).toBe(false); // removed before cap add, even though it was complete
        fs.mkdirSync(path.dirname(pbxproj), { recursive: true });
        fs.writeFileSync(pbxproj, 'REGENERATED');
        fs.writeFileSync(path.join(root, 'ios', 'debug.xcconfig'), 'REGENERATED');
      }
      return true;
    };
    await scaffoldNativeTarget({
      projectRoot: root, platform: 'ios', buildCwd: editorRoot, cfg,
      send: (m) => sent.push(m), runShell, force: true,
    });
    expect(fs.readFileSync(pbxproj, 'utf8')).toBe('REGENERATED');
    expect(sent.some((m) => /--force: removing existing/.test(m))).toBe(true);
  });

  it('force:true still refuses when a Firebase survivor is present, even on a complete target', async () => {
    writePkg();
    const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game', iconSource: '' } });
    const pbxproj = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.mkdirSync(path.dirname(pbxproj), { recursive: true });
    fs.writeFileSync(pbxproj, '// stub');
    fs.writeFileSync(path.join(root, 'ios', 'debug.xcconfig'), '// stub');
    const plist = path.join(root, 'ios', 'App', 'App', 'GoogleService-Info.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, 'real Firebase config — must survive even under --force');
    expect(isNativeTargetScaffolded(root, 'ios')).toBe(true);

    const runShell = async () => true; // must never be reached
    await expect(scaffoldNativeTarget({
      projectRoot: root, platform: 'ios', buildCwd: editorRoot, cfg, send: () => {}, runShell, force: true,
    })).rejects.toThrow(/GoogleService-Info\.plist/);
    expect(fs.existsSync(plist)).toBe(true);
    expect(fs.existsSync(pbxproj)).toBe(true); // nothing touched
  });
});

describe('detectMissingFirebase', () => {
  it('returns nothing when the project has no Firebase deps', () => {
    writePkg({ '@capacitor/core': '^8' });
    expect(detectMissingFirebase(root, 'ios')).toEqual([]);
  });

  it('warns when Firebase is used but the iOS plist is missing', () => {
    writePkg({ '@capacitor-firebase/analytics': '^8' });
    const w = detectMissingFirebase(root, 'ios');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('GoogleService-Info.plist');
  });

  it('warns about google-services.json for android', () => {
    writePkg({ '@capacitor-firebase/crashlytics': '^8' });
    expect(detectMissingFirebase(root, 'android')[0]).toContain('google-services.json');
  });

  it('is satisfied when the config file is present', () => {
    writePkg({ '@capacitor-firebase/analytics': '^8' });
    const dir = path.join(root, 'ios', 'App', 'App');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'GoogleService-Info.plist'), '<plist/>');
    expect(detectMissingFirebase(root, 'ios')).toEqual([]);
  });
});
