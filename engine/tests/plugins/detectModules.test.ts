import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectModules, resolveModules, MODULE_KEYS } from '../../plugins/detect-modules';
import { DEFAULT_PROJECT_CONFIG, mergeProjectConfig, type ProjectConfig } from '../../project-config';

const cleanup: string[] = [];
afterEach(() => {
  for (const r of cleanup.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Scaffold a throwaway project with the given scene files under runtime/assets/scenes. */
function makeProject(scenes: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-detect-'));
  cleanup.push(root);
  const dir = path.join(root, 'runtime', 'assets', 'scenes');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, json] of Object.entries(scenes)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(json));
  }
  return root;
}

const ent = (traits: Record<string, unknown>) => ({ traits });

describe('detectModules', () => {
  it('detects a 3D + Rapier3D scene (sling-like)', () => {
    const root = makeProject({
      'main.json': {
        entities: [
          ent({ Renderable3D: {}, EntityAttributes: { layer: '3d' } }),
          ent({ RigidBody3D: {}, Collider3D: {} }),
          ent({ Environment: {} }),
        ],
      },
    });
    const { used, scenesScanned } = detectModules(root);
    expect(scenesScanned).toBe(1);
    expect(used.render3d).toBe(true);
    expect(used.physics3d).toBe(true);
    expect(used.render2d).toBe(false);
    expect(used.physics2d).toBe(false);
    // Sub-features conservatively follow render3d until finer detection lands.
    expect(used.npr).toBe(true);
    expect(used.gpuParticles).toBe(true);
  });

  it('detects a pure-2D + Rapier2D scene', () => {
    const root = makeProject({
      's.json': {
        entities: [
          ent({ Renderable2D: {}, EntityAttributes: { layer: '2d' } }),
          ent({ RigidBody2D: {}, Collider2D: {} }),
        ],
      },
    });
    const { used } = detectModules(root);
    expect(used.render2d).toBe(true);
    expect(used.physics2d).toBe(true);
    expect(used.render3d).toBe(false);
    expect(used.physics3d).toBe(false);
    expect(used.npr).toBe(false);
    expect(used.gpuParticles).toBe(false);
  });

  it('scans multiple scenes and unions their modules', () => {
    const root = makeProject({
      'a.json': { entities: [ent({ Renderable3D: {} })] },
      'b.json': { entities: [ent({ RigidBody2D: {} })] },
    });
    const { used, scenesScanned } = detectModules(root);
    expect(scenesScanned).toBe(2);
    expect(used.render3d).toBe(true);
    expect(used.physics2d).toBe(true);
  });

  it('ignores .meta.json and tolerates malformed scenes', () => {
    const root = makeProject({ 'main.json': { entities: [ent({ Renderable3D: {} })] } });
    const scenesDir = path.join(root, 'runtime', 'assets', 'scenes');
    fs.writeFileSync(path.join(scenesDir, 'broken.json'), '{ not valid json');
    // A physics-2D signal ONLY in a .meta.json must be ignored (metas aren't scenes).
    fs.writeFileSync(path.join(scenesDir, 'main.meta.json'), JSON.stringify({ entities: [ent({ RigidBody2D: {} })] }));
    const { used, scenesScanned } = detectModules(root);
    expect(scenesScanned).toBe(2); // main.json + broken.json; .meta.json excluded
    expect(used.render3d).toBe(true);
    expect(used.physics2d).toBe(false);
  });

  it('empty project → nothing used', () => {
    const root = makeProject({});
    const { used, scenesScanned } = detectModules(root);
    expect(scenesScanned).toBe(0);
    expect(MODULE_KEYS.every((k) => used[k] === false)).toBe(true);
  });

  it('Zone2D/Zone3D are physics-free (do not pull in Rapier)', () => {
    const root = makeProject({
      'main.json': { entities: [ent({ Zone2D: {} }), ent({ Zone3D: {} }), ent({ Renderable3D: {} })] },
    });
    const { used } = detectModules(root);
    expect(used.physics2d).toBe(false);
    expect(used.physics3d).toBe(false);
    expect(used.render3d).toBe(true);
  });

  it('does not false-match a project cloned under a "scenes" ancestor dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-detect-'));
    cleanup.push(base);
    const projectRoot = path.join(base, 'scenes', 'mygame'); // ancestor segment named "scenes"
    const sceneDir = path.join(projectRoot, 'runtime', 'assets', 'scenes');
    const prefabDir = path.join(projectRoot, 'runtime', 'assets', 'prefabs');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.mkdirSync(prefabDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'main.json'), JSON.stringify({ entities: [ent({ Renderable3D: {} })] }));
    // a prefab (NOT under scenes/) with a physics trait must be ignored
    fs.writeFileSync(path.join(prefabDir, 'p.json'), JSON.stringify({ entities: [ent({ RigidBody2D: {} })] }));
    const { used, scenesScanned } = detectModules(projectRoot);
    expect(scenesScanned).toBe(1);
    expect(used.render3d).toBe(true);
    expect(used.physics2d).toBe(false);
  });
});

describe('resolveModules', () => {
  it('null projectRoot (editor/dev build) → all modules on', () => {
    const flags = resolveModules(DEFAULT_PROJECT_CONFIG.build.modules, null);
    expect(MODULE_KEYS.every((k) => flags[k] === true)).toBe(true);
  });

  it("'auto' follows detection; explicit true/false override it", () => {
    const root = makeProject({ 'main.json': { entities: [ent({ Renderable3D: {}, EntityAttributes: { layer: '3d' } })] } });
    const flags = resolveModules(
      { ...DEFAULT_PROJECT_CONFIG.build.modules, render2d: true, render3d: false },
      root,
    );
    expect(flags.render3d).toBe(false); // forced off despite being detected
    expect(flags.render2d).toBe(true); // forced on despite no 2D content
    expect(flags.physics3d).toBe(false); // auto + not detected
  });

  it('warns when a module is forced OFF but detected in use', () => {
    const root = makeProject({ 'main.json': { entities: [ent({ Renderable3D: {}, EntityAttributes: { layer: '3d' } })] } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveModules({ ...DEFAULT_PROJECT_CONFIG.build.modules, render3d: false }, root);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('render3d'));
  });

  it('does NOT warn when a forced-off module is genuinely unused', () => {
    const root = makeProject({ 'main.json': { entities: [ent({ Renderable3D: {} })] } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveModules({ ...DEFAULT_PROJECT_CONFIG.build.modules, physics2d: false }, root);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('mergeProjectConfig — build.modules', () => {
  it('defaults to all auto', () => {
    const cfg = mergeProjectConfig(null);
    expect(cfg.build.modules).toEqual({
      render3d: 'auto', render2d: 'auto', physics2d: 'auto',
      physics3d: 'auto', npr: 'auto', gpuParticles: 'auto',
    });
  });

  it('nested-merges a partial modules override (siblings keep defaults)', () => {
    const partial = { build: { modules: { render3d: false } } } as unknown as Partial<ProjectConfig>;
    const cfg = mergeProjectConfig(partial);
    expect(cfg.build.modules.render3d).toBe(false);
    expect(cfg.build.modules.render2d).toBe('auto');
    expect(cfg.build.modules.physics3d).toBe('auto');
    // sibling build fields survive the partial too
    expect(cfg.build.debugBuild).toBe(false);
  });
});
