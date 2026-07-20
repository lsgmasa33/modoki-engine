/**
 * Tests for vite-asset-scanner pure functions: findAssetRoots, resolveAssetPath.
 * The Vite plugin/middleware parts are not testable without a Vite server,
 * but the path resolution and root discovery logic can be tested directly.
 *
 * findAssetRoots uses the real filesystem (it reads the project tree),
 * so we test it against the actual project layout. resolveAssetPath is
 * fully pure and tested with synthetic roots.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsSync from 'node:fs';
import pathMod from 'node:path';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  findAssetRoots, resolveAssetPath, readAssetGuid, buildManifest, writeAssetGuid, detectType,
  classifySceneChange, isSseRoute, createEditorWriteGuard, createBrowserRequestRegistry,
  handleExitRequest, scanAllAssets, resolveModokiAssetsDir, filterKeptAssets, gamesModuleSource,
  isUnderAssetRoot,
  isValidBuildPlatform, BUILD_PLATFORMS, playableBuildSteps,
  type AssetRoot,
} from '../../plugins/vite-asset-scanner';
import { findGamesEntry } from '../../plugins/findGamesEntry';

// engine/tests/plugins/ → repo root (games/ + engine/packages/modoki live there).
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
// Skip the game-directory-discovery cases when games/ is absent (engine-only OSS repo).
// docs/plans/engine-oss-public-repo.md.
const hasGames = fs.existsSync(path.join(PROJECT_ROOT, 'games'));

describe('detectType', () => {
  it('classifies a .shader.json as a shader asset', () => {
    expect(detectType('/games/x/assets/shaders/holo.shader.json', '.json')).toBe('shader');
  });
  it('does not list raw .wgsl/.glsl bodies as assets', () => {
    expect(detectType('/games/x/assets/shaders/holo.wgsl', '.wgsl')).toBeNull();
    expect(detectType('/games/x/assets/shaders/holo.glsl', '.glsl')).toBeNull();
  });
  it('still classifies materials and meshes', () => {
    expect(detectType('/m/cube.mat.json', '.json')).toBe('material');
    expect(detectType('/m/cube.mesh.json', '.json')).toBe('mesh');
  });
  it('classifies a .atlas.json as an atlas asset (not a scene)', () => {
    expect(detectType('/games/x/assets/sprites/pack.atlas.json', '.json')).toBe('atlas');
  });
  it('classifies a .spriteanim.json as a spriteanim asset (not a scene)', () => {
    expect(detectType('/games/x/assets/anims/hero.spriteanim.json', '.json')).toBe('spriteanim');
  });
  // The catch-all that classifySceneChange must defend against: ANY uncategorized
  // .json under an asset root is labeled 'scene'.
  it("catch-all labels an uncategorized .json as 'scene'", () => {
    expect(detectType('/games/x/assets/config/settings.json', '.json')).toBe('scene');
  });
  it('classifies a .hdr as an environment asset', () => {
    expect(detectType('/games/x/assets/env/studio.hdr', '.hdr')).toBe('environment');
  });
  it('EXCLUDES a committed ~ultrahdr.jpg variant (a derived file, not a texture)', () => {
    expect(detectType('/games/x/assets/env/studio.hdr~ultrahdr.jpg', '.jpg')).toBeNull();
    // …but a normal .jpg is still a texture.
    expect(detectType('/games/x/assets/img/photo.jpg', '.jpg')).toBe('texture');
  });
});

describe('gamesModuleSource (virtual:modoki-games — Windows separator safety)', () => {
  // Regression: entry.path is OS-native, so on Windows it's C:\…\game.ts. JSON.stringify
  // ESCAPES backslashes rather than converting them, so a bare embed emitted an
  // `import { game } from "C:\\…\\game"` specifier Vite/Rollup couldn't resolve — the
  // Windows editor's web/native build (and baked game module) broke. Assert the fix from
  // macOS/Linux CI by feeding a Windows path.
  it('forward-slashes a Windows game.ts path in the import specifier', () => {
    const src = gamesModuleSource({ kind: 'single', path: 'C:\\Users\\shois\\proj\\game.ts' });
    expect(src).toContain('import { game } from "C:/Users/shois/proj/game"');
    expect(src).not.toContain('\\'); // no backslash survives into the emitted module
  });
  it('leaves a POSIX path clean and strips the extension', () => {
    const src = gamesModuleSource({ kind: 'single', path: '/home/x/proj/game.tsx' });
    expect(src).toContain('import { game } from "/home/x/proj/game"');
  });
  it('emits empty sets when there is no single game entry', () => {
    const src = gamesModuleSource(null);
    expect(src).toContain('export const ALL_GAMES = [];');
    expect(src).not.toContain('import');
  });
});

describe('isUnderAssetRoot (Cmd+S full-reload — Windows separator safety)', () => {
  // Regression: Vite normalizes an HMR ctx.file to POSIX (forward slashes), but AssetRoot.absDir
  // comes from path.join → BACKSLASHES on Windows. The old `ctx.file.startsWith(r.absDir)` therefore
  // never matched on Windows, so handleHotUpdate failed to return [] (suppress HMR) and every scene
  // Cmd+S bubbled a hot-update to the root App → the WHOLE editor reloaded. Both sides must be
  // separator-normalized. These cases feed the exact Windows shapes that broke, verified from CI.
  const winRoots: AssetRoot[] = [
    { urlPrefix: '/games/sling/assets', absDir: 'C:\\Users\\dev\\modoki\\games\\sling\\runtime\\assets' },
  ];
  it('matches a POSIX-normalized ctx.file against a backslash absDir (the Windows bug)', () => {
    // Vite hands handleHotUpdate this forward-slash form even on Windows.
    expect(isUnderAssetRoot('C:/Users/dev/modoki/games/sling/runtime/assets/scenes/main.json', winRoots)).toBe(true);
  });
  it('matches when both sides use backslashes (the chokidar watcher path)', () => {
    expect(isUnderAssetRoot('C:\\Users\\dev\\modoki\\games\\sling\\runtime\\assets\\scenes\\main.json', winRoots)).toBe(true);
  });
  it('does NOT match a file outside the root', () => {
    expect(isUnderAssetRoot('C:/Users/dev/modoki/engine/app/App.tsx', winRoots)).toBe(false);
  });
  it('does NOT match a prefix-sharing sibling dir (<root>-evil)', () => {
    expect(isUnderAssetRoot('C:/Users/dev/modoki/games/sling/runtime/assets-evil/x.json', winRoots)).toBe(false);
  });
  it('works on POSIX roots too (both forward-slash — the macOS/Linux path)', () => {
    const posixRoots: AssetRoot[] = [{ urlPrefix: '/assets', absDir: '/home/dev/proj/runtime/assets' }];
    expect(isUnderAssetRoot('/home/dev/proj/runtime/assets/scenes/main.json', posixRoots)).toBe(true);
    expect(isUnderAssetRoot('/home/dev/proj/runtime/assets', posixRoots)).toBe(true); // the root itself
    expect(isUnderAssetRoot('/home/dev/proj/other/x.json', posixRoots)).toBe(false);
  });
});

describe('classifySceneChange (hot-reload broadcast classification)', () => {
  // The regression the onChange inline comment warns about: detectType's catch-all
  // would bounce the live scene on any unrelated .json edit, so a 'scene' verdict
  // is gated by the /scenes/ convention; 'prefab' always broadcasts.
  it("broadcasts a .json under /scenes/ as 'scene'", () => {
    expect(classifySceneChange('/games/x/assets/scenes/level1.json')).toBe('scene');
  });
  it("broadcasts a top-level scene.json as 'scene'", () => {
    expect(classifySceneChange('/games/x/assets/scene.json')).toBe('scene');
  });
  it("broadcasts a .prefab.json as 'prefab' regardless of folder", () => {
    expect(classifySceneChange('/games/x/assets/prefabs/ship.prefab.json')).toBe('prefab');
  });
  it('does NOT broadcast an uncategorized .json outside /scenes/ (the catch-all trap)', () => {
    // detectType says 'scene' (catch-all), but it's not under /scenes/ → no bounce.
    expect(detectType('/games/x/assets/config/settings.json', '.json')).toBe('scene');
    expect(classifySceneChange('/games/x/assets/config/settings.json')).toBeNull();
  });
  it('does NOT broadcast typed sibling assets (.mat/.mesh/.particle.json)', () => {
    expect(classifySceneChange('/games/x/assets/materials/metal.mat.json')).toBeNull();
    expect(classifySceneChange('/games/x/assets/models/cube.mesh.json')).toBeNull();
    expect(classifySceneChange('/games/x/assets/fx/spark.particle.json')).toBeNull();
  });
});

describe('isSseRoute (catch-all exclusion)', () => {
  const SSE = ['/api/build', '/api/add-native-target'];
  it('matches the bare SSE route', () => {
    expect(isSseRoute('/api/build', SSE)).toBe(true);
    expect(isSseRoute('/api/add-native-target', SSE)).toBe(true);
  });
  it('matches an SSE route carrying a query string', () => {
    expect(isSseRoute('/api/build?project=games/3d-test&target=ios', SSE)).toBe(true);
  });
  it('does NOT prefix-match a sibling route (the /api/build-status trap)', () => {
    expect(isSseRoute('/api/build-status', SSE)).toBe(false);
  });
  it('routes /api/build?platform=playable (Feature A) + rejects junk', () => {
    // The routing acceptance the guard uses. playable joins the native + web targets.
    expect(BUILD_PLATFORMS).toContain('playable');
    for (const p of ['ios', 'android', 'web', 'playable']) expect(isValidBuildPlatform(p)).toBe(true);
    for (const p of ['', 'PLAYABLE', 'desktop', 'ad', null, undefined]) expect(isValidBuildPlatform(p)).toBe(false);
  });

  it('playableBuildSteps: VITE_PLAYABLE=1 single-file build then reveal ads/ (no deploy)', () => {
    const steps = playableBuildSteps('/repo', '/repo/games/space-invader');
    expect(steps).toHaveLength(2);
    // Step 1 = the inliner build, steered by VITE_PLAYABLE=1, run from the editor root.
    expect(steps[0]).toMatchObject({ cmd: 'node engine/scripts/build-web.mjs', env: { VITE_PLAYABLE: '1' }, cwd: '/repo' });
    // Step 2 = reveal the project's ads/ dir (posix `open`, win `start`) — NO favicon/deploy step.
    // The SUT joins the path with the host's `path.join`, so on Windows both fields carry
    // backslashes (`winCmd` = `start "" "C:\…\ads"`, the correct Windows form actually executed;
    // `cmd` = `open "\\…"` where JSON.stringify doubles the backslash for shell-quoting — but `cmd`
    // is macOS-only-consumed). Collapse any run of / or \ to one `/` so the SEMANTIC path is
    // asserted regardless of host separator or JSON escaping.
    const normSep = (s: string | undefined) => (s ?? '').replace(/[\\/]+/g, '/');
    expect(normSep(steps[1].cmd)).toContain('/repo/games/space-invader/ads');
    expect(normSep(steps[1].winCmd)).toContain('games/space-invader/ads');
    expect(steps.some((s) => /favicon|gcloud|rsync|deploy/i.test(s.cmd))).toBe(false);
  });

  it('does not match unrelated /api routes (they flow through the backend dispatch)', () => {
    expect(isSseRoute('/api/scene-state', SSE)).toBe(false);
    expect(isSseRoute('/api/exit', SSE)).toBe(false);
  });
});

describe('createEditorWriteGuard (self-write TTL)', () => {
  // mark() schedules a self-cleaning setTimeout; fake timers keep it from leaking
  // a real ~1.6s handle past the test (the TTL logic itself uses the injected clock).
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports a write within the TTL, false after it expires', () => {
    let t = 1000;
    const { mark, isWrite } = createEditorWriteGuard(1500, () => t);
    mark('/p/scene.json');
    expect(isWrite('/p/scene.json')).toBe(true);   // t=1000, exp=2500
    t = 2499;
    expect(isWrite('/p/scene.json')).toBe(true);   // still inside TTL
    t = 2501;
    expect(isWrite('/p/scene.json')).toBe(false);  // past expiry
  });
  it('treats every read within the TTL as a write (no delete-on-read — covers the chokidar burst)', () => {
    const t = 0;
    const { mark, isWrite } = createEditorWriteGuard(1500, () => t);
    mark('/p/a.json');
    // chokidar fires add+change+rename for one save — all must read true.
    expect(isWrite('/p/a.json')).toBe(true);
    expect(isWrite('/p/a.json')).toBe(true);
    expect(isWrite('/p/a.json')).toBe(true);
  });
  it('a second mark extends the window for the same file', () => {
    let t = 0;
    const { mark, isWrite } = createEditorWriteGuard(1500, () => t);
    mark('/p/a.json');          // exp 1500
    t = 1400;
    mark('/p/a.json');          // exp 2900 — extended
    t = 1600;
    expect(isWrite('/p/a.json')).toBe(true); // would be expired under the first mark
    t = 2901;
    expect(isWrite('/p/a.json')).toBe(false);
  });
  it('an unmarked (external) write is never reported as a self-write', () => {
    const { isWrite } = createEditorWriteGuard(1500, () => 0);
    expect(isWrite('/p/external.json')).toBe(false);
  });

  // F9: a rename event that lands AFTER the fixed TTL is still our own save while
  // the on-disk bytes equal what we wrote — the content fingerprint closes the gap.
  it('recognizes a post-TTL self-write while the content fingerprint still matches', () => {
    let t = 1000;
    const { mark, isWrite } = createEditorWriteGuard(1500, () => t);
    mark('/p/scene.json', 'hashA'); // exp 2500, fingerprinted
    t = 3000; // past the TTL — the old behavior would BOUNCE here
    expect(isWrite('/p/scene.json', () => 'hashA')).toBe(true);  // bytes unchanged → still ours
  });

  it('reloads (false) once the bytes diverge from the fingerprint, and evicts the entry', () => {
    let t = 1000;
    const { mark, isWrite } = createEditorWriteGuard(1500, () => t);
    mark('/p/scene.json', 'hashA');
    t = 3000;
    // an external edit changed the bytes → no longer a self-write → reload.
    expect(isWrite('/p/scene.json', () => 'hashB')).toBe(false);
    // entry evicted on divergence: even re-presenting the original hash won't re-guard.
    expect(isWrite('/p/scene.json', () => 'hashA')).toBe(false);
  });

  it('within the TTL the fast path wins without reading content (no hash needed)', () => {
    const t = 0;
    const { mark, isWrite } = createEditorWriteGuard(1500, () => t);
    mark('/p/a.json', 'hashA');
    let hashed = false;
    expect(isWrite('/p/a.json', () => { hashed = true; return 'whatever'; })).toBe(true);
    expect(hashed).toBe(false); // TTL fast path short-circuits before hashing
  });
});

describe('createBrowserRequestRegistry (requestBrowser lifecycle)', () => {
  /** Manual timer harness — captures armed timeouts so a test can fire them on demand
   *  and assert clear() was called exactly when the request settles (no leaked timer). */
  function manualTimers() {
    let h = 0;
    const armed = new Map<number, () => void>();
    const cleared: number[] = [];
    const set = (fn: () => void) => { const id = ++h; armed.set(id, fn); return id; };
    const clear = (id: unknown) => { armed.delete(id as number); cleared.push(id as number); };
    const fire = (id: number) => { const fn = armed.get(id); armed.delete(id); fn?.(); };
    return { set, clear, fire, armed, cleared };
  }

  it('resolves a pending request when its reply settles, clearing the timer', async () => {
    const t = manualTimers();
    const reg = createBrowserRequestRegistry(t);
    let sentId = -1;
    const p = reg.request((id) => { sentId = id; }, 3000);
    expect(reg.size).toBe(1);

    reg.settle(sentId, { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
    expect(reg.size).toBe(0);
    expect(t.cleared).toContain(1);   // timer cleared on settle (not leaked to timeout)
    expect(t.armed.size).toBe(0);
  });

  it('rejects with the error string when the reply carries one', async () => {
    const t = manualTimers();
    const reg = createBrowserRequestRegistry(t);
    let sentId = -1;
    const p = reg.request((id) => { sentId = id; }, 3000);
    reg.settle(sentId, undefined, 'scene not found');
    await expect(p).rejects.toThrow('scene not found');
    expect(reg.size).toBe(0);
  });

  it('rejects + cleans up when the timeout fires (no app open)', async () => {
    const t = manualTimers();
    const reg = createBrowserRequestRegistry(t);
    const p = reg.request(() => { /* sent, never answered */ }, 3000);
    const rejected = expect(p).rejects.toThrow(/timed out waiting for the browser/);
    t.fire(1);                        // simulate the timeout
    await rejected;
    expect(reg.size).toBe(0);
  });

  it('rejects + clears the timer immediately when send throws (socket mid-teardown)', async () => {
    const t = manualTimers();
    const reg = createBrowserRequestRegistry(t);
    const p = reg.request(() => { throw new Error('ws gone'); }, 3000);
    await expect(p).rejects.toThrow('ws gone');
    expect(reg.size).toBe(0);
    expect(t.cleared).toContain(1);   // timer NOT leaked until timeout
    expect(t.armed.size).toBe(0);
  });

  it('settle on an unknown / already-settled id is a no-op (no double-reject)', async () => {
    const t = manualTimers();
    const reg = createBrowserRequestRegistry(t);
    let sentId = -1;
    const p = reg.request((id) => { sentId = id; }, 3000);
    expect(reg.settle(999)).toBe(false);            // unknown id
    expect(reg.settle(sentId, 'first')).toBe(true);
    expect(reg.settle(sentId, 'second')).toBe(false); // already settled — ignored
    await expect(p).resolves.toBe('first');
  });

  it('hands out monotonically increasing ids across concurrent requests', () => {
    const t = manualTimers();
    const reg = createBrowserRequestRegistry(t);
    const ids: number[] = [];
    reg.request((id) => ids.push(id), 3000);
    reg.request((id) => ids.push(id), 3000);
    reg.request((id) => ids.push(id), 3000);
    expect(ids).toEqual([1, 2, 3]);
    expect(reg.size).toBe(3);
  });
});

