/** Router-level tests for `GET /api/build-modules` (docs/playable-export.md, "Engine module
 *  toggles") — resolves `build.modules` for the OPEN project so the running editor can tell
 *  whether it actually renders 3D (the fact `resolveModules`'s 'auto' branch can only answer via
 *  a Node-only filesystem scan). Kept thin: `engine/tests/plugins/detectModules.test.ts` already
 *  covers `resolveModules`/`detectModules` themselves — this only checks the route wiring. */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

const cleanup: string[] = [];
afterEach(() => { for (const r of cleanup.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const ent = (traits: Record<string, unknown>) => ({ traits });

/** Scaffold a throwaway project: an optional project.config.json (build.modules) plus scene
 *  files under runtime/assets/scenes — mirrors detectModules.test.ts's own fixture shape. */
function makeProject(opts: { buildModules?: Record<string, unknown>; scenes?: Record<string, unknown> }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-buildmod-'));
  cleanup.push(root);
  if (opts.buildModules) {
    fs.writeFileSync(
      path.join(root, 'project.config.json'),
      JSON.stringify({ build: { modules: opts.buildModules } }),
    );
  }
  if (opts.scenes) {
    const dir = path.join(root, 'runtime', 'assets', 'scenes');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, json] of Object.entries(opts.scenes)) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(json));
    }
  }
  return root;
}

function makeCtx(projectRoot: string): BackendContext {
  return {
    projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: () => null,
    firstRootDir: () => null,
  } as unknown as BackendContext;
}

const getBuildModules = (projectRoot: string) =>
  handleBackendRequest(makeCtx(projectRoot), { method: 'GET', urlPath: '/api/build-modules', query: new URLSearchParams(), body: undefined });

describe('GET /api/build-modules', () => {
  it('reports an explicit `false` toggle as-is (games/space-invader\'s shape)', async () => {
    const root = makeProject({ buildModules: { render3d: false } });
    const r = (await getBuildModules(root)) as { body: { modules: Record<string, boolean> } };
    expect(r.body.modules.render3d).toBe(false);
  });

  it('resolves `render3d: "auto"` to true when a scene has 3D signals (court\'s shape)', async () => {
    const root = makeProject({
      buildModules: { render3d: 'auto' },
      scenes: { 'main.json': { entities: [ent({ Renderable3D: {}, Camera: {}, Environment: {} })] } },
    });
    const r = (await getBuildModules(root)) as { body: { modules: Record<string, boolean> } };
    expect(r.body.modules.render3d).toBe(true);
  });

  it('resolves `render3d: "auto"` to false when scenes are 2D-only', async () => {
    const root = makeProject({
      buildModules: { render3d: 'auto' },
      scenes: { 'main.json': { entities: [ent({ Renderable2D: {}, EntityAttributes: { layer: '2d' } })] } },
    });
    const r = (await getBuildModules(root)) as { body: { modules: Record<string, boolean> } };
    expect(r.body.modules.render3d).toBe(false);
  });

  it('defaults to "auto" (→ true, no scenes) when project.config.json is absent entirely', async () => {
    const root = makeProject({});
    const r = (await getBuildModules(root)) as { body: { modules: Record<string, boolean> } };
    // No scene files at all → detectModules finds no 3D signal → 'auto' resolves false, not true.
    // This pins the "no false-positive on an empty project" behavior of resolveModules itself,
    // distinct from the vite.config.ts editor-build define (which is unconditionally all-true).
    expect(r.body.modules.render3d).toBe(false);
  });

  it('passes the REAL projectRoot, not null (regression guard against the vite.config.ts all-true default)', async () => {
    // resolveModules(modules, null) returns all-true unconditionally (the same shortcut
    // vite.config.ts relies on for an editor/dev build) — if the route ever regressed to
    // passing `null` here instead of ctx.projectRoot, this 2D-only project would wrongly
    // resolve render3d: true.
    const root = makeProject({
      buildModules: { render3d: 'auto' },
      scenes: { 'main.json': { entities: [ent({ Renderable2D: {} })] } },
    });
    const r = (await getBuildModules(root)) as { body: { modules: Record<string, boolean> } };
    expect(r.body.modules.render3d).toBe(false);
  });
});
