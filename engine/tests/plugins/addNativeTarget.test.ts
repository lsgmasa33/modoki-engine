/** addNativeTarget pure helpers — Capacitor dep/config scaffolding + Firebase
 *  detection, exercised against temp project dirs. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCapacitorDeps, ensureCapacitorConfig, detectMissingFirebase, isPlausibleProjectDir } from '../../plugins/addNativeTarget';
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
    // Includes the engine-runtime native plugins (app/keyboard/preferences) — omitting them
    // ships a JS proxy with no native impl → "plugin is not implemented on <platform>" at launch.
    expect(Object.keys(deps).sort()).toEqual(
      ['@capacitor/app', '@capacitor/cli', '@capacitor/core', '@capacitor/ios', '@capacitor/keyboard', '@capacitor/preferences', 'capacitor-game-debug'],
    );
  });

  it('pins each engine-runtime plugin to the editor\'s OWN version (proxy must match the native plugin)', () => {
    fs.writeFileSync(path.join(editorRoot, 'package.json'), JSON.stringify({
      dependencies: { '@capacitor/core': '^8.3.0', '@capacitor/app': '^8.1.0', '@capacitor/keyboard': '^8.0.3', '@capacitor/preferences': '^8.0.1' },
    }));
    writePkg();
    ensureCapacitorDeps(root, 'android', editorRoot);
    const deps = readDeps();
    expect(deps['@capacitor/app']).toBe('^8.1.0');
    expect(deps['@capacitor/keyboard']).toBe('^8.0.3');
    expect(deps['@capacitor/preferences']).toBe('^8.0.1');
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
  const cfg = mergeProjectConfig({ app: { appId: 'com.x.y', appName: 'My Game' } });

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