describe('handleExitRequest (/api/exit)', () => {
  /** A minimal ServerResponse stand-in capturing the header + body writes. */
  function fakeRes() {
    const headers: Record<string, string> = {};
    let body = '';
    return {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      end: (b: string) => { body = b; },
      get headers() { return headers; },
      get body() { return body; },
    };
  }

  it('writes the JSON shutdown ack with a JSON content-type', () => {
    const res = fakeRes();
    handleExitRequest(res, { scheduleExit: () => {}, log: () => {} });
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: true, message: 'Vite dev server shutting down' });
  });

  it('schedules the exit AFTER writing the response (flush-then-exit ordering)', () => {
    const res = fakeRes();
    const order: string[] = [];
    const tracked = {
      setHeader: res.setHeader,
      end: (b: string) => { order.push('end'); res.end(b); },
    };
    handleExitRequest(tracked, { scheduleExit: () => order.push('scheduleExit'), log: () => {} });
    expect(order).toEqual(['end', 'scheduleExit']);   // response flushed before exit is scheduled
  });

  it('invokes scheduleExit exactly once and logs the shutdown', () => {
    const res = fakeRes();
    const scheduleExit = vi.fn();
    const log = vi.fn();
    handleExitRequest(res, { scheduleExit, log });
    expect(scheduleExit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[asset-scanner] /api/exit received — shutting down.');
  });
});

