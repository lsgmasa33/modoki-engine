/** loadProjectConfig tests — verify the file-over-defaults merge and graceful
 *  fallback when project.config.json is absent or malformed, plus the split into
 *  the committed config and the per-machine project.user.json. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import {
  loadProjectConfig,
  writeProjectConfig,
  validateBuildConfig,
  loadProjectUserConfig,
  writeProjectUserConfig,
  readRawProjectConfig,
  readRawProjectUserConfig,
  MalformedProjectConfigError,
  readProjectConfigParseErrors,
  projectConfigUnionErrors,
} from '../../plugins/load-project-config';
import {
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_PROJECT_USER_CONFIG,
  mergeProjectConfig,
  type ProjectConfigIssue,
  mergeProjectUserConfig,
  deepMergeConfigPatch,
  pruneProjectConfig,
  findNullPatchPaths,
  projectConfigIssues,
  type ProjectConfig,
  type ProjectUserConfig,
  type RawProjectConfig,
} from '../../project-config';
import { ENGINE_API_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { getRenderSettings, resetRenderSettings } from '../../packages/modoki/src/runtime/rendering/renderSettings';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'projcfg-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const configPath = () => path.join(root, 'project.config.json');
const userConfigPath = () => path.join(root, 'project.user.json');

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

  it('defaults build.debugBuild to false (release ships no journal/debug menu/eval-capable bridge)', () => {
    // Absent from an existing config → the safe default. A game opts in explicitly.
    expect(loadProjectConfig(root).build.debugBuild).toBe(false);
    fs.writeFileSync(configPath(), JSON.stringify({ build: { debugBuild: true } }));
    expect(loadProjectConfig(root).build.debugBuild).toBe(true);
  });

  it('silently resolves debugBuild to false when only the pre-consolidation legacy keys are ' +
     'present (enableDebugMenu/debugBridge/enableJournal) — REGRESSION: games/ota-test shipped ' +
     'with exactly this config (missed the 7c781a61 flag-consolidation migration) and had its ' +
     'debug menu + game-debug MCP silently disabled on-device until this was caught. The plain ' +
     'shallow-spread merge has no back-compat fallback for these keys, so this is the CURRENT, ' +
     'pinned behavior (a project.config.json must be migrated to `debugBuild`, not just carry the ' +
     'old keys) — not a fix. If this test starts failing because a back-compat shim was added, ' +
     'that is an intentional, welcome change; update this test to match.', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      build: { enableDebugMenu: true, debugBridge: true, enableJournal: false },
    }));
    expect(loadProjectConfig(root).build.debugBuild).toBe(false);
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

describe('deepMergeConfigPatch (the WRITE-time merge — patch onto disk, not onto defaults)', () => {
  it('leaves sections the patch omits exactly as they were', () => {
    const disk = { app: { appId: 'a', appName: 'b' }, build: { debugBuild: true } };
    const out = deepMergeConfigPatch(disk, { build: { appleTeamId: 'X' } });
    expect(out).toEqual({ app: { appId: 'a', appName: 'b' }, build: { debugBuild: true, appleTeamId: 'X' } });
  });

  it('replaces arrays wholesale — never concatenates or index-merges', () => {
    // Otherwise you could never REMOVE a scene or a physics layer.
    const disk = { content: { scenes: ['a', 'b', 'c'] }, physics: { layers: ['Default', 'Player'] } };
    const out = deepMergeConfigPatch(disk, { content: { scenes: ['only'] } }) as typeof disk;
    expect(out.content.scenes).toEqual(['only']);
    expect(out.physics.layers).toEqual(['Default', 'Player']);
  });

  it('a key PRESENT in the patch wins even when falsy — "" / false / 0 clear a field', () => {
    const disk = { build: { appleTeamId: 'KQ6FQ2BS8H', debugBuild: true, playableMaxBytes: 99 } };
    const out = deepMergeConfigPatch(disk, { build: { appleTeamId: '', debugBuild: false, playableMaxBytes: 0 } });
    expect(out).toEqual({ build: { appleTeamId: '', debugBuild: false, playableMaxBytes: 0 } });
  });

  it('treats `undefined` as absent (a hand-built body must not blank a field by accident)', () => {
    expect(deepMergeConfigPatch({ app: { appId: 'a' } }, { app: { appId: undefined } })).toEqual({ app: { appId: 'a' } });
  });

  it('ignores __proto__ / constructor / prototype keys instead of reparenting the result', () => {
    // JSON.parse produces these as OWN properties, so a POST body can carry them, and
    // `out.__proto__ = v` would reparent the object rather than add a key — the value
    // then vanishes from the written JSON with no error.
    const out = deepMergeConfigPatch({ app: { appId: 'a' } }, JSON.parse('{"__proto__":{"polluted":1},"app":{"appId":"z"}}'));
    expect(out).toEqual({ app: { appId: 'z' } });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not mutate the base object', () => {
    const disk = { app: { appId: 'a' } };
    deepMergeConfigPatch(disk, { app: { appId: 'z' }, build: { debugBuild: true } });
    expect(disk).toEqual({ app: { appId: 'a' } });
  });
});

describe('findNullPatchPaths / readRaw* (a write must not silently destroy what it could not read)', () => {
  it('reports every null in a patch, by dot-path, at any depth', () => {
    expect(findNullPatchPaths({ app: { appName: null }, build: { modules: { npr: null }, debugBuild: false } }))
      .toEqual(['app.appName', 'build.modules.npr']);
    expect(findNullPatchPaths({ app: { appName: '' }, build: { debugBuild: false } })).toEqual([]);
  });

  it('descends into ARRAYS too — a null cannot hide inside content.scenes / physics.layers', () => {
    // Object-only recursion left the guard bypassable by wrapping the null in a list.
    expect(findNullPatchPaths({ physics: { layers: ['Default', null] } })).toEqual(['physics.layers.1']);
    expect(findNullPatchPaths({ content: { scenes: [{ guid: 'g', include: null }] } }))
      .toEqual(['content.scenes.0.include']);
  });

  it('readRawProjectConfig returns the UNMERGED file (no defaults folded in)', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ app: { appName: 'Only This' } }));
    expect(readRawProjectConfig(root)).toEqual({ app: { appName: 'Only This' } });
  });

  it('a MISSING file is {} — a project that never had one', () => {
    expect(readRawProjectConfig(root)).toEqual({});
    expect(readRawProjectUserConfig(root)).toEqual({});
  });

  it('a file that EXISTS but is malformed throws, so a patch cannot overwrite it', () => {
    // loadProjectConfig deliberately falls back to defaults here (right for reading);
    // the raw read is the base a WRITE merges onto, where the same fallback would
    // replace the author's whole config with the section they were editing.
    fs.writeFileSync(configPath(), '{ "app": { "appId": "com.real.app" }, BROKEN');
    expect(() => readRawProjectConfig(root)).toThrow(MalformedProjectConfigError);
    expect(loadProjectConfig(root)).toEqual(DEFAULT_PROJECT_CONFIG); // reader still forgiving
  });

  it('a valid JSON file whose top level is not an object also throws', () => {
    fs.writeFileSync(configPath(), '[1,2,3]');
    expect(() => readRawProjectConfig(root)).toThrow(MalformedProjectConfigError);
  });

  it('readProjectConfigParseErrors names the unreadable files, and is empty when there are none', () => {
    // The read path's fallback is right but silent, so a caller that only READS
    // (the Project Settings dialog) had no way to know its values were defaults.
    expect(readProjectConfigParseErrors(root)).toEqual([]);          // both absent = fine
    fs.writeFileSync(configPath(), '{ BROKEN');
    fs.writeFileSync(userConfigPath(), 'nope');
    expect(readProjectConfigParseErrors(root).map((e) => e.file))
      .toEqual(['project.config.json', 'project.user.json']);
    expect(readProjectConfigParseErrors(root)[0].message).toMatch(/not valid JSON/);
  });
});

describe('pruneProjectConfig (the file stays MINIMAL — only what the project chose)', () => {
  const prune = (onDisk: RawProjectConfig) =>
    pruneProjectConfig(mergeProjectConfig(onDisk as never) as never, onDisk, DEFAULT_PROJECT_CONFIG as never);

  it('drops a default-valued key the file never had', () => {
    const out = prune({ app: { appName: 'Court' } }) as { build?: Record<string, unknown> };
    // The whole build section matched defaults and was never on disk → not emitted.
    expect(out.build).toBeUndefined();
  });

  it('KEEPS a default-valued key that was already on disk (records deliberate intent, quiet diffs)', () => {
    const out = prune({ build: { debugBuild: false } }) as { build: Record<string, unknown> };
    expect(out.build).toEqual({ debugBuild: false });
  });

  it('never INTRODUCES the demo deploy bucket into a project that never had it — the exact bug', () => {
    // Writing the RESOLVED config handed games/court `webDeployMode:"gcs"` +
    // `webBucket:"gs://modoki-www-site/demo"`, i.e. an internal game pointed at the demo bucket.
    const raw = JSON.stringify(prune({ app: { appId: 'com.modokiengine.court', appName: 'Court' } }));
    expect(raw).not.toContain('gs://modoki-www-site/demo');
    expect(raw).not.toContain('gcs');
  });

  it('emits a non-default value even when the file never had the key', () => {
    const out = prune({ build: { appleTeamId: 'KQ6FQ2BS8H' } }) as { build: Record<string, unknown> };
    expect(out.build.appleTeamId).toBe('KQ6FQ2BS8H');
  });

  it('INVARIANT: pruning never changes what the project resolves to', () => {
    // The one assertion that catches every prune bug in one line.
    for (const onDisk of [
      {},
      { app: { appName: 'Court' } },
      { build: { debugBuild: false, appleTeamId: 'KQ6FQ2BS8H' } },
      { rendering: { three: { exposure: 2 }, web: { sizeMode: 'fixed', width: 900 } } },
      { physics: { layers: ['Default', 'Player'], collisionMatrix: [0xffff, 0xffff] } },
      { postprocessors: { island: { recipeVersion: 3, file: 'runtime/pp.ts' } } },
      { content: { scenes: [] }, ota: { enabled: true, bundleName: 'x' } },
      DEFAULT_PROJECT_CONFIG as unknown as RawProjectConfig,
    ]) {
      const resolved = mergeProjectConfig(onDisk as never);
      const pruned = pruneProjectConfig(resolved as never, onDisk, DEFAULT_PROJECT_CONFIG as never);
      expect(mergeProjectConfig(pruned as never), JSON.stringify(onDisk)).toEqual(resolved);
    }
  });
});

describe('project-settings split round-trip (mirrors the /api/project-settings handler)', () => {
  // The editor sends ONE merged settings object with the per-machine fields nested
  // under `user`. The POST handler splits it: `user` → project.user.json, the rest
  // → project.config.json. GET re-merges. This test runs that exact split/write and
  // the GET re-merge against real files.
  const splitWriteReload = (mergedSettings: Record<string, unknown>) => {
    const { user: userPart, ...configPart } = mergedSettings;
    const prevRaw = readRawProjectConfig(root);
    const prevRawUser = readRawProjectUserConfig(root);
    const nextRaw = deepMergeConfigPatch(prevRaw, configPart);
    const nextRawUser = deepMergeConfigPatch(prevRawUser, (userPart ?? {}) as Record<string, unknown>);
    // `coerceUnions:false` mirrors the handler — the write path must round-trip an
    // out-of-union value rather than normalize it (see the union tests below).
    writeProjectConfig(
      pruneProjectConfig(mergeProjectConfig(nextRaw, { coerceUnions: false }) as never, prevRaw, DEFAULT_PROJECT_CONFIG as never),
      root,
    );
    writeProjectUserConfig(
      pruneProjectConfig(mergeProjectUserConfig(nextRawUser) as never, prevRawUser, DEFAULT_PROJECT_USER_CONFIG as never),
      root,
    );
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

  it('does NOT rewrite an out-of-union value when an UNRELATED section is saved', () => {
    // The read path coerces `"portrait"` → `free` so the engine renders something a
    // consumer handles. The WRITE path must not: Apply on an unrelated field would
    // otherwise silently normalize a value the author never touched — and that value
    // is evidence of intent (it is how #25 was diagnosed as "sling means portrait").
    fs.writeFileSync(configPath(), JSON.stringify({
      app: { appId: 'com.x.y', appName: 'Y' },
      rendering: { web: { sizeMode: 'portrait', width: 1080, height: 1920 } },
    }, null, 2));

    const back = splitWriteReload({ app: { appId: 'com.x.z', appName: 'Z' } });

    // The file kept the author's word …
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    expect(raw.rendering.web).toEqual({ sizeMode: 'portrait', width: 1080, height: 1920 });
    expect(raw.app.appId).toBe('com.x.z'); // …and the edit that WAS made landed.
    // … while the resolved (read) view is still the safe fallback.
    expect(back.rendering.web.sizeMode).toBe('free');
  });

  it('DOES write a new value when that field is the one being edited', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      rendering: { web: { sizeMode: 'portrait', width: 1080, height: 1920 } },
    }, null, 2));

    splitWriteReload({ rendering: { web: { sizeMode: 'fixed' } } });

    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    expect(raw.rendering.web.sizeMode).toBe('fixed');
    expect(raw.rendering.web.width).toBe(1080); // neighbours survive the patch
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

describe('DEFAULT_PROJECT_CONFIG.rendering / engine renderSettings agreement', () => {
  it('the project-config defaults equal the engine registry defaults', () => {
    // THIRD copy of the same literal (the other two are inside renderSettings.ts and
    // are now deduped). They must agree: a project that records nothing renders via
    // the engine's baked-in defaults, while Project Settings shows the project-config
    // ones — drift means the dialog describes a render nobody is doing. Same
    // import-free rationale as the engineApi pin below: project-config.ts is browser
    // -pure and cannot import the engine, so the check lives here.
    resetRenderSettings();
    expect(getRenderSettings()).toEqual({
      three: DEFAULT_PROJECT_CONFIG.rendering.three,
      pixi: DEFAULT_PROJECT_CONFIG.rendering.pixi,
      web: DEFAULT_PROJECT_CONFIG.rendering.web,
    });
  });

  it('resetRenderSettings hands back a fresh object each time (no shared baseline)', () => {
    resetRenderSettings();
    getRenderSettings().web.width = 1; // a caller mutating the live settings…
    resetRenderSettings();
    expect(getRenderSettings().web.width).toBe(DEFAULT_PROJECT_CONFIG.rendering.web.width); // …can't poison the baseline
  });
});

describe('ota.engineApi / ENGINE_API_VERSION agreement', () => {
  it('default ota.engineApi equals the runtime ENGINE_API_VERSION constant', () => {
    // project-config.ts is deliberately import-free (browser type graph), so this pin
    // lives here instead of a shared import — see the engineApi doc comment.
    expect(DEFAULT_PROJECT_CONFIG.ota.engineApi).toBe(ENGINE_API_VERSION);
  });
});

describe('string-union fields are validated, not passed through (#25)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('falls back to the default and WARNS on an out-of-union sizeMode', () => {
    // The real regression: games/sling carried `"portrait"` (the native
    // capacitor.orientation vocabulary), which every consumer's `!== 'fixed'` /
    // `!== 'max'` guard silently treated as `free`.
    const cfg = mergeProjectConfig({ rendering: { web: { sizeMode: 'portrait', width: 1080, height: 1920 } } } as unknown as Partial<ProjectConfig>);
    expect(cfg.rendering.web.sizeMode).toBe('free');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rendering.web.sizeMode'));
    // The neighbouring numbers are untouched — only the bad field is coerced.
    expect(cfg.rendering.web).toMatchObject({ width: 1080, height: 1920 });
  });

  it('passes every valid sizeMode through untouched and silently', () => {
    for (const mode of ['free', 'fixed', 'max'] as const) {
      expect(mergeProjectConfig({ rendering: { web: { sizeMode: mode, width: 1, height: 2 } } } as Partial<ProjectConfig>)
        .rendering.web.sizeMode).toBe(mode);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies the same rule to the three/pixi GPU backends', () => {
    const cfg = mergeProjectConfig({ rendering: { three: { backend: 'vulkan' }, pixi: { backend: 'metal' } } } as unknown as Partial<ProjectConfig>);
    expect(cfg.rendering.three.backend).toBe(DEFAULT_PROJECT_CONFIG.rendering.three.backend);
    expect(cfg.rendering.pixi.backend).toBe(DEFAULT_PROJECT_CONFIG.rendering.pixi.backend);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('an absent field is the default with NO warning (absent is not invalid)', () => {
    expect(mergeProjectConfig({ rendering: { web: { width: 800 } } } as Partial<ProjectConfig>).rendering.web.sizeMode)
      .toBe(DEFAULT_PROJECT_CONFIG.rendering.web.sizeMode);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('projectConfigIssues — what the coercion silently substituted', () => {
  it('reports the offending path, the file value, and what is being used instead', () => {
    const issues = projectConfigIssues({
      rendering: { web: { sizeMode: 'portrait', width: 1080, height: 1920 } },
    } as unknown as Partial<ProjectConfig>);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: 'rendering.web.sizeMode',
      value: 'portrait',
      allowed: ['free', 'fixed', 'max'],
      using: 'free',
    });
    expect(issues[0].message).toContain('"portrait"');
    expect(issues[0].message).toContain('"free"'); // names the substitute, not just the fault
  });

  it('is empty for a clean config, and for one that simply omits the field', () => {
    expect(projectConfigIssues({ rendering: { web: { sizeMode: 'fixed', width: 9, height: 16 } } } as Partial<ProjectConfig>)).toEqual([]);
    expect(projectConfigIssues({})).toEqual([]);
    expect(projectConfigIssues(null)).toEqual([]);
  });

  it('collects EVERY offending field, not just the first', () => {
    const issues = projectConfigIssues({
      rendering: { web: { sizeMode: 'portrait' }, three: { backend: 'vulkan' }, pixi: { backend: 'metal' } },
    } as unknown as Partial<ProjectConfig>);
    expect(issues.map((i) => i.path)).toEqual([
      'rendering.three.backend', 'rendering.pixi.backend', 'rendering.web.sizeMode',
    ]);
  });

  it('does NOT also console.warn when a collector is passed (one report, not two)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      projectConfigIssues({ rendering: { web: { sizeMode: 'portrait' } } } as unknown as Partial<ProjectConfig>);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('every committed project.config.json uses in-union values', () => {
  // The coercion above keeps a typo'd project OPENABLE; this keeps the repo's own
  // projects CORRECT. Without it a bad value is merely downgraded to a silent
  // default, which is how `"portrait"` survived in games/sling for months.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const projects = discoverProjects(repoRoot)
    .map((p) => ({ ...p, file: path.join(p.dir, 'project.config.json') }))
    .filter((p) => fs.existsSync(p.file));

  it('found projects to check', () => {
    expect(projects.length).toBeGreaterThan(0);
  });

  // Resolved with an ISSUE COLLECTOR rather than a hand-listed set of checks (#39). The old form
  // named three fields and restated their legal values inline — a third copy of each union, and
  // blind to every field it did not happen to list (which was all of capacitor.*, build.* and
  // toneMapping). Resolving covers whatever `mergeProjectConfig` validates, so a union added
  // later is guarded here the day it is added, with nothing to keep in sync.
  //
  // This is the same computation the BUILD now refuses on (`projectConfigUnionErrors`), so a
  // green run here means every committed project still builds.
  it.each(projects.map((p) => [`${p.root}/${p.name}`, p.file] as const))('%s', (_id, file) => {
    const issues: ProjectConfigIssue[] = [];
    mergeProjectConfig(JSON.parse(fs.readFileSync(file, 'utf8')) as RawProjectConfig as never, { issues });
    expect(issues.map((i) => i.message)).toEqual([]);
  });
});

describe('projectConfigUnionErrors — the BUILD refusal (#39)', () => {
  it('reports an out-of-union value, naming the field, the value and the legal set', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ capacitor: { orientation: 'Portrait' } }));
    const errors = projectConfigUnionErrors(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('capacitor.orientation');
    expect(errors[0]).toContain('"Portrait"');
    // The legal set is the actionable half — an error that only says "invalid" makes the
    // reader go and find the union themselves.
    expect(errors[0]).toContain('"portrait"');
    expect(errors[0]).toContain('"landscape"');
  });

  it('reports EVERY bad field, not just the first', () => {
    fs.writeFileSync(configPath(), JSON.stringify({
      capacitor: { orientation: 'Portrait', keyboardResize: 'Body' },
      build: { webDeployMode: 'GCS' },
    }));
    const paths = projectConfigUnionErrors(root);
    expect(paths).toHaveLength(3);
    // One build attempt should surface all of them — fixing them one build at a time is the
    // friction that makes a loud gate feel punitive.
    expect(paths.join('\n')).toContain('capacitor.keyboardResize');
    expect(paths.join('\n')).toContain('build.webDeployMode');
  });

  it('is silent for a valid config, a missing file, and an unparseable file', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ capacitor: { orientation: 'portrait' } }));
    expect(projectConfigUnionErrors(root)).toEqual([]);
    fs.rmSync(configPath());
    expect(projectConfigUnionErrors(root)).toEqual([]);
    // A malformed file belongs to readProjectConfigParseErrors, which reports it with better
    // wording; duplicating it here would give the same problem two different error messages.
    fs.writeFileSync(configPath(), '{ not json');
    expect(projectConfigUnionErrors(root)).toEqual([]);
  });

  it('does NOT block on a value that merely differs from the default', () => {
    // The gate is about ILLEGAL values, not unusual ones. A project legitimately choosing
    // landscape must build.
    fs.writeFileSync(configPath(), JSON.stringify({ capacitor: { orientation: 'landscape' }, build: { webDeployMode: 'none' } }));
    expect(projectConfigUnionErrors(root)).toEqual([]);
  });
});
