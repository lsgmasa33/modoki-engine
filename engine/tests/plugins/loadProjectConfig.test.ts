/** loadProjectConfig tests — verify the file-over-defaults merge and graceful
 *  fallback when project.config.json is absent or malformed, plus the split into
 *  the committed config and the per-machine project.user.json. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadProjectConfig,
  writeProjectConfig,
  validateBuildConfig,
  loadProjectUserConfig,
  writeProjectUserConfig,
} from '../../plugins/load-project-config';
import {
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_PROJECT_USER_CONFIG,
  mergeProjectConfig,
  mergeProjectUserConfig,
  type ProjectConfig,
  type ProjectUserConfig,
} from '../../project-config';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'projcfg-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const configPath = () => path.join(root, 'project.config.json');

describe('loadProjectConfig', () => {
  it('returns defaults when the file is absent', () => {
    expect(loadProjectConfig(root)).toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('merges a partial file over the defaults (per nested key)', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      build: { webBucket: 'gs://custom-bucket' },
      app: { appName: 'Custom' },
    }));
    const cfg = loadProjectConfig(root);
    expect(cfg.build.webBucket).toBe('gs://custom-bucket');
    // untouched nested keys fall back to defaults
    expect(cfg.build.webBasePath).toBe(DEFAULT_PROJECT_CONFIG.build.webBasePath);
    expect(cfg.app.appName).toBe('Custom');
    expect(cfg.app.appId).toBe(DEFAULT_PROJECT_CONFIG.app.appId);
  });

  it('deep-merges nested rendering/physics sections without wiping siblings', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      rendering: { three: { exposure: 2 } },
      physics: { layers: ['Default', 'Player'] },
    }));
    const cfg = loadProjectConfig(root);
    expect(cfg.rendering.three.exposure).toBe(2);
    expect(cfg.rendering.three.shadows).toBe(DEFAULT_PROJECT_CONFIG.rendering.three.shadows);
    expect(cfg.physics.layers).toEqual(['Default', 'Player']);
    expect(cfg.rendering.pixi.antialias).toBe(DEFAULT_PROJECT_CONFIG.rendering.pixi.antialias);
  });

  it('falls back to defaults on malformed JSON', () => {
    fs.writeFileSync(configPath(), '{ not valid json');
    expect(loadProjectConfig(root)).toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('round-trips through writeProjectConfig', () => {
    const next = { ...DEFAULT_PROJECT_CONFIG, app: { appId: 'com.example.app', appName: 'Example', iconSource: '' } };
    writeProjectConfig(next, root);
    expect(loadProjectConfig(root)).toEqual(next);
  });
});

describe('loadProjectUserConfig', () => {
  it('returns defaults when project.user.json is absent', () => {
    expect(loadProjectUserConfig(root)).toEqual(DEFAULT_PROJECT_USER_CONFIG);
  });

  it('round-trips machine settings through writeProjectUserConfig', () => {
    const next: ProjectUserConfig = {
      device: { iosDeviceId: 'ABC-123', iosDevicectlId: 'DEF-456', androidDeviceId: '192.168.1.5:5555' },
      sdk: { javaHome: '/opt/jdk', androidHome: '/opt/sdk', gcloudPath: '/opt/homebrew/bin/gcloud' },
    };
    writeProjectUserConfig(next, root);
    expect(loadProjectUserConfig(root)).toEqual(next);
  });
});

describe('project-settings split round-trip (mirrors the /api/project-settings handler)', () => {
  // The editor sends ONE merged settings object with the per-machine fields nested
  // under `user`. The POST handler splits it: `user` → project.user.json, the rest
  // → project.config.json. GET re-merges. This test runs that exact split/write and
  // the GET re-merge against real files.
  const splitWriteReload = (mergedSettings: Record<string, unknown>) => {
    const { user: userPart, ...configPart } = mergedSettings;
    writeProjectConfig(mergeProjectConfig(configPart as Parameters<typeof mergeProjectConfig>[0]), root);
    writeProjectUserConfig(mergeProjectUserConfig(userPart as Parameters<typeof mergeProjectUserConfig>[0]), root);
    return { ...loadProjectConfig(root), user: loadProjectUserConfig(root) };
  };

  it('routes machine fields to project.user.json and keeps them out of the committed config', () => {
    const back = splitWriteReload({
      app: { appId: 'com.x.y', appName: 'Y', iconSource: 'resources/icon.png' },
      build: { webBucket: 'gs://b/y' },
      user: { device: { iosDeviceId: 'UDID-1', androidDeviceId: 'serial-2' }, sdk: { javaHome: '/jdk' } },
    });
    // GET view round-trips both halves
    expect(back.app.appId).toBe('com.x.y');
    expect(back.app.iconSource).toBe('resources/icon.png');
    expect(back.build.webBucket).toBe('gs://b/y');
    expect(back.user.device.iosDeviceId).toBe('UDID-1');
    expect(back.user.device.androidDeviceId).toBe('serial-2');
    expect(back.user.sdk.javaHome).toBe('/jdk');

    // The COMMITTED file must not contain any device/sdk value.
    const committedRaw = fs.readFileSync(configPath(), 'utf8');
    expect(committedRaw).not.toContain('UDID-1');
    expect(committedRaw).not.toContain('serial-2');
    expect(committedRaw).not.toContain('/jdk');
    // …and they DO live in the gitignored user file.
    const userRaw = fs.readFileSync(path.join(root, 'project.user.json'), 'utf8');
    expect(userRaw).toContain('UDID-1');
    expect(userRaw).toContain('/jdk');
  });
});

describe('validateBuildConfig', () => {
  const withCfg = (build?: Partial<ProjectConfig['build']>, app?: Partial<ProjectConfig['app']>): ProjectConfig =>
    mergeProjectConfig({ build: { ...DEFAULT_PROJECT_CONFIG.build, ...build }, app: { ...DEFAULT_PROJECT_CONFIG.app, ...app } });
  const withUser = (device?: Partial<ProjectUserConfig['device']>, sdk?: Partial<ProjectUserConfig['sdk']>): ProjectUserConfig =>
    mergeProjectUserConfig({ device: { ...DEFAULT_PROJECT_USER_CONFIG.device, ...device }, sdk: { ...DEFAULT_PROJECT_USER_CONFIG.sdk, ...sdk } });

  it('accepts the default config + user config', () => {
    expect(validateBuildConfig(DEFAULT_PROJECT_CONFIG, DEFAULT_PROJECT_USER_CONFIG)).toEqual([]);
  });

  it('rejects shell metacharacters in interpolated fields (config + user)', () => {
    expect(validateBuildConfig(withCfg({ webBucket: 'gs://x; rm -rf ~' }), DEFAULT_PROJECT_USER_CONFIG).length).toBeGreaterThan(0);
    expect(validateBuildConfig(DEFAULT_PROJECT_CONFIG, withUser(undefined, { javaHome: '/jdk"; touch pwned; "' })).length).toBeGreaterThan(0);
    expect(validateBuildConfig(DEFAULT_PROJECT_CONFIG, withUser({ androidDeviceId: '$(reboot)' })).length).toBeGreaterThan(0);
    expect(validateBuildConfig(withCfg({}, { appId: 'com.x && curl evil' }), DEFAULT_PROJECT_USER_CONFIG).length).toBeGreaterThan(0);
  });

  it('does NOT sanitize the custom deploy command (it is a trusted shell command)', () => {
    expect(validateBuildConfig(withCfg({ webDeployCommand: 'rsync -a {dist}/ host:/var/www && echo done' }), DEFAULT_PROJECT_USER_CONFIG)).toEqual([]);
  });

  it('requires a non-empty appId but allows empty device fields', () => {
    expect(validateBuildConfig(withCfg({}, { appId: '' }), DEFAULT_PROJECT_USER_CONFIG)).toContainEqual(expect.stringContaining('app.appId'));
    expect(validateBuildConfig(DEFAULT_PROJECT_CONFIG, withUser({ androidDeviceId: '', iosDeviceId: '' }))).toEqual([]);
  });

  it('accepts real-world device serials and gs:// buckets', () => {
    expect(validateBuildConfig(
      withCfg({ webBucket: 'gs://modoki-www-site/demo' }),
      withUser(
        { androidDeviceId: '192.168.1.5:5555', iosDeviceId: '00008150-00041CAA3AB8401C' },
        { javaHome: '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home' },
      ),
    )).toEqual([]);
  });

  it('accepts a versioned brew JDK path with @ (openjdk@21 — @ is not a shell metachar)', () => {
    expect(validateBuildConfig(
      DEFAULT_PROJECT_CONFIG,
      withUser(undefined, { javaHome: '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home' }),
    )).toEqual([]);
  });
});