describe('findAssetRoots (real project)', () => {
  it('discovers modoki assets directory', () => {
    const roots = findAssetRoots(PROJECT_ROOT);
    const modoki = roots.find(r => r.urlPrefix === '/modoki/assets');
    expect(modoki).toBeDefined();
    expect(modoki!.absDir.replace(/\\/g, '/')).toContain('packages/modoki/src/runtime/assets');
  });

  it.skipIf(!hasGames)('discovers game asset directories', () => {
    const roots = findAssetRoots(PROJECT_ROOT);
    const game3d = roots.find(r => r.urlPrefix === '/games/3d-test/assets');
    expect(game3d).toBeDefined();
    expect(game3d!.absDir.replace(/\\/g, '/')).toContain('games/3d-test/runtime/assets');
  });

  it.skipIf(!hasGames)('returns at least 2 roots (modoki + at least one game)', () => {
    const roots = findAssetRoots(PROJECT_ROOT);
    expect(roots.length).toBeGreaterThanOrEqual(2);
  });

  it('serves a flat one-game project\'s assets at /assets (no /games/<id>/ segment)', () => {
    // C4c flat convention: <projectRoot>/runtime/assets → /assets.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-flat-'));
    try {
      fs.mkdirSync(path.join(tmp, 'runtime/assets/scenes'), { recursive: true });
      const roots = findAssetRoots(tmp);
      const flat = roots.find(r => r.urlPrefix === '/assets');
      expect(flat).toBeDefined();
      expect(flat!.absDir).toBe(path.join(tmp, 'runtime/assets'));
      // A flat project has no /games/<id>/ roots.
      expect(roots.some(r => r.urlPrefix.startsWith('/games/'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('serves the editor\'s own engine assets for an external project (no engine/ of its own)', () => {
    // C4c: an external project folder has its own games/ but no
    // engine/packages/modoki — the editor's built-in fonts must still be served.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ext-'));
    try {
      fs.mkdirSync(path.join(tmp, 'games/hello/runtime/assets'), { recursive: true });
      const roots = findAssetRoots(tmp);
      const modoki = roots.find(r => r.urlPrefix === '/modoki/assets');
      expect(modoki).toBeDefined();
      // Falls back to the editor's OWN copy (this repo's), which really exists.
      expect(modoki!.absDir.replace(/\\/g, '/')).toContain('packages/modoki/src/runtime/assets');
      expect(fs.existsSync(modoki!.absDir)).toBe(true);
      // And the external project's game assets are still discovered.
      expect(roots.find(r => r.urlPrefix === '/games/hello/assets')).toBeDefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveModokiAssetsDir (fallback order)', () => {
  const REL = 'engine/packages/modoki/src/runtime/assets';
  // Build every candidate the SAME way the function does, so the `exists` mock and the
  // expected values match on Windows too (path.join → backslashes; candidate 3 is
  // path.resolve, which also stamps a drive letter). Passing a hand-built forward-slash
  // string for the editor candidate would never equal the path.join form on Windows.
  const proj = path.join('/proj', REL);
  const editor = path.join('/editor', REL);
  const cwd = path.resolve('/cwd', REL);

  it('prefers the open project\'s own engine/ when it exists (candidate 1)', () => {
    const exists = (d: string) => d === proj || d === editor || d === cwd; // all exist
    expect(resolveModokiAssetsDir('/proj', editor, '/cwd', exists)).toBe(proj);
  });

  it('falls back to the editor (import.meta) copy when the project has no engine/ (candidate 2)', () => {
    const exists = (d: string) => d === editor || d === cwd; // project's own missing
    expect(resolveModokiAssetsDir('/proj', editor, '/cwd', exists)).toBe(editor);
  });

  it('falls back to cwd/engine when BOTH project and the import.meta copy are missing (candidate 3 — the bundled-module fix)', () => {
    // This is the production case the fix targets: bundling breaks import.meta.url
    // so the editor candidate points at a non-existent dir; only cwd resolves.
    const exists = (d: string) => d === cwd;
    expect(resolveModokiAssetsDir('/proj', editor, '/cwd', exists)).toBe(cwd);
  });

  it('tolerates an undefined editor candidate (import.meta unresolved)', () => {
    const exists = (d: string) => d === cwd;
    expect(resolveModokiAssetsDir('/proj', undefined, '/cwd', exists)).toBe(cwd);
  });

  it('returns undefined when no candidate exists', () => {
    expect(resolveModokiAssetsDir('/proj', editor, '/cwd', () => false)).toBeUndefined();
  });
});

describe('findGamesEntry', () => {
  it('finds a flat single-game entry (game.ts)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-single-'));
    try {
      fs.writeFileSync(path.join(tmp, 'game.ts'), 'export const game = {};');
      const entry = findGamesEntry(tmp);
      expect(entry?.kind).toBe('single');
      expect(entry?.path).toBe(path.join(tmp, 'game.ts'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ignores a legacy games/registry.ts (one project = one game)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-reg-'));
    try {
      fs.mkdirSync(path.join(tmp, 'games'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'games/registry.ts'), 'export const ALL_GAMES = [];');
      // No game.ts at the root → no entry; the registry is no longer a convention.
      expect(findGamesEntry(tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when no game.ts exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-none-'));
    try {
      expect(findGamesEntry(tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveAssetPath', () => {
  const roots: AssetRoot[] = [
    { urlPrefix: '/modoki/assets', absDir: '/project/packages/modoki/src/runtime/assets' },
    { urlPrefix: '/games/3d-test/assets', absDir: '/project/games/3d-test/runtime/assets' },
  ];

  it('resolves a path within a known root', () => {
    const result = resolveAssetPath('/modoki/assets/textures/icon.png', roots);
    expect(result).toBe(path.resolve('/project/packages/modoki/src/runtime/assets', 'textures/icon.png'));
  });

  it('resolves game asset paths', () => {
    const result = resolveAssetPath('/games/3d-test/assets/models/island.glb', roots);
    expect(result).toBe(path.resolve('/project/games/3d-test/runtime/assets', 'models/island.glb'));
  });

  it('returns null for unknown prefixes', () => {
    const result = resolveAssetPath('/unknown/path/file.png', roots);
    expect(result).toBeNull();
  });

  it('returns null for path traversal attempts', () => {
    const result = resolveAssetPath('/modoki/assets/../../etc/passwd', roots);
    expect(result).toBeNull();
  });

  it('returns null for a sibling dir that shares the root prefix (regression)', () => {
    // The old guard used `absPath.startsWith(root.absDir)` without a separator,
    // so `<root>-evil` passed because it shares the textual prefix. `../assets-evil`
    // resolves to a sibling of the root and must be rejected.
    const siblingRoots: AssetRoot[] = [
      { urlPrefix: '/modoki/assets', absDir: '/project/assets' },
    ];
    expect(resolveAssetPath('/modoki/assets/../assets-evil/secret', siblingRoots)).toBeNull();
  });

  it('returns null for deep traversal that lands inside a prefix-sharing sibling', () => {
    expect(resolveAssetPath('/modoki/assets/sub/../../assets-evil/x', roots)).toBeNull();
  });

  it('still resolves a legitimate nested path containing .. that stays in-root', () => {
    // `a/b/../c` normalizes to `a/c`, which is inside the root — must NOT be rejected.
    const result = resolveAssetPath('/modoki/assets/a/b/../c.png', roots);
    expect(result).toBe(path.resolve('/project/packages/modoki/src/runtime/assets', 'a/c.png'));
  });

  it('handles URL-encoded paths', () => {
    const result = resolveAssetPath('/modoki/assets/my%20texture.png', roots);
    expect(result).toBe(path.resolve('/project/packages/modoki/src/runtime/assets', 'my texture.png'));
  });

  it('adds leading slash if missing', () => {
    const result = resolveAssetPath('modoki/assets/tex.png', roots);
    expect(result).toBe(path.resolve('/project/packages/modoki/src/runtime/assets', 'tex.png'));
  });
});

// ── GUID detection (readAssetGuid) + collision detection (buildManifest) ─────

describe('readAssetGuid', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-scanner-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads id from a top-level JSON asset (.mesh.json)', () => {
    const guid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    const p = path.join(tmpDir, 'foo.mesh.json');
    fs.writeFileSync(p, JSON.stringify({ id: guid, version: 1, model: '/x.glb', mesh: 'm' }));
    expect(readAssetGuid(p, 'mesh')).toBe(guid);
  });

  it('reads id from a top-level JSON asset (.mat.json)', () => {
    const guid = '11111111-2222-4333-8444-555555555555';
    const p = path.join(tmpDir, 'foo.mat.json');
    fs.writeFileSync(p, JSON.stringify({ id: guid, version: 1, color: 0xffffff }));
    expect(readAssetGuid(p, 'material')).toBe(guid);
  });

  it('reads id from a shader manifest (.shader.json)', () => {
    const guid = '7a3e9c1d-2b4f-4a6c-8d1e-5f9a0b2c3d4e';
    const p = path.join(tmpDir, 'foo.shader.json');
    fs.writeFileSync(p, JSON.stringify({ id: guid, name: 'Foo', params: {} }));
    expect(readAssetGuid(p, 'shader')).toBe(guid);
  });

  it('reads id from a top-level JSON asset (.particle.json)', () => {
    // Regression: particles are GUID-referenced like mesh/material/prefab/scene —
    // the GUID lives in-file as `id`, NOT in a sidecar. Before this, particles had
    // no GUID and were referenced by literal path, which broke on move/rename.
    const guid = '1cd1ed3b-4d9a-4b19-9e93-0ff54eb79e32';
    const p = path.join(tmpDir, 'confetti.particle.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1, id: guid, name: 'Confetti', maxParticles: 100 }));
    expect(readAssetGuid(p, 'particle')).toBe(guid);
  });

  it('returns undefined for a particle with no id (pre-migration)', () => {
    const p = path.join(tmpDir, 'legacy.particle.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1, name: 'Legacy', maxParticles: 100 }));
    expect(readAssetGuid(p, 'particle')).toBeUndefined();
  });

  it('reads id from a top-level JSON asset (.anim.json)', () => {
    // Regression: animation clips are GUID-referenced JSON like particles —
    // the GUID lives in-file as `id`, NOT in a sidecar. Reading a sidecar instead
    // minted a SECOND, competing GUID (auto-healed into a stray .meta.json) that
    // the runtime clip cache then evicted, breaking scene references to the clip.
    const guid = '7a3c9e10-2b4d-4f6a-8c1e-9d0f1a2b3c4d';
    const p = path.join(tmpDir, 'wiggle.anim.json');
    fs.writeFileSync(p, JSON.stringify({ id: guid, name: 'Wiggle', duration: 1, tracks: [] }));
    expect(readAssetGuid(p, 'animation')).toBe(guid);
  });

  it('reads id from a sidecar .meta.json for a binary asset', () => {
    const guid = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    const glbPath = path.join(tmpDir, 'model.glb');
    fs.writeFileSync(glbPath, 'pretend-glb');
    fs.writeFileSync(glbPath + '.meta.json', JSON.stringify({ id: guid, version: 2 }));
    expect(readAssetGuid(glbPath, 'model')).toBe(guid);
  });

  it('returns undefined when binary asset has no sidecar', () => {
    const glbPath = path.join(tmpDir, 'orphan.glb');
    fs.writeFileSync(glbPath, 'pretend-glb');
    expect(readAssetGuid(glbPath, 'model')).toBeUndefined();
  });

  it('returns undefined when the JSON has no id field (pre-migration)', () => {
    const p = path.join(tmpDir, 'legacy.mesh.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1, model: '/x.glb', mesh: 'm' }));
    expect(readAssetGuid(p, 'mesh')).toBeUndefined();
  });

  it('returns undefined when the JSON has a malformed id', () => {
    const p = path.join(tmpDir, 'bad.mesh.json');
    fs.writeFileSync(p, JSON.stringify({ id: 'not-a-guid', version: 1, model: '/x.glb', mesh: 'm' }));
    expect(readAssetGuid(p, 'mesh')).toBeUndefined();
  });

  it('returns undefined on unparseable JSON', () => {
    const p = path.join(tmpDir, 'broken.mesh.json');
    fs.writeFileSync(p, '{ not json');
    expect(readAssetGuid(p, 'mesh')).toBeUndefined();
  });
});

describe('buildManifest', () => {
  it('returns a v2 manifest containing the input assets', () => {
    const m = buildManifest([
      { guid: 'a1b2c3d4-e5f6-4789-9abc-def012345678', path: '/a.mesh.json', name: 'A', type: 'mesh' },
      { guid: '11111111-2222-4333-8444-555555555555', path: '/b.mat.json', name: 'B', type: 'material' },
    ]);
    expect(m.version).toBe(2);
    expect(m.assets).toHaveLength(2);
  });

  it('detects GUID collisions and logs both paths', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    buildManifest([
      { guid, path: '/a.mesh.json', name: 'A', type: 'mesh' },
      { guid, path: '/b.mesh.json', name: 'B', type: 'mesh' }, // same guid, different path
    ]);
    const collisionWarnings = spy.mock.calls.map(c => String(c[0] ?? '')).filter(s => s.includes('GUID collision'));
    expect(collisionWarnings.length).toBe(1);
    expect(collisionWarnings[0]).toContain('/a.mesh.json');
    expect(collisionWarnings[0]).toContain('/b.mesh.json');
    spy.mockRestore();
  });

  it('does NOT warn when the same path appears twice with the same guid (NFC vs NFD dedup)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    buildManifest([
      { guid, path: '/a.mesh.json', name: 'A', type: 'mesh' },
      { guid, path: '/a.mesh.json', name: 'A', type: 'mesh' },
    ]);
    const collisionWarnings = spy.mock.calls.map(c => String(c[0] ?? '')).filter(s => s.includes('GUID collision'));
    expect(collisionWarnings.length).toBe(0);
    spy.mockRestore();
  });

  it('ignores entries without a guid (legacy fonts/textures)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildManifest([
      { path: '/fonts/a.ttf', name: 'A', type: 'font' },
      { path: '/fonts/b.ttf', name: 'B', type: 'font' },
    ]);
    expect(spy.mock.calls.filter(c => String(c[0] ?? '').includes('GUID collision'))).toHaveLength(0);
    spy.mockRestore();
  });

  it('strips the internal absPath from serialized entries', () => {
    const guid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    const m = buildManifest([{ guid, path: '/a.mat.json', name: 'A', type: 'material', absPath: '/tmp/a.mat.json' }]);
    expect((m.assets[0] as Record<string, unknown>).absPath).toBeUndefined();
  });
});

describe('buildManifest auto-heal', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-heal-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("rewrites the later file's id in place when heal=true", () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    const aPath = path.join(tmpDir, 'a.mat.json');
    const bPath = path.join(tmpDir, 'b.mat.json');
    fs.writeFileSync(aPath, JSON.stringify({ id: guid, version: 1, color: 1 }));
    fs.writeFileSync(bPath, JSON.stringify({ id: guid, version: 1, color: 2 }));

    const m = buildManifest([
      { guid, path: '/a.mat.json', name: 'A', type: 'material', absPath: aPath },
      { guid, path: '/b.mat.json', name: 'B', type: 'material', absPath: bPath },
    ], true);

    // First file keeps the original id; second is regenerated on disk.
    expect(JSON.parse(fs.readFileSync(aPath, 'utf-8')).id).toBe(guid);
    const bId = JSON.parse(fs.readFileSync(bPath, 'utf-8')).id;
    expect(bId).not.toBe(guid);
    // The healed file kept its other fields intact.
    expect(JSON.parse(fs.readFileSync(bPath, 'utf-8')).color).toBe(2);
    // Manifest reflects the healed guid; entries no longer collide.
    expect(m.assets[1].guid).toBe(bId);
    expect(m.assets[0].guid).not.toBe(m.assets[1].guid);
    expect(spy.mock.calls.some(c => String(c[0]).includes('GUID collision healed'))).toBe(true);
    spy.mockRestore();
  });

  it('only warns (does not rewrite) when heal=false', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    const bPath = path.join(tmpDir, 'b.mat.json');
    fs.writeFileSync(bPath, JSON.stringify({ id: guid, version: 1 }));

    buildManifest([
      { guid, path: '/a.mat.json', name: 'A', type: 'material' },
      { guid, path: '/b.mat.json', name: 'B', type: 'material', absPath: bPath },
    ]); // heal defaults to false

    expect(JSON.parse(fs.readFileSync(bPath, 'utf-8')).id).toBe(guid); // unchanged
    expect(spy.mock.calls.some(c => String(c[0]).includes('GUID collision healed'))).toBe(false);
    expect(spy.mock.calls.some(c => /GUID collision:/.test(String(c[0])))).toBe(true);
    spy.mockRestore();
  });

  it('mints + persists a GUID for a binary asset that has none (heal=true)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A texture file with NO sidecar — e.g. moved into a folder, or extracted
    // without one. Without a guid it's undroppable onto a ref field (the runtime
    // rejects raw-path refs), so the dev scan must mint one.
    const texPath = path.join(tmpDir, 'MarsMap.jpg');
    fs.writeFileSync(texPath, 'JPGBYTES');
    expect(fs.existsSync(texPath + '.meta.json')).toBe(false);

    const m = buildManifest([
      { path: '/MarsMap.jpg', name: 'MarsMap', type: 'texture', absPath: texPath }, // no guid
    ], true);

    const minted = m.assets[0].guid;
    expect(minted).toMatch(/^[0-9a-f-]{36}$/i);
    // Persisted to a fresh sidecar so it survives restarts + matches the runtime.
    const sidecar = JSON.parse(fs.readFileSync(texPath + '.meta.json', 'utf-8'));
    expect(sidecar.id).toBe(minted);
    expect(spy.mock.calls.some(c => /minted missing GUID/.test(String(c[0])))).toBe(true);
    spy.mockRestore();
  });

  it('mints a missing GUID into a JSON asset in place (heal=true)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const matPath = path.join(tmpDir, 'noid.mat.json');
    fs.writeFileSync(matPath, JSON.stringify({ version: 1, color: 7 })); // no id

    const m = buildManifest([
      { path: '/noid.mat.json', name: 'noid', type: 'material', absPath: matPath },
    ], true);

    const json = JSON.parse(fs.readFileSync(matPath, 'utf-8'));
    expect(json.id).toBe(m.assets[0].guid);
    expect(json.color).toBe(7); // other fields preserved
    spy.mockRestore();
  });

  it('does NOT mint a GUID for fonts (they are referenced by CSS family, not GUID)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fontPath = path.join(tmpDir, 'Roboto-Regular.ttf');
    fs.writeFileSync(fontPath, 'TTFBYTES');
    const m = buildManifest([
      { path: '/Roboto-Regular.ttf', name: 'Roboto-Regular', type: 'font', absPath: fontPath },
    ], true);
    expect(m.assets[0].guid).toBeUndefined();
    expect(fs.existsSync(fontPath + '.meta.json')).toBe(false); // no churn for the ~140 bundled fonts
    spy.mockRestore();
  });

  it('does NOT mint missing GUIDs when heal=false (build-time scans stay read-only)', () => {
    const texPath = path.join(tmpDir, 'untouched.jpg');
    fs.writeFileSync(texPath, 'X');
    const m = buildManifest([
      { path: '/untouched.jpg', name: 'untouched', type: 'texture', absPath: texPath },
    ]); // heal defaults to false
    expect(m.assets[0].guid).toBeUndefined();
    expect(fs.existsSync(texPath + '.meta.json')).toBe(false);
  });

  it('keeps the GUID on the lexicographically-first path regardless of scan order', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    const aaa = path.join(tmpDir, 'aaa.mat.json');
    const zzz = path.join(tmpDir, 'zzz.mat.json');
    fs.writeFileSync(aaa, JSON.stringify({ id: guid, version: 1 }));
    fs.writeFileSync(zzz, JSON.stringify({ id: guid, version: 1 }));

    // Scan order deliberately lists the later path FIRST — selection must be by
    // path, not scan order (and not mtime, which git clone/checkout resets), so
    // /aaa keeps the id identically on every machine.
    const m = buildManifest([
      { guid, path: '/zzz.mat.json', name: 'Z', type: 'material', absPath: zzz },
      { guid, path: '/aaa.mat.json', name: 'A', type: 'material', absPath: aaa },
    ], true);

    expect(JSON.parse(fs.readFileSync(aaa, 'utf-8')).id).toBe(guid);          // first path kept
    expect(JSON.parse(fs.readFileSync(zzz, 'utf-8')).id).not.toBe(guid);       // copy regenerated
    expect(m.assets.find(a => a.path === '/aaa.mat.json')!.guid).toBe(guid);
    expect(m.assets.find(a => a.path === '/zzz.mat.json')!.guid).not.toBe(guid);
    spy.mockRestore();
  });
});

describe('writeAssetGuid', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-wg-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('replaces the id of a JSON asset, preserving other fields', () => {
    const p = path.join(tmpDir, 'm.mat.json');
    fs.writeFileSync(p, JSON.stringify({ id: 'old', version: 1, color: 7 }));
    const fresh = '11111111-2222-4333-8444-555555555555';
    expect(writeAssetGuid(p, 'material', fresh)).toBe(true);
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(j.id).toBe(fresh);
    expect(j.color).toBe(7);
  });

  it('writes the id in-file for a particle asset (not a sidecar), preserving fields', () => {
    const p = path.join(tmpDir, 'fx.particle.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1, name: 'FX', maxParticles: 42 }));
    const fresh = '11111111-2222-4333-8444-555555555555';
    expect(writeAssetGuid(p, 'particle', fresh)).toBe(true);
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(j.id).toBe(fresh);
    expect(j.maxParticles).toBe(42);
    expect(fs.existsSync(p + '.meta.json')).toBe(false); // GUID is in-file, no sidecar
  });

  it('writes the id in-file for an animation clip (not a sidecar), preserving fields', () => {
    const p = path.join(tmpDir, 'wiggle.anim.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1, name: 'Wiggle', duration: 2, tracks: [] }));
    const fresh = '11111111-2222-4333-8444-555555555555';
    expect(writeAssetGuid(p, 'animation', fresh)).toBe(true);
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(j.id).toBe(fresh);
    expect(j.duration).toBe(2);
    expect(fs.existsSync(p + '.meta.json')).toBe(false); // GUID is in-file, no sidecar
  });

  it('writes the id into a binary asset sidecar', () => {
    const glb = path.join(tmpDir, 'model.glb');
    fs.writeFileSync(glb, 'pretend-glb');
    const fresh = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    expect(writeAssetGuid(glb, 'model', fresh)).toBe(true);
    expect(JSON.parse(fs.readFileSync(glb + '.meta.json', 'utf-8')).id).toBe(fresh);
  });
});

// ── Sliced-sprite sub-entries (texture "multiple" mode) ──────────────────────
describe('scanAllAssets — sprite sub-entries from texture meta', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-sprites-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('emits one "sprite" entry per slice, pointing at the parent texture', () => {
    const texGuid = 'aaaaaaaa-1111-4111-8111-111111111111';
    const s0 = 'bbbbbbbb-2222-4222-8222-222222222222';
    const s1 = 'cccccccc-3333-4333-8333-333333333333';
    fs.writeFileSync(path.join(tmpDir, 'sheet.png'), 'pretend-png');
    fs.writeFileSync(path.join(tmpDir, 'sheet.png.meta.json'), JSON.stringify({
      id: texGuid, version: 2,
      spriteSheet: { width: 128, height: 64 },
      sprites: [
        { guid: s0, name: 'a', rect: { x: 0, y: 0, w: 64, h: 64 }, pivot: { x: 0.5, y: 0.5 } },
        { guid: s1, name: 'b', rect: { x: 64, y: 0, w: 64, h: 64 }, pivot: { x: 0, y: 1 } },
      ],
    }));

    const roots: AssetRoot[] = [{ urlPrefix: '/games/g/assets', absDir: tmpDir }];
    const assets = scanAllAssets(roots);

    const tex = assets.find((a) => a.guid === texGuid);
    expect(tex?.type).toBe('texture');

    const sprites = assets.filter((a) => a.type === 'sprite');
    expect(sprites).toHaveLength(2);
    const a = sprites.find((s) => s.guid === s0)!;
    expect(a.sprite?.texture).toBe(texGuid);
    expect(a.sprite?.rect).toEqual({ x: 0, y: 0, w: 64, h: 64 });
    expect(a.sprite?.sheetW).toBe(128);
    expect(a.sprite?.sheetH).toBe(64);
    // Synthetic path keeps each slice unique (no collision with the texture path).
    expect(a.path).toBe('/games/g/assets/sheet.png#' + s0);
    const b = sprites.find((s) => s.guid === s1)!;
    expect(b.sprite?.pivot).toEqual({ x: 0, y: 1 });
  });

  it('emits no sprite entries when the texture meta has none', () => {
    fs.writeFileSync(path.join(tmpDir, 'plain.png'), 'pretend-png');
    fs.writeFileSync(path.join(tmpDir, 'plain.png.meta.json'), JSON.stringify({
      id: 'dddddddd-4444-4444-8444-444444444444', version: 2,
    }));
    const assets = scanAllAssets([{ urlPrefix: '/games/g/assets', absDir: tmpDir }]);
    expect(assets.filter((a) => a.type === 'sprite')).toHaveLength(0);
  });

  it('emits an "atlas" entry carrying the built block from the sidecar', () => {
    const atlasGuid = 'eeeeeeee-5555-4555-8555-555555555555';
    const member = 'ffffffff-6666-4666-8666-666666666666';
    fs.writeFileSync(path.join(tmpDir, 'pack.atlas.json'), JSON.stringify({ id: atlasGuid, version: 1, members: [member], pageSize: 64, padding: 2, extrude: 1 }));
    fs.writeFileSync(path.join(tmpDir, 'pack.atlas.json.meta.json'), JSON.stringify({
      atlasCache: {
        hash: 'ah', texture: { format: 'webp', maxSize: 1024, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' },
        pages: [{ hash: 'p0', variants: ['webp'], w: 64, h: 64 }],
        frames: { [member]: { page: 0, rect: { x: 1, y: 1, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } } },
      },
    }));
    const assets = scanAllAssets([{ urlPrefix: '/games/g/assets', absDir: tmpDir }]);
    const atlas = assets.find((a) => a.guid === atlasGuid);
    expect(atlas?.type).toBe('atlas');
    expect(atlas?.atlas?.pages[0].hash).toBe('p0');
    expect(atlas?.atlas?.frames[member].rect).toEqual({ x: 1, y: 1, w: 32, h: 32 });
  });

  it('emits an atlas entry with no block when never packed (no sidecar)', () => {
    const atlasGuid = '99999999-7777-4777-8777-777777777777';
    fs.writeFileSync(path.join(tmpDir, 'fresh.atlas.json'), JSON.stringify({ id: atlasGuid, version: 1, members: [], pageSize: 64, padding: 2, extrude: 1 }));
    const assets = scanAllAssets([{ urlPrefix: '/games/g/assets', absDir: tmpDir }]);
    const atlas = assets.find((a) => a.guid === atlasGuid);
    expect(atlas?.type).toBe('atlas');
    expect(atlas?.atlas).toBeUndefined();
  });
});

// ── Empty-folder visibility ──────────────────────────────────────────────────
describe('scanAllAssets / buildManifest — empty folders', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-emptydir-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('emits a guid-less "folder" entry for a dir with no file assets, but not for one with files', () => {
    fs.mkdirSync(path.join(tmpDir, 'prefabs'), { recursive: true });            // empty → visible
    fs.mkdirSync(path.join(tmpDir, 'meshes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'meshes/a.mesh.json'), JSON.stringify({ id: 'aaaaaaaa-1111-4111-8111-111111111111', model: '/x.glb', mesh: 'm' }));

    const assets = scanAllAssets([{ urlPrefix: '/games/g/assets', absDir: tmpDir }]);
    const folders = assets.filter((a) => a.type === 'folder');
    expect(folders.map((f) => f.path)).toEqual(['/games/g/assets/prefabs']); // meshes has a file → not a folder entry
    expect(folders[0].guid).toBeUndefined();
    expect(folders[0].name).toBe('prefabs');
  });

  it('emits a folder entry for nested empty dirs (whole empty chain)', () => {
    fs.mkdirSync(path.join(tmpDir, 'a/b/c'), { recursive: true });
    const folders = scanAllAssets([{ urlPrefix: '/g/assets', absDir: tmpDir }]).filter((a) => a.type === 'folder').map((f) => f.path).sort();
    expect(folders).toEqual(['/g/assets/a', '/g/assets/a/b', '/g/assets/a/b/c']);
  });

  it('buildManifest moves folder entries into a separate `folders` list (assets stays files-only)', () => {
    fs.mkdirSync(path.join(tmpDir, 'prefabs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'm.mat.json'), JSON.stringify({ id: 'bbbbbbbb-2222-4222-8222-222222222222', color: 0xffffff }));
    const assets = scanAllAssets([{ urlPrefix: '/g/assets', absDir: tmpDir }]);
    const manifest = buildManifest(assets);
    expect(manifest.folders).toEqual(['/g/assets/prefabs']);
    expect(manifest.assets.every((a) => a.type !== 'folder')).toBe(true);
    expect(manifest.assets.some((a) => a.type === 'material')).toBe(true);
  });
});

describe('filterKeptAssets — sprite slices follow their parent texture (deploy fix)', () => {
  // A texture's sprite slices are separate 'sprite' entries with synthetic `<texture>#<guid>`
  // paths that the tree-shaker keep-set never lists. They must survive iff the parent texture
  // does, else a sprite-sheet resolves to nothing in the deployed build.
  const mk = (path: string, type: string) => ({ path, type, name: 'x' } as never);
  const assets = [
    mk('/assets/sprites/boy.png', 'texture'),
    mk('/assets/sprites/boy.png#s1', 'sprite'),
    mk('/assets/sprites/boy.png#s2', 'sprite'),
    mk('/assets/sprites/unused.png', 'texture'),
    mk('/assets/sprites/unused.png#s9', 'sprite'),
    mk('/assets/scenes/main.json', 'scene'),
  ];

  it('keeps every slice of a kept texture, drops slices of a shaken-out texture', () => {
    const keep = new Set(['/assets/sprites/boy.png', '/assets/scenes/main.json']); // 'boy' survived
    const kept = filterKeptAssets(assets, keep).map((a) => a.path);
    expect(kept).toContain('/assets/sprites/boy.png');
    expect(kept).toContain('/assets/sprites/boy.png#s1');   // slice kept with its parent
    expect(kept).toContain('/assets/sprites/boy.png#s2');
    expect(kept).toContain('/assets/scenes/main.json');
    expect(kept).not.toContain('/assets/sprites/unused.png');    // texture dropped
    expect(kept).not.toContain('/assets/sprites/unused.png#s9'); // → its slice dropped too
  });
});

/**
 * C7 — an .anim.json edit must reach the renderer so it can drop the cached clip.
 *
 * `invalidateAnimationClip` was exported, unit-tested, and had ZERO production callers, so
 * the renderer's clip cache held the pre-edit clip forever. A read-modify-write tool
 * (anim_add_key) then re-read the STALE clip and wrote it back — silently REVERTING whatever
 * had just been written. Both watchers (Vite's ws in dev, Electron's chokidar→IPC when
 * packaged) classify through this one function, so it is where the fix has to hold.
 */
describe('classifySceneChange — animation (C7)', () => {
  it('classifies an .anim.json as animation, so the clip cache gets invalidated', () => {
    expect(classifySceneChange('/games/x/assets/anim/run.anim.json')).toBe('animation');
  });

  it('does NOT need a /scenes/ dir (unlike scenes) — clips live anywhere', () => {
    expect(classifySceneChange('/anywhere/foo.anim.json')).toBe('animation');
  });

  it('still classifies scenes and prefabs as before', () => {
    expect(classifySceneChange('/games/x/assets/scenes/main.json')).toBe('scene');
    expect(classifySceneChange('/games/x/assets/prefabs/tree.prefab.json')).toBe('prefab');
  });

  it('does not mistake a sibling animation-ish asset for a clip', () => {
    // .animset.json / .spriteanim.json are different types with their own caches — a wrong
    // 'animation' here would invalidate a clip that was never loaded (harmless) but a wrong
    // 'scene' would bounce the live world.
    expect(classifySceneChange('/games/x/assets/anim/hero.animset.json')).not.toBe('scene');
    expect(classifySceneChange('/games/x/assets/anim/hero.spriteanim.json')).not.toBe('scene');
  });
});

/**
 * BOTH watchers must classify through ONE function.
 *
 * The C7 clip-cache fix taught `classifySceneChange` about '.anim.json' — and was DEAD in the
 * Electron editor (dev AND packaged, i.e. every surface the modoki MCP targets), because
 * engine/electron/assetBackend.ts had DUPLICATED the classification inline ("same logic as
 * the Vite plugin") instead of calling it. It worked in a browser and silently did nothing
 * where it mattered. Duplicated logic rots; one function cannot.
 */
describe('the Electron watcher must not re-implement classifySceneChange', () => {
  const src = fsSync.readFileSync(
    pathMod.join(__dirname, '..', '..', 'electron', 'assetBackend.ts'), 'utf8',
  );
  const code = src.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');

  it('calls the shared classifier', () => {
    expect(code).toMatch(/classifySceneChange\(/);
  });

  it('does NOT hand-roll the scene/prefab/animation decision', () => {
    // The duplicated form was: detectType(rel,'.json') then `if (type === 'prefab') …`.
    expect(code).not.toMatch(/type === 'prefab'/);
    expect(code).not.toMatch(/rel\.includes\('\/scenes\/'\)/);
  });
});
